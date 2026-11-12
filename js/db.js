// IndexedDB: одна база, по сховищу на кожну сутність, ключ — поле id.
// Кожен запис має updated (мс), видалення лишають надгробок у tombstones —
// це потрібно, щоб синхронізація з Google Диском зливала зміни без втрат.
// Файли фото лежать окремо в blobs: вони не входять у JSON синхронізації й резервної копії.
const DB_NAME = 'fpv-log';
// 2 — сховище flights (0.1.5); нові сховища створює onupgradeneeded, наявні дані не чіпає
const DB_VERSION = 2;
export const STORES = ['drones', 'items', 'orders', 'batteries', 'flights', 'photos', 'prefs'];
// prefs — налаштування, спільні для всіх пристроїв (їде з Диском і копією), але не дані: порожня база з ними все одно порожня
export const DATA_STORES = STORES.filter((s) => s !== 'prefs');
const ALL = [...STORES, 'tombstones'];
const BLOBS = 'blobs';

let opening;

function open() {
  // Невдале відкриття не запам'ятовуємо: наступний запит (чи «Спробувати ще раз») відкриває заново
  opening ??= new Promise((resolve, reject) => {
    const req = indexedDB.open(DB_NAME, DB_VERSION);
    req.onupgradeneeded = () => {
      const db = req.result;
      for (const name of [...ALL, BLOBS]) {
        if (!db.objectStoreNames.contains(name)) db.createObjectStore(name, { keyPath: 'id' });
      }
    };
    // Нову версію бази відкрили в іншій вкладці — віддаємо з'єднання, інакше там оновлення зависне
    req.onsuccess = () => {
      req.result.onversionchange = () => { req.result.close(); location.reload(); };
      // Браузер сам закрив з'єднання (iOS після сну, очищення сховища) — наступний запис відкриє нове
      req.result.onclose = () => { opening = undefined; };
      resolve(req.result);
    };
    req.onerror = () => reject(req.error);
    // Стара вкладка тримає попередню версію (без обробника вище) — без підказки застосунок мовчки порожній
    req.onblocked = () => window.dispatchEvent(new Event('db-blocked'));
  }).catch((err) => {
    opening = undefined;
    throw err;
  });
  return opening;
}

async function run(stores, mode, fn) {
  const db = await open();
  return new Promise((resolve, reject) => {
    const tx = db.transaction(stores, mode);
    let out;
    // Запис, що впав одразу (битий id у копії), інакше лишив би транзакцію напівзробленою: вона закомітилась би сама
    try {
      out = fn(tx);
    } catch (err) {
      try { tx.abort(); } catch { /* уже завершена */ }
      reject(err);
      return;
    }
    tx.oncomplete = () => resolve(out);
    tx.onerror = () => reject(tx.error);
    tx.onabort = () => reject(tx.error);
  });
}

export function uid() {
  return crypto.randomUUID?.() ?? `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`;
}

export async function loadAll() {
  const state = {};
  await run(ALL, 'readonly', (tx) => {
    for (const name of ALL) {
      const req = tx.objectStore(name).getAll();
      req.onsuccess = () => { state[name] = req.result; };
    }
  });
  return state;
}

/**
 * changes: { store: { put: [obj], del: [id] }, blobs?: { put: [{ id, blob }], del: [id] } } —
 * усе в одній транзакції, з відміткою часу.
 */
export async function write(changes) {
  const names = Object.keys(changes).filter((n) => STORES.includes(n));
  const blobs = changes[BLOBS];
  const now = Date.now();
  await run([...names, 'tombstones', ...(blobs ? [BLOBS] : [])], 'readwrite', (tx) => {
    const graves = tx.objectStore('tombstones');
    for (const name of names) {
      const store = tx.objectStore(name);
      // Правка новіша за те, що правили, навіть коли годинник іншого пристрою поспішав: інакше синхронізація її відкинула б
      for (const obj of changes[name].put ?? []) store.put({ ...obj, updated: Math.max(now, stamp(obj) + 1) });
      for (const id of changes[name].del ?? []) {
        store.get(id).onsuccess = (e) => {
          graves.put({ id, store: name, updated: Math.max(now, stamp(e.target.result) + 1) });
          store.delete(id);
        };
      }
    }
    if (blobs) {
      const store = tx.objectStore(BLOBS);
      for (const obj of blobs.put ?? []) store.put(obj);
      for (const id of blobs.del ?? []) store.delete(id);
    }
  });
  window.dispatchEvent(new Event('db-change'));
}

/** Доповнити запис полями, лише якщо він ще існує. Повертає true, якщо записано. */
export function patch(name, id, fields) {
  return run([name], 'readwrite', (tx) => {
    const result = { ok: false };
    const store = tx.objectStore(name);
    store.get(id).onsuccess = (e) => {
      if (!e.target.result) return;
      store.put({ ...e.target.result, ...fields, updated: Math.max(Date.now(), stamp(e.target.result) + 1) });
      result.ok = true;
    };
    return result;
  }).then((r) => r.ok);
}

const stamp = (x) => Number(x?.updated) || 0;

/**
 * Результат злиття з Диска: { store: { put: [obj], del: [{ id, updated }] } }.
 * Нічого не перезаписує, якщо локальний запис встиг змінитися пізніше.
 */
export function writeMerged(changes) {
  const names = Object.keys(changes).filter((n) => ALL.includes(n));
  return run(names, 'readwrite', (tx) => {
    for (const name of names) {
      const store = tx.objectStore(name);
      for (const obj of changes[name].put ?? []) {
        store.get(obj.id).onsuccess = (e) => { if (stamp(e.target.result) <= stamp(obj)) store.put(obj); };
      }
      for (const grave of changes[name].del ?? []) {
        store.get(grave.id).onsuccess = (e) => { if (e.target.result && stamp(e.target.result) <= stamp(grave)) store.delete(grave.id); };
      }
    }
  });
}

/**
 * «Об’єднати» з резервної копії: запис із файлу лягає, лише якщо він новіший за локальний
 * і за надгробок — стара копія не відкочує пізніші правки й не воскрешає видалене.
 */
export async function mergeImport(changes) {
  const names = Object.keys(changes).filter((n) => STORES.includes(n));
  await run([...names, 'tombstones'], 'readwrite', (tx) => {
    const graves = tx.objectStore('tombstones');
    for (const name of names) {
      const store = tx.objectStore(name);
      for (const obj of changes[name].put ?? []) {
        store.get(obj.id).onsuccess = (e) => {
          const mine = e.target.result;
          if (mine) {
            if (stamp(mine) < stamp(obj)) store.put(obj);
            return;
          }
          graves.get(obj.id).onsuccess = (g) => { if (!g.target.result || stamp(g.target.result) < stamp(obj)) store.put(obj); };
        };
      }
    }
  });
  window.dispatchEvent(new Event('db-change'));
}

export async function getBlob(id) {
  return run([BLOBS], 'readonly', (tx) => {
    const out = {};
    tx.objectStore(BLOBS).get(id).onsuccess = (e) => { out.blob = e.target.result?.blob ?? null; };
    return out;
  }).then((r) => r.blob);
}

export function putBlob(id, blob) {
  return run([BLOBS], 'readwrite', (tx) => { tx.objectStore(BLOBS).put({ id, blob }); });
}

export function blobKeys() {
  return run([BLOBS], 'readonly', (tx) => {
    const out = { keys: [] };
    tx.objectStore(BLOBS).getAllKeys().onsuccess = (e) => { out.keys = e.target.result; };
    return out;
  }).then((r) => r.keys);
}

/**
 * Прибрати файли фото, для яких уже немає запису (видалені на іншому пристрої).
 * Записи читаються в тій самій транзакції — фото, додане під час синхронізації, не зачепить.
 */
export function dropOrphanBlobs() {
  return run(['photos', BLOBS], 'readwrite', (tx) => {
    tx.objectStore('photos').getAllKeys().onsuccess = (e) => {
      const keep = new Set(e.target.result);
      const blobs = tx.objectStore(BLOBS);
      blobs.getAllKeys().onsuccess = (ev) => {
        for (const id of ev.target.result) if (!keep.has(id)) blobs.delete(id);
      };
    };
  });
}

export function get(name, id) {
  return run([name], 'readonly', (tx) => {
    const out = {};
    tx.objectStore(name).get(id).onsuccess = (e) => { out.rec = e.target.result ?? null; };
    return out;
  }).then((r) => r.rec);
}

/**
 * «Замінити все»: лишаються тільки записи з копії, усі з однією відміткою часу — її й повертає
 * (за нею синхронізація відрізняє відновлене від старого). Файли фото не стирає: ті, що є в копії,
 * не доведеться качати з Диска, а фото без Диска не пропадуть; сиріт прибирає dropOrphanBlobs.
 */
export async function replaceAll(changes) {
  const now = Date.now();
  await run(ALL, 'readwrite', (tx) => {
    for (const name of ALL) {
      const store = tx.objectStore(name);
      store.clear();
      for (const obj of changes[name]?.put ?? []) store.put({ ...obj, updated: now });
    }
  });
  await dropOrphanBlobs();
  window.dispatchEvent(new Event('db-change'));
  return now;
}

export async function clearAll() {
  await run([...ALL, BLOBS], 'readwrite', (tx) => {
    for (const name of [...ALL, BLOBS]) tx.objectStore(name).clear();
  });
}
