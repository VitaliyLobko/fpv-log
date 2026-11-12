// Синхронізація з файлом fpv-log.json на Google Диску власника.
// Офлайн-перший підхід: усе пишеться в IndexedDB, а сюди потрапляє, коли є мережа.
// Злиття — по id: перемагає запис з пізнішим updated, надгробок перемагає старіший запис.
import * as db from './db.js';
import { GOOGLE_CLIENT_ID } from './config.js';
import { t } from './i18n.js';
import { sharedToken, shareToken, dropSharedToken, noteEmail } from './google-token.js';

const SCOPE = 'https://www.googleapis.com/auth/drive.file';
const FILE_NAME = 'fpv-log.json';
const DRIVE = 'https://www.googleapis.com/drive/v3';
const UPLOAD = 'https://www.googleapis.com/upload/drive/v3';
const KEY = 'fpv-log:sync';
const PHOTO_PREFIX = 'fpv-log-photo-';
// Усі файли застосунку — в одній папці на Диску, а не в корені
const FOLDER_NAME = 'FPV Log';
const FOLDER_MIME = 'application/vnd.google-apps.folder';
const TIDY_EVERY = 24 * 3600_000;   // стара версія на іншому пристрої ще кладе файли в корінь — підбираємо раз на добу

class AuthError extends Error {}

class ApiError extends Error {
  constructor(status) {
    super(t('Google Диск відповів {n}', { n: status }));
    this.status = status;
  }
}

let conf = load();
let tokenClient = null;
let gisLoading = null;
let authWaiter = null;
let timer = null;
let running = false;
let again = false;
const listeners = new Set();

/** state: unconfigured | off | idle | syncing | offline | auth | error */
export const status = { state: 'off', message: '' };

function load() {
  try { return JSON.parse(localStorage.getItem(KEY)) ?? {}; } catch { return {}; }
}

function save() {
  try { localStorage.setItem(KEY, JSON.stringify(conf)); } catch { /* приватний режим */ }
}

function set(state, message = '') {
  Object.assign(status, { state, message, lastSync: conf.lastSync ?? null, email: conf.email ?? null, photo: conf.photo ?? null, who: conf.who ?? null });
  listeners.forEach((fn) => fn(status));
}

export function onStatus(fn) {
  listeners.add(fn);
  fn(status);
}

export const configured = () => Boolean(GOOGLE_CLIENT_ID);
export const enabled = () => Boolean(conf.enabled);
/** Свій ключ живий — його; ні — спільний з іншого застосунку автора (вхід там годиться й тут). */
function tokenValid() {
  if (conf.token && conf.expires > Date.now() + 60_000) return true;
  const s = sharedToken(conf);
  if (!s) return false;
  conf.token = s.token;
  conf.expires = s.expires;
  save();
  return true;
}

// ---------- вхід ----------

function loadGis() {
  gisLoading ??= new Promise((resolve, reject) => {
    if (window.google?.accounts?.oauth2) { resolve(); return; }
    const script = document.createElement('script');
    script.src = 'https://accounts.google.com/gsi/client';
    script.async = true;
    script.onload = () => resolve();
    script.onerror = () => { gisLoading = null; reject(new Error(t('Немає зв’язку з Google'))); };
    document.head.append(script);
  });
  return gisLoading;
}

function finishAuth(error) {
  const waiter = authWaiter;
  authWaiter = null;
  if (error) waiter?.reject(error);
  else waiter?.resolve();
}

function client() {
  if (tokenClient || !window.google?.accounts?.oauth2) return tokenClient;
  tokenClient = window.google.accounts.oauth2.initTokenClient({
    client_id: GOOGLE_CLIENT_ID,
    scope: SCOPE,
    callback: (resp) => {
      if (resp.error) { finishAuth(new Error(resp.error_description || resp.error)); return; }
      conf.token = resp.access_token;
      conf.expires = Date.now() + (Number(resp.expires_in) || 3600) * 1000;
      shareToken(conf.token, conf.expires, conf.email);
      save();
      finishAuth();
    },
    error_callback: (err) => finishAuth(new Error(err?.type === 'popup_closed' ? t('Вхід скасовано') : (err?.message || t('Помилка входу в Google')))),
  });
  return tokenClient;
}

/** Підвантажити Google Sign-In заздалегідь: вікно входу має відкритися синхронно з тапу. */
export function preload() {
  if (configured() && navigator.onLine) loadGis().then(client).catch(() => {});
}

/** Викликати лише з обробника тапу/кліку — інакше браузер заблокує вікно входу. */
export async function connect() {
  // Увійшли в іншому застосунку автора менш ніж годину тому — вікно Google не потрібне
  if (!tokenValid()) {
    const c = client();
    if (!c) {
      preload();
      throw new Error(t('Google ще завантажується — натисніть ще раз за секунду'));
    }
    await new Promise((resolve, reject) => {
      authWaiter = { resolve, reject };
      c.requestAccessToken({ prompt: conf.consented ? '' : 'consent', hint: conf.email || undefined });
    });
  }
  conf.enabled = true;
  conf.consented = true;
  save();
  await syncNow();
}

let lastRefresh = 0;

/**
 * Ключ Диска діє годину, у фоні його не продовжити. Тож оновлюємо його з натискання, яке людина й так
 * зробила, — збереження запису: вікно Google мелькає й закривається само (згоду вже дано).
 * Браузер дозволяє вікно лише кілька секунд після натискання — без активного жесту не пробуємо.
 */
function refreshOnSave() {
  if (!conf.enabled || !conf.consented || tokenValid() || authWaiter || !navigator.onLine) return;
  if (navigator.userActivation && !navigator.userActivation.isActive) return;
  if (Date.now() - lastRefresh < 60_000) return;
  const c = client();
  if (!c) { preload(); return; }
  lastRefresh = Date.now();
  new Promise((resolve, reject) => {
    authWaiter = { resolve, reject };
    c.requestAccessToken({ prompt: '', hint: conf.email || undefined });
  }).then(syncNow, () => set('auth', t('Натисніть, щоб увійти в Google')));
}

export function disconnect() {
  // Вхід у Google не відкликаємо: він спільний з іншими застосунками автора — відключається лише цей
  // Незроблене лишаємо: фото, видалені тут, ще треба прибрати з Диска, а «Замінити все» — донести до файлу
  const { trash, restoreAt } = conf;
  conf = { ...(trash?.length ? { trash } : {}), ...(restoreAt ? { restoreAt } : {}) };
  save();
  set('off');
}

// ---------- Google Drive ----------

async function api(url, options = {}) {
  const res = await fetch(url, { ...options, headers: { Authorization: `Bearer ${conf.token}`, ...options.headers } });
  if (res.status === 401) {
    dropSharedToken(conf.token);
    conf.token = null;
    save();
    throw new AuthError(t('Сесія Google закінчилася'));
  }
  if (!res.ok) throw new ApiError(res.status);
  return res;
}

/** Папка застосунку: збережена, знайдена за назвою (найстаріша, якщо два пристрої створили одночасно) або нова. */
async function ensureFolder() {
  if (conf.folderId) {
    try {
      const meta = await (await api(`${DRIVE}/files/${conf.folderId}?fields=id,trashed`)).json();
      if (!meta.trashed) return conf.folderId;
    } catch (err) {
      if (err instanceof AuthError) throw err;
    }
  }
  const q = encodeURIComponent(`name='${FOLDER_NAME.replace(/'/g, "\\'")}' and mimeType='${FOLDER_MIME}' and trashed=false`);
  const { files } = await (await api(`${DRIVE}/files?q=${q}&spaces=drive&orderBy=createdTime&fields=files(id)`)).json();
  conf.folderId = files?.[0]?.id ?? (await (await api(`${DRIVE}/files?fields=id`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ name: FOLDER_NAME, mimeType: FOLDER_MIME, description: 'FPV Log' }),
  })).json()).id;
  save();
  return conf.folderId;
}

/** Перенести в папку файли застосунку, що лежать поза нею (створені до папки або старою версією). */
async function tidy(folderId) {
  if (conf.tidied === folderId && Date.now() - (conf.tidyAt ?? 0) < TIDY_EVERY) return;
  const q = encodeURIComponent(`(name='${FILE_NAME}' or name contains '${PHOTO_PREFIX}') and trashed=false`);
  let pageToken = '';
  do {
    const page = await (await api(`${DRIVE}/files?q=${q}&spaces=drive&pageSize=1000&fields=nextPageToken,files(id,parents)${pageToken ? `&pageToken=${pageToken}` : ''}`)).json();
    for (const f of page.files ?? []) {
      const parents = f.parents ?? [];
      if (parents.includes(folderId)) continue;
      try {
        await api(`${DRIVE}/files/${f.id}?addParents=${folderId}${parents.length ? `&removeParents=${parents.join(',')}` : ''}&fields=id`, {
          method: 'PATCH', headers: { 'Content-Type': 'application/json' }, body: '{}',
        });
      } catch (err) {
        if (err instanceof AuthError) throw err;
        return;   // решту перенесемо наступного разу, синхронізацію не блокуємо
      }
    }
    pageToken = page.nextPageToken ?? '';
  } while (pageToken);
  conf.tidied = folderId;
  conf.tidyAt = Date.now();
  save();
}

async function findFile() {
  if (conf.fileId) {
    try {
      const meta = await (await api(`${DRIVE}/files/${conf.fileId}?fields=id,trashed`)).json();
      if (!meta.trashed) return conf.fileId;
    } catch (err) {
      if (err instanceof AuthError) throw err;
    }
  }
  const q = encodeURIComponent(`name='${FILE_NAME}' and trashed=false`);
  const { files } = await (await api(`${DRIVE}/files?q=${q}&spaces=drive&orderBy=modifiedTime desc&fields=files(id)`)).json();
  conf.fileId = files?.[0]?.id ?? null;
  save();
  return conf.fileId;
}

async function upload(fileId, data, folderId) {
  const content = JSON.stringify({ app: 'fpv-log', format: 1, exportedAt: new Date().toISOString(), data });
  if (fileId) {
    await api(`${UPLOAD}/files/${fileId}?uploadType=media`, {
      method: 'PATCH', headers: { 'Content-Type': 'application/json' }, body: content,
    });
    return fileId;
  }
  const boundary = `sl${Date.now()}`;
  const body = [
    `--${boundary}`, 'Content-Type: application/json; charset=UTF-8', '',
    JSON.stringify({ name: FILE_NAME, mimeType: 'application/json', description: 'FPV Log', parents: [folderId] }),
    `--${boundary}`, 'Content-Type: application/json', '', content, `--${boundary}--`,
  ].join('\r\n');
  const created = await (await api(`${UPLOAD}/files?uploadType=multipart&fields=id`, {
    method: 'POST', headers: { 'Content-Type': `multipart/related; boundary=${boundary}` }, body,
  })).json();
  conf.fileId = created.id;
  save();
  return created.id;
}

// ---------- фото ----------

/** Фото, видалені на цьому пристрої: їхні файли на Диску ще треба прибрати в кошик. */
export function trashPhoto(driveId) {
  if (!driveId) return;
  conf.trash = [...new Set([...(conf.trash ?? []), driveId])];
  save();
}

async function emptyTrash() {
  for (const id of [...(conf.trash ?? [])]) {
    try {
      await api(`${DRIVE}/files/${id}`, {
        method: 'PATCH', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ trashed: true }),
      });
    } catch (err) {
      if (err instanceof AuthError) throw err;
      // інша помилка — спробуємо наступного разу, решту синхронізації не блокуємо
      if (!(err instanceof ApiError && err.status === 404)) continue;
    }
    conf.trash = conf.trash.filter((x) => x !== id);
    save();
  }
}

async function uploadPhoto(id, blob, folderId) {
  const boundary = `sl${Date.now()}`;
  const meta = { name: `${PHOTO_PREFIX}${id}.jpg`, mimeType: 'image/jpeg', parents: [folderId], appProperties: { app: 'fpv-log', photoId: id } };
  const body = new Blob([
    `--${boundary}\r\nContent-Type: application/json; charset=UTF-8\r\n\r\n${JSON.stringify(meta)}\r\n`,
    `--${boundary}\r\nContent-Type: image/jpeg\r\n\r\n`, blob, `\r\n--${boundary}--`,
  ]);
  const created = await (await api(`${UPLOAD}/files?uploadType=multipart&fields=id`, {
    method: 'POST', headers: { 'Content-Type': `multipart/related; boundary=${boundary}` }, body,
  })).json();
  return created.id;
}

/** Вивантажити нові фото цього пристрою. Повертає кількість. */
async function pushPhotos(folderId) {
  const { photos = [] } = await db.loadAll();
  const have = new Set(await db.blobKeys());
  let count = 0;
  for (const p of photos) {
    if (p.driveId || !have.has(p.id)) continue;
    const blob = await db.getBlob(p.id);
    if (!blob) continue;
    const driveId = await uploadPhoto(p.id, blob, folderId);
    if (await db.patch('photos', p.id, { driveId })) count += 1;
    else trashPhoto(driveId);
  }
  return count;
}

/** Докачати фото, додані на інших пристроях. Повертає кількість. */
async function pullPhotos(photos) {
  const have = new Set(await db.blobKeys());
  let count = 0;
  for (const p of photos) {
    if (!p.driveId || have.has(p.id)) continue;
    try {
      const blob = await (await api(`${DRIVE}/files/${p.driveId}?alt=media`)).blob();
      await db.putBlob(p.id, blob);
      count += 1;
    } catch (err) {
      if (!(err instanceof ApiError && err.status === 404)) throw err;
    }
  }
  await db.dropOrphanBlobs();
  return count;
}

// ---------- злиття ----------

const stamp = (x) => Number(x?.updated) || 0;

function newest(lists) {
  const map = new Map();
  for (const rec of lists.flat()) {
    if (!rec?.id) continue;
    const cur = map.get(rec.id);
    if (!cur || stamp(rec) > stamp(cur)) map.set(rec.id, rec);
  }
  return map;
}

export function merge(local, remote) {
  const graves = newest([local.tombstones ?? [], remote.tombstones ?? []]);
  // Сховища, яких ця версія ще не знає (додані новішою), лишаються у файлі як є — інакше стара версія їх стерла б.
  const unknown = Object.entries(remote).filter(([name]) => name !== 'tombstones' && !db.STORES.includes(name));
  const result = { ...Object.fromEntries(unknown), tombstones: [...graves.values()] };
  for (const name of db.STORES) {
    result[name] = [...newest([local[name] ?? [], remote[name] ?? []]).values()]
      .filter((rec) => !graves.has(rec.id) || stamp(rec) > stamp(graves.get(rec.id)));
  }
  return result;
}

/**
 * Після «Замінити все» правдою стає копія: запис, найновіша версія якого (тут чи на Диску) старша
 * за момент відновлення, видаляється. Надгробки кладемо на бік Диска — тоді localChanges запише їх
 * і сюди, а інші пристрої отримають їх із файлу. Відновлені записи мають рівно restoreAt — їх не чіпає.
 */
function bury(local, remote, restoreAt) {
  const graves = [];
  for (const name of db.STORES) {
    for (const rec of newest([local[name] ?? [], remote[name] ?? []]).values()) {
      if (stamp(rec) >= restoreAt) continue;
      graves.push({ id: rec.id, store: name, updated: restoreAt });
      if (name === 'photos') trashPhoto(rec.driveId);
    }
  }
  return { ...remote, tombstones: [...(remote.tombstones ?? []), ...graves] };
}

/** Запам'ятати момент відновлення з копії до найближчої вдалої синхронізації (переживе офлайн і перезапуск). */
export function markRestore(at) {
  if (!conf.enabled) return;
  conf.restoreAt = at;
  save();
}

function fingerprint(data) {
  return ['tombstones', ...db.STORES].map((name) => JSON.stringify(
    [...(data[name] ?? [])].sort((a, b) => String(a.id).localeCompare(String(b.id))))).join('\n');
}

function localChanges(local, merged) {
  const changes = {};
  let count = 0;
  for (const name of ['tombstones', ...db.STORES]) {
    const mine = new Map((local[name] ?? []).map((r) => [r.id, r]));
    const put = merged[name].filter((r) => JSON.stringify(mine.get(r.id)) !== JSON.stringify(r));
    const keep = new Set(merged[name].map((r) => r.id));
    const graves = new Map(merged.tombstones.map((t) => [t.id, t]));
    const del = name === 'tombstones' ? [] : [...mine.keys()].filter((id) => !keep.has(id)).map((id) => graves.get(id) ?? { id, updated: stamp(mine.get(id)) });
    if (put.length || del.length) changes[name] = { put, del };
    count += put.length + del.length;
  }
  return count ? changes : null;
}

// ---------- цикл синхронізації ----------

export async function syncNow() {
  if (!configured()) { set('unconfigured'); return; }
  if (!conf.enabled) { set('off'); return; }
  if (!navigator.onLine) { set('offline'); return; }
  // Вікно входу вже відкрите (оновлення по збереженню) — синхронізація піде, щойно прийде ключ
  if (!tokenValid()) { if (!authWaiter) set('auth', t('Натисніть, щоб увійти в Google')); return; }
  if (running) { again = true; return; }
  running = true;
  set('syncing');
  try {
    if (!conf.email || conf.photo === undefined) {
      // Фото власника Диска показуємо в шапці замість значка застосунку.
      const about = await (await api(`${DRIVE}/about?fields=user(emailAddress,displayName,photoLink)`)).json();
      conf.email = about.user?.emailAddress ?? null;
      noteEmail(conf.token, conf.email);
      conf.photo = about.user?.photoLink ?? null;
      conf.who = about.user?.displayName ?? null;
      save();
    }
    await emptyTrash();
    const folderId = await ensureFolder();
    await tidy(folderId);
    const pushed = await pushPhotos(folderId);
    // Відновлення посеред цього проходу застосує наступний (again) — тут уже прочитано старі дані
    const { restoreAt } = conf;
    const local = await db.loadAll();
    const fileId = await findFile();
    const remote = fileId ? ((await (await api(`${DRIVE}/files/${fileId}?alt=media`)).json())?.data ?? {}) : {};
    const merged = merge(local, restoreAt ? bury(local, remote, restoreAt) : remote);
    const changes = localChanges(local, merged);
    if (changes) await db.writeMerged(changes);
    if (!fileId || fingerprint(remote) !== fingerprint(merged)) await upload(fileId, merged, folderId);
    if (restoreAt && conf.restoreAt === restoreAt) delete conf.restoreAt;
    const pulled = await pullPhotos(merged.photos);
    conf.lastSync = Date.now();
    save();
    set('idle');
    if (changes || pushed || pulled) window.dispatchEvent(new CustomEvent('sync-applied', { detail: { remote: !!changes } }));
  } catch (err) {
    if (err instanceof AuthError) set('auth', t('Натисніть, щоб увійти в Google'));
    else set(navigator.onLine ? 'error' : 'offline', err.message);
  } finally {
    running = false;
    if (again) { again = false; schedule(500); }
  }
}

export function schedule(ms = 2000) {
  clearTimeout(timer);
  timer = setTimeout(syncNow, ms);
}

window.addEventListener('db-change', () => {
  if (!conf.enabled) return;
  refreshOnSave();
  schedule();
});
window.addEventListener('online', () => { if (conf.enabled) { preload(); schedule(500); } });
document.addEventListener('visibilitychange', () => {
  if (document.visibilityState === 'visible' && conf.enabled) schedule(300);
});
