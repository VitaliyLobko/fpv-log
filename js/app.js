// FPV Log: дрони й наземка зі слотами деталей, склад, замовлення, батареї.
// Інфраструктура (база, синхронізація, шторки, теми, «Що нового») — з shooting-log.
import * as db from './db.js';
import * as sync from './sync.js';
import { t, lang, setLang, LANGS, collate, applyStatic, locale } from './i18n.js';
import { prepare as preparePhoto } from './photos.js';
import { rateOn, refreshRates } from './usd.js';
import { parseConfig } from './fcconfig.js';
import { searchPlace, hourly, kpIndex, verdict, LIMITS } from './weather.js';
import { repoOf, isNewer, latestTags, refreshLatest } from './releases.js';
import { h, fmt, sheet, refreshSheets, toast, form, chips, confirmSheet, selectOptions, toolBtn, toolIcon, goTab, confirmed, fieldError, formError, swipeStep } from './ui.js';

let state = { drones: [], items: [], orders: [], batteries: [], flights: [], wishes: [], photos: [], prefs: [] };
let tab = 'drones';

const $ = (id) => document.getElementById(id);

// ---------- довідники ----------

const CATS = [
  ['frame', 'Рама'], ['motors', 'Мотори'], ['fc', 'Політник'], ['esc', 'Регулятор'], ['stack', 'Стек FC+ESC'], ['aio', 'AIO (FC+ESC+RX)'],
  ['vtx', 'VTX'], ['camera', 'Камера'], ['rx', 'Приймач'], ['gps', 'GPS'], ['antenna', 'Антена'], ['props', 'Пропелери'],
  ['vrx', 'Модуль VRX'], ['txmodule', 'Модуль пульта'], ['gbattery', 'Батарея шолома'], ['charger', 'Зарядка'], ['tool', 'Інструмент'], ['other', 'Інше'],
];
const catLabel = (k) => t(CATS.find(([c]) => c === k)?.[1] ?? 'Інше');
const catOptions = () => CATS.map(([k, l]) => [k, t(l)]);

const KINDS = [['self', 'Самозбір'], ['bnf', 'Готовий (BNF)'], ['goggles', 'Шолом'], ['radio', 'Пульт']];
const kindLabel = (k) => t(KINDS.find(([x]) => x === k)?.[1] ?? '');
const groupOf = (kind) => (kind === 'goggles' || kind === 'radio' ? 'ground' : 'drone');

// Слоти за типом: [категорія, власна назва слота]. Для BNF слоти необов'язкові — порожні просто не показуються в «Скопіювати збірку».
// Мотор — окрема деталь у своєму слоті: міняють їх поштучно.
const MOTORS = [1, 2, 3, 4].map((n) => ['motors', `Мотор ${n}`]);
const SLOTS = {
  self: [['frame'], ...MOTORS, ['fc'], ['esc', 'Регулятор / стек'], ['vtx'], ['camera'], ['rx'], ['gps'], ['antenna', 'Антена VTX'], ['antenna', 'Антена RX'], ['props']],
  bnf: [['frame'], ['aio'], ...MOTORS, ['camera'], ['vtx'], ['props']],
  goggles: [['vrx'], ['antenna', 'Антени'], ['gbattery', 'Батарея']],
  radio: [['txmodule', 'Внутрішній модуль'], ['txmodule', 'Зовнішній модуль']],
};

const STATUS = { stock: 'На складі', installed: 'На дроні', broken: 'Зламаний', sold: 'Продано / списано' };
const BAT_STATES = [['charged', 'Заряджена'], ['storage', 'Зберігання'], ['empty', 'Розряджена'], ['dead', 'Здута / списана']];
const batStateLabel = (k) => t(BAT_STATES.find(([x]) => x === k)?.[1] ?? '');
const CONNECTORS = ['XT60', 'XT30', 'BT2.0', 'PH2.0', 'A30', 'XT90'];
const FLIGHT_TYPES = [['freestyle', 'Фрістайл'], ['long', 'Дальній'], ['other', 'Інше']];
const flightTypeLabel = (k) => t(FLIGHT_TYPES.find(([x]) => x === k)?.[1] ?? 'Інше');

// ---------- дрібниці ----------

function today(when = new Date()) {
  const d = new Date(when);
  d.setMinutes(d.getMinutes() - d.getTimezoneOffset());
  return d.toISOString().slice(0, 10);
}
const addDays = (date, n) => new Date(Date.parse(date) + n * 864e5).toISOString().slice(0, 10);
const round2 = (n) => Math.round((Number(n) || 0) * 100) / 100;
const num = (v) => Number(v) || 0;
/** Хвилини нальоту: «45 хв», «3 год 20 хв». */
const fmtMin = (m) => { const n = Math.round(num(m)); return n >= 60 ? t('{h} год {m} хв', { h: Math.floor(n / 60), m: n % 60 }) : t('{m} хв', { m: n }); };

function remember(key, value) {
  try { localStorage.setItem(key, value ?? ''); } catch { /* приватний режим */ }
}

function recall(key) {
  try { return localStorage.getItem(key); } catch { return null; }
}

function btn(label, onclick, kind = '') {
  return h('button', { type: 'button', class: `btn ${kind}`, onclick }, label);
}

function box(title, content, tools = null) {
  return h('fieldset', { class: 'box' }, h('legend', {}, title, tools), content);
}

/** Група, що згортається; розгорнуту пам'ятає між запусками. */
function fold(key, title, body) {
  const el = h('details', { class: 'ex-more', open: recall(`fpv-log:open:${key}`) === '1' }, h('summary', {}, title), body);
  el.addEventListener('toggle', () => remember(`fpv-log:open:${key}`, el.open ? '1' : ''));
  return el;
}

function empty(title, text, actions = []) {
  return h('div', { class: 'empty' }, h('h3', {}, title), h('p', { class: 'muted' }, text),
    actions.length ? h('div', { class: 'btn-row' }, actions) : null);
}

/** Рядок списку: назва, підпис, праворуч — значення. */
function row(title, sub, right, onclick, { id = null, cls = '', thumb = null } = {}) {
  return h('button', { type: 'button', class: `row ${cls}`, onclick, dataset: id ? { id } : undefined },
    thumb,
    h('span', { class: 'row-main' }, h('span', { class: 'row-title' }, title), sub ? h('span', { class: 'muted small' }, sub) : null),
    right !== null && right !== undefined && right !== '' ? h('span', { class: 'row-qty' }, right) : null);
}

function kv(pairs) {
  return h('dl', { class: 'kv' }, pairs.filter((p) => p && p[1] !== null && p[1] !== undefined && p[1] !== '')
    .map(([k, v]) => [h('dt', {}, k), h('dd', {}, v)]));
}

function invalidField(f) {
  const bad = f.invalid();
  if (bad) fieldError(f.inputs[bad.name], t('Заповніть поле «{label}»', { label: bad.label }));
  return Boolean(bad);
}

/** Запис у власну історію: дата й текст. */
const logged = (rec, text, date = today()) => ({ ...rec, history: [...(rec.history ?? []), { date, text }] });

// ---------- дані ----------

const findDrone = (id) => state.drones.find((x) => x.id === id);
const findItem = (id) => (id ? state.items.find((x) => x.id === id) : null);
const findOrder = (id) => state.orders.find((x) => x.id === id);
const findBattery = (id) => state.batteries.find((x) => x.id === id);
const findPhoto = (id) => (id ? state.photos.find((x) => x.id === id) : null);

/** Прочитати базу; дані старого вигляду (з іншого пристрою, Диска чи копії) спершу оновити. */
async function load() {
  state = await db.loadAll();
  const fix = migrate(state);
  if (fix) {
    await db.write(fix);
    state = await db.loadAll();
  }
}

async function refresh() {
  await load();
  render();
  refreshSheets();
  checkFw();
}

// Новіші прошивки — фоном, теги з кешу на добу; мережу смикаємо не частіше раз на 10 хвилин (офлайн — тихо нічого)
let fwTried = { at: 0, key: '' };
function checkFw() {
  const repos = [...new Set(state.items.map((it) => repoOf(it.fw)).filter(Boolean))].sort();
  if (!repos.length || (repos.join() === fwTried.key && Date.now() - fwTried.at < 600_000)) return;
  fwTried = { at: Date.now(), key: repos.join() };
  refreshLatest(repos).then((changed) => { if (changed) { render(); refreshSheets(); } }, () => {});
}

async function save(changes, ids = []) {
  // Видалена деталь чи побажання — з нею й її фото (запис, файл, копія на Диску), хоч би яким шляхом видалили
  const gone = new Set(['items', 'wishes'].flatMap((s) => changes[s]?.del ?? []));
  const orphans = dropPhotos(state.photos.filter((p) => gone.has(p.owner)).map((p) => p.id));
  for (const k of ['photos', 'blobs']) if (orphans[k]) changes = { ...changes, [k]: { ...changes[k], del: [...(changes[k]?.del ?? []), ...orphans[k].del] } };
  await db.write(changes);
  await refresh();
  confirmed(ids);
}

const itemName = (it) => (it ? [it.brand, it.model].filter(Boolean).join(' ') || catLabel(it.cat) : '—');
const slotLabel = (s) => s.label || (s.tpl ? t(s.tpl) : catLabel(s.cat));
/** Новіший реліз прошивки деталі (Betaflight, INAV, ExpressLRS, EdgeTX) з кешу GitHub чи null. */
const fwNewer = (it) => { const tag = it?.fw && latestTags()[repoOf(it.fw)]; return tag && isNewer(tag, it.fw) ? tag : null; };
const fwHint = (it) => (fwNewer(it) ? t('є новіша: {v}', { v: fwNewer(it) }) : null);
const prefs = () => state.prefs.find((p) => p.id === 'settings') ?? { id: 'settings' };
const staleDays = () => num(prefs().staleDays) || 3;

const orderK = (o) => (o.currency === 'USD' ? num(o.rate) || rateOn(o.date) || 0 : 1);
const orderSub = (o) => o.lines.reduce((s, l) => s + num(l.price) * num(l.qty), 0);
const orderTotal = (o) => round2((orderSub(o) + num(o.shipping)) * orderK(o));
/** Ціна штуки позиції в гривнях із її часткою доставки. */
const lineUah = (o, l) => round2(num(l.price) * (1 + (orderSub(o) ? num(o.shipping) / orderSub(o) : 0)) * orderK(o));

/** Позиція замовлення, якою куплено дрон чи шолом цілим (d.buy = { orderId, lineId }). */
function boughtLine(d) {
  const o = d.buy ? findOrder(d.buy.orderId) : null;
  const l = o?.lines.find((x) => x.id === d.buy.lineId);
  return l ? { o, l } : null;
}

/** Свій кошт дрона (BNF, шолом): з позиції замовлення, а без неї — ціна, вписана вручну. */
const droneOwn = (d) => { const b = boughtLine(d); return b ? lineUah(b.o, b.l) : num(d.price); };

/** Вартість дрона: свій кошт + деталі, що на ньому стоять, із долею доставки. */
const droneCost = (d) => droneOwn(d) + d.slots.reduce((s, sl) => s + num(findItem(sl.itemId)?.price), 0);

/** Вкладено в хобі: замовлення + куплене без замовлення + дрони й батареї − продане. Дрон із позиції замовлення вже в замовленні. */
function invested() {
  return state.orders.reduce((s, o) => s + orderTotal(o), 0)
    + state.items.reduce((s, it) => s + (it.orderId ? 0 : num(it.price)) - (it.status === 'sold' ? num(it.soldPrice) : 0), 0)
    + state.drones.reduce((s, d) => s + (boughtLine(d) ? 0 : num(d.price)), 0)
    + state.batteries.reduce((s, b) => s + num(b.price), 0);
}

// ---------- оновлення даних старих версій ----------

// «… ×4» наприкінці моделі мотора — комплект із чотирьох однією деталлю (так заводили до 0.1.4)
const SET4 = /\s*[×xXхХ]\s*4$/;

/**
 * 0.1.x → 0.1.4: слот «Мотори» з комплектом ×4 стає чотирма слотами «Мотор 1–4», комплект — чотирма деталями
 * (перша — той самий запис, ціна й сума продажу діляться порівну, копійки залишку — першій), позиція замовлення —
 * чотирма штуками за чверть ціни: підсумки не змінюються. id нових записів похідні від старих, тож два пристрої,
 * що оновили ті самі дані, дають ті самі записи, і синхронізація їх не подвоює. Повертає зміни для db.write або null.
 */
function migrate(st) {
  const items = [];
  const parts = new Map();
  const quarter = (v, i) => (v === null || v === undefined ? v : i ? round2(num(v) / 4) : round2(num(v) - 3 * round2(num(v) / 4)));
  for (const it of st.items) {
    if (it.kind !== 'unit' || it.cat !== 'motors' || !SET4.test(it.model ?? '')) continue;
    const ids = [it.id, `${it.id}-m2`, `${it.id}-m3`, `${it.id}-m4`];
    parts.set(it.id, ids);
    const model = it.model.replace(SET4, '') || it.model;
    const history = [...(it.history ?? []), { date: today(), text: t('Комплект ×4 розділено на 4 мотори') }];
    ids.forEach((id, i) => items.push({ ...it, id, model, price: quarter(it.price, i), ...('soldPrice' in it ? { soldPrice: quarter(it.soldPrice, i) } : {}), history }));
  }
  const orders = st.orders.filter((o) => o.lines.some((l) => l.itemIds?.some((id) => parts.has(id)))).map((o) => ({
    ...o,
    lines: o.lines.map((l) => (l.kind === 'consumable' || !l.itemIds?.length || !l.itemIds.every((id) => parts.has(id)) ? l
      : { ...l, model: (l.model ?? '').replace(SET4, '') || l.model, price: num(l.price) / 4, qty: num(l.qty) * 4, itemIds: l.itemIds.flatMap((id) => parts.get(id)) })),
  }));
  const drones = [];
  for (const d of st.drones) {
    let changed = false;
    const slots = d.slots.flatMap((s) => {
      const ids = parts.get(s.itemId);
      if (!ids && !(s.cat === 'motors' && !s.tpl && !s.label)) return [s];
      changed = true;
      return [0, 1, 2, 3].map((i) => ({
        ...s, id: i ? `${s.id}-m${i + 1}` : s.id, ...(s.label ? { label: `${s.label} ${i + 1}` } : { tpl: `Мотор ${i + 1}` }), itemId: i ? ids?.[i] ?? null : s.itemId,
      }));
    });
    if (changed) drones.push({ ...d, slots });
  }
  return items.length || drones.length ? { items: { put: items }, orders: { put: orders }, drones: { put: drones } } : null;
}

// ---------- фото ----------

function pickFile(onFile) {
  const input = h('input', { type: 'file', accept: 'image/*', hidden: true, onchange: (e) => { if (e.target.files[0]) onFile(e.target.files[0]); input.remove(); } });
  document.body.append(input);
  input.click();
}

/** Нове фото: запис із мініатюрою + файл. Повертає зміни для db.write і id. */
async function newPhoto(file, owner) {
  const { blob, thumb } = await preparePhoto(file);
  const id = db.uid();
  return { id, photos: { put: [{ id, owner, thumb, created: Date.now() }] }, blobs: { put: [{ id, blob }] } };
}

/** Прибрати фото: запис, файл і копію на Диску. */
function dropPhotos(ids) {
  const list = ids.map(findPhoto).filter(Boolean);
  list.forEach((p) => sync.trashPhoto(p.driveId));
  return list.length ? { photos: { del: list.map((p) => p.id) }, blobs: { del: list.map((p) => p.id) } } : {};
}

/** Мініатюра в рядку: тап по ній — фото на весь екран, по решті рядка — картка. Без фото — монограма (fallback) або нічого. */
function thumbImg(photoId, fallback = '') {
  const p = findPhoto(photoId);
  if (p) return h('img', { class: 'thumb', src: p.thumb, alt: t('Фото'), onclick: (e) => { e.stopPropagation(); showPhoto(p.id); } });
  return fallback === null ? null : h('span', { class: 'thumb mono', style: '--h: 25' }, fallback);
}

// «Знайти фото»: перед переходом у Google запам'ятовуємо форму, куди повернути картинку з «Поділитися»
const PHOTO_FOR = 'fpv-log:photo-for';

/**
 * Одне фото до запису: плитка-прев'ю (тап — на весь екран, порожня — вибрати), «Знайти фото» — Google Картинки
 * за назвою, «Вставити» — скопійоване зображення, «З галереї», «Прибрати»; на комп'ютері ще Ctrl+V і перетягування.
 * value() → { file, removed } — пишеться разом із формою (photoChanges).
 */
function photoPicker(currentId, { file: preset = null, query = () => '', onSearch = null } = {}) {
  const current = findPhoto(currentId);
  let file = preset;
  let removed = Boolean(preset);
  let url = null;
  const el = h('div', { class: 'photo-pick' });
  const take = (f) => {
    if (!f?.type?.startsWith('image/')) return false;
    file = f;
    removed = false;
    paint();
    return true;
  };
  const input = h('input', { type: 'file', accept: 'image/*', hidden: true, onchange: (e) => { take(e.target.files[0]); e.target.value = ''; } });
  const search = () => {
    const q = query().trim();
    if (!q) { toast(t('Спершу впишіть назву')); return; }
    onSearch?.();
    window.open(`https://www.google.com/search?tbm=isch&q=${encodeURIComponent(q)}`, '_blank', 'noopener');
  };
  const paste = async () => {
    try {
      for (const item of await navigator.clipboard.read()) {
        const type = item.types.find((x) => x.startsWith('image/'));
        if (type) { take(new File([await item.getType(type)], 'clip', { type })); return; }
      }
      toast(t('У буфері немає картинки — скопіюйте зображення'));
    } catch {
      toast(t('Браузер не дав прочитати буфер — поділіться картинкою в застосунок або збережіть її в галерею'));
    }
  };
  // Ctrl+V, поки форма відкрита; закрилась — слухач знімає себе сам
  const onPaste = (e) => {
    if (!el.isConnected) { document.removeEventListener('paste', onPaste); return; }
    const f = [...(e.clipboardData?.files ?? [])].find((x) => x.type.startsWith('image/'));
    if (f && take(f)) e.preventDefault();
  };
  document.addEventListener('paste', onPaste);
  function paint() {
    if (url) URL.revokeObjectURL(url);
    url = file ? URL.createObjectURL(file) : null;
    const src = url ?? (removed ? null : current?.thumb);
    el.replaceChildren(
      h('button', {
        type: 'button', class: `photo-pick-thumb ${src ? '' : 'empty'}`, 'aria-label': t('Фото'),
        // Нове, ще не збережене фото на весь екран не відкриваємо — тап просто вибирає інше
        onclick: () => (src && !file ? showPhoto(current.id) : input.click()),
        ondragover: (e) => e.preventDefault(),
        ondrop: (e) => { e.preventDefault(); take(e.dataTransfer?.files?.[0]); },
      }, src ? h('img', { src, alt: '' }) : h('span', {}, '+ ', t('Фото'))),
      h('div', { class: 'photo-pick-acts' },
        btn(`🔍 ${t('Знайти фото')}`, search, 'mini'),
        h('div', { class: 'photo-pick-icons' },
          navigator.clipboard?.read ? toolBtn('paste', t('Вставити'), paste) : null,
          toolBtn('gallery', t('З галереї'), () => input.click()),
          src ? toolBtn('delete', t('Прибрати фото'), () => { file = null; removed = true; paint(); }, 'danger') : null)),
      navigator.clipboard?.read ? h('p', { class: 'muted small photo-pick-hint' },
        t('У Google: довгий тап на картинці → «Копіювати зображення» → тут'), ' ', toolIcon('paste')) : null,
      input);
  }
  paint();
  return { el, value: () => ({ file, removed: removed || Boolean(file) }) };
}

/** Зміни фото запису rec (поле photoId) з value() пікера: нове — записати, старе — прибрати. Повертає [rec, зміни для db.write]. */
async function photoChanges(rec, change) {
  if (!change?.removed) return [rec, {}];
  const old = dropPhotos([rec.photoId].filter(Boolean));
  const p = change.file ? await newPhoto(change.file, rec.id) : null;
  return [{ ...rec, photoId: p?.id ?? null }, {
    photos: { put: p?.photos.put ?? [], del: old.photos?.del ?? [] },
    blobs: { put: p?.blobs.put ?? [], del: old.blobs?.del ?? [] },
  }];
}

/** Картинка, якою поділились у застосунок: service worker кладе її в кеш, тут — відкрити ту саму форму. */
async function takeSharedImage() {
  const cache = await caches.open('fpv-log:shared-image');
  const res = await cache.match('shared');
  if (!res) return;
  await cache.delete('shared');
  const blob = await res.blob();
  const file = new File([blob], 'shared', { type: blob.type || 'image/jpeg' });
  const target = readJson(PHOTO_FOR);
  remember(PHOTO_FOR, '');
  const open = {
    item: () => itemForm(findItem(target.id) ?? null, { preset: target.draft ?? {}, file }),
    wish: () => wishForm(state.wishes.find((x) => x.id === target.id) ?? null, { draft: target.draft, file }),
    drone: () => droneForm(findDrone(target.id) ?? null, { draft: target.draft, file }),
  }[target?.kind];
  if (!open) { toast(t('Відкрийте деталь, побажання чи дрон і натисніть «Знайти фото» — потім поділіться картинкою')); return; }
  open();
  toast(t('Картинку отримано — збережіть'));
}

/** Фото на весь екран: двома пальцями — збільшити, подвійний тап — 1× / 2.5×, змах убік — сусіднє фото зі списку ids. */
function showPhoto(id, ids = [id]) {
  const list = ids.filter((x) => findPhoto(x));
  let at = Math.max(0, list.indexOf(id));
  if (!list.length) return;
  let url = null;
  const img = h('img', { class: 'photo-full', alt: '', draggable: 'false' });
  const count = h('p', { class: 'muted small photo-count' });
  let z = { s: 1, x: 0, y: 0 };
  const apply = () => { img.style.transform = `translate(${z.x}px, ${z.y}px) scale(${z.s})`; };
  const show = async () => {
    const p = findPhoto(list[at]);
    z = { s: 1, x: 0, y: 0 };
    apply();
    if (url) URL.revokeObjectURL(url);
    url = null;
    img.src = p.thumb;
    count.textContent = list.length > 1 ? `${at + 1} / ${list.length}` : '';
    const blob = await db.getBlob(p.id);
    if (blob && list[at] === p.id) { url = URL.createObjectURL(blob); img.src = url; }
  };
  const pts = new Map();
  let start = null;
  const snap = () => {
    const [a, b] = [...pts.values()];
    start = { ...z, a: { ...a }, dist: b ? Math.hypot(a.x - b.x, a.y - b.y) : 0, n: pts.size };
  };
  const wrap = h('div', {
    class: 'photo-wrap',
    onpointerdown: (e) => {
      pts.set(e.pointerId, { x: e.clientX, y: e.clientY });
      snap();
      try { wrap.setPointerCapture(e.pointerId); } catch { /* вказівник уже відпущено */ }
    },
    onpointermove: (e) => {
      if (!pts.has(e.pointerId)) return;
      pts.set(e.pointerId, { x: e.clientX, y: e.clientY });
      const [a, b] = [...pts.values()];
      if (b && start.dist) z.s = Math.min(5, Math.max(1, start.s * (Math.hypot(a.x - b.x, a.y - b.y) / start.dist)));
      else if (!b && start.s > 1) { z.x = start.x + a.x - start.a.x; z.y = start.y + a.y - start.a.y; }
      apply();
    },
    ondblclick: () => { z = z.s > 1 ? { s: 1, x: 0, y: 0 } : { s: 2.5, x: 0, y: 0 }; apply(); },
  }, img);
  const up = (e) => {
    const p = pts.get(e.pointerId);
    if (!p) return;
    pts.delete(e.pointerId);
    const dx = p.x - start.a.x;
    // Змах одним пальцем без збільшення — до сусіднього фото
    if (e.type === 'pointerup' && start.n === 1 && !pts.size && z.s === 1 && Math.abs(dx) > 50 && Math.abs(dx) > Math.abs(p.y - start.a.y)) {
      const next = at + (dx < 0 ? 1 : -1);
      if (next >= 0 && next < list.length) { at = next; show(); }
    }
    if (z.s <= 1) { z = { s: 1, x: 0, y: 0 }; apply(); }
    if (pts.size) snap();
  };
  wrap.addEventListener('pointerup', up);
  wrap.addEventListener('pointercancel', up);
  show();
  sheet(t('Фото'), h('div', { class: 'photo-view' }, wrap, count), { full: true, onClose: () => url && URL.revokeObjectURL(url) });
}

/** Усі фото дрона по порядку: сам дрон, далі нотатки від нових до старих. */
const dronePhotos = (d) => [d.photoId, ...[...(d.notes ?? [])].sort((a, b) => collate(b.date, a.date)).map((n) => n.photoId)].filter(Boolean);

const monogram = (name) => String(name ?? '').split(/[\s-]+/).filter(Boolean).slice(0, 2).map((x) => x[0]).join('').toUpperCase() || '?';

// ---------- плашка батарей ----------

function staleBatteries() {
  const limit = staleDays() * 864e5;
  return state.batteries.filter((b) => b.state === 'charged' && b.stateAt && Date.now() - b.stateAt > limit);
}

function staleBanner() {
  const list = staleBatteries();
  if (!list.length) return null;
  return h('button', { type: 'button', class: 'banner warn', onclick: () => goTab('#batteries') },
    t('Заряджені довше {n} дн.: {list} — переведіть у зберігання', { n: staleDays(), list: list.map((b) => `#${b.num}`).join(', ') }));
}

// ---------- дрони ----------

function droneRow(d) {
  const filled = d.slots.filter((s) => s.itemId).length;
  const fresh = d.slots.some((s) => fwNewer(findItem(s.itemId)));
  return row(d.name, [kindLabel(d.kind), t('деталей: {n}', { n: filled }), fresh ? t('є новіша прошивка') : null].filter(Boolean).join(' · '), droneCost(d) ? fmt.money(droneCost(d)) : '',
    () => droneDetail(d.id), { id: d.id, thumb: thumbImg(d.photoId, monogram(d.name)) });
}

function renderDrones() {
  const drones = state.drones.filter((d) => d.group !== 'ground').sort((a, b) => collate(a.name, b.name));
  const ground = state.drones.filter((d) => d.group === 'ground').sort((a, b) => collate(a.name, b.name));
  if (!state.drones.length) {
    return h('div', {}, staleBanner(), empty(t('Ще немає дронів'), t('Додайте дрон чи наземку кнопкою «+», завантажте демодані в ⚙ або імпортуйте стартовий набір.'),
      [btn(t('Додати'), () => droneForm(), 'primary add'), importBtn()]));
  }
  return h('div', {}, staleBanner(),
    drones.length ? h('div', { class: 'rows' }, drones.map(droneRow)) : null,
    ground.length ? box(t('Наземка'), h('div', { class: 'rows' }, ground.map(droneRow))) : null);
}

function droneForm(d = null, { draft = null, file = null } = {}) {
  let kind = d?.kind ?? draft?.kind ?? 'self';
  // Позиції «дрон чи шолом цілим», ще не прив'язані до іншого дрона
  const taken = new Set(state.drones.filter((x) => x.id !== d?.id && boughtLine(x)).map((x) => `${x.buy.orderId}|${x.buy.lineId}`));
  const lines = [...state.orders].sort((a, b) => collate(b.date, a.date)).flatMap((o) => o.lines
    .filter((l) => l.kind === 'drone' && !taken.has(`${o.id}|${l.id}`))
    .map((l) => [`${o.id}|${l.id}`, `${o.shop} · ${[l.brand, l.model].filter(Boolean).join(' ')} · ${fmt.date(o.date)}`]));
  const f = form([
    { name: 'name', label: t('Назва'), value: d?.name ?? draft?.name, required: true, placeholder: t('напр. 5″ фристайл') },
    ...(lines.length ? [{ name: 'buy', label: t('Покупка'), type: 'select', options: [['', t('Ціна вручну')], { group: t('Із замовлення'), options: lines }],
      value: boughtLine(d ?? {}) ? `${d.buy.orderId}|${d.buy.lineId}` : '' }] : []),
    { name: 'price', label: t('Ціна, грн'), type: 'number', value: d?.price, half: true, hint: t('Для BNF чи шолома; деталі рахуються окремо') },
    { name: 'buyDate', label: t('Куплено'), type: 'dmy', value: d?.buyDate, half: true },
  ]);
  // Куплено замовленням — ціна й дата звідти, ручні поля ховаємо
  const hand = () => { for (const n of ['price', 'buyDate']) f.inputs[n].closest('.field').hidden = Boolean(f.inputs.buy?.value); };
  f.inputs.buy?.addEventListener('change', hand);
  hand();
  const kinds = chips(KINDS.map(([k, l]) => [k, t(l)]), kind, (v) => { kind = v; });
  kinds.classList.add('segmented');
  const pic = photoPicker(d?.photoId, {
    file, query: () => f.inputs.name.value,
    onSearch: () => remember(PHOTO_FOR, JSON.stringify({ kind: 'drone', id: d?.id ?? null, draft: d ? null : { ...f.values(), kind } })),
  });
  const close = sheet(d ? t('Змінити') : t('Новий дрон чи наземка'), h('div', {},
    pic.el, d ? null : h('div', { class: 'field-label' }, t('Тип')), d ? null : kinds, f.el), {
    actions: [btn(t('Скасувати'), () => close()), btn(t('Зберегти'), async () => {
      if (invalidField(f)) return;
      const v = f.values();
      const [orderId, lineId] = (v.buy || '').split('|');
      const buy = orderId ? { orderId, lineId } : null;
      const rec = d ? { ...d, name: v.name, price: v.price, buyDate: v.buyDate, buy }
        : {
          id: db.uid(), created: Date.now(), name: v.name, kind, group: groupOf(kind), price: v.price, buyDate: v.buyDate, buy,
          slots: SLOTS[kind].map(([cat, tpl]) => ({ id: db.uid(), cat, ...(tpl ? { tpl } : {}), itemId: null })),
          notes: [], configs: [], history: [{ date: today(), text: t('Заведено') }],
        };
      close();
      const [withPhoto, ph] = await photoChanges(rec, pic.value());
      await save({ drones: { put: [withPhoto] }, ...ph }, [rec.id]);
      if (!d) droneDetail(rec.id);
    }, 'primary')],
  });
}

function droneDetail(id) {
  const build = () => { const d = findDrone(id); return d ? droneBody(d) : null; };
  sheet(() => findDrone(id)?.name, build(), {
    live: build,
    tools: [toolBtn('edit', t('Змінити'), () => droneForm(findDrone(id))), toolBtn('delete', t('Видалити'), () => removeDrone(findDrone(id)), 'danger')],
  });
}

function droneBody(d) {
  const photo = findPhoto(d.photoId);
  const b = boughtLine(d);
  const flown = state.flights.filter((f) => f.droneId === d.id);
  return h('div', {},
    photo ? h('img', { class: 'drone-photo', src: photo.thumb, alt: '', onclick: () => showPhoto(photo.id, dronePhotos(d)) }) : null,
    kv([[t('Тип'), kindLabel(d.kind)], [t('Вартість'), fmt.money(droneCost(d))],
      [t('Куплено'), b ? `${b.o.shop} · ${fmt.date(b.o.date)}` : d.buyDate ? fmt.date(d.buyDate) : null],
      flown.length ? [t('Наліт'), `${fmtMin(flown.reduce((n, f) => n + flightMin(f), 0))} · ${t('польотів: {n}', { n: flown.length })}`] : null]),
    box(t('Збірка'), h('div', {},
      h('div', { class: 'rows' }, d.slots.map((s) => slotRow(d, s))),
      h('div', { class: 'btn-row' }, btn(t('+ Слот'), () => slotForm(d))))),
    h('div', { class: 'btn-row' },
      btn(t('Скопіювати збірку'), () => copyText(buildText(d)), 'primary'),
      btn(photo ? t('Змінити фото') : t('Фото'), () => droneForm(d)),
      btn(t('Нотатка'), () => noteForm(d)),
      btn(t('Конфіг'), () => configForm(d))),
    d.notes?.length ? box(t('Нотатки'), h('div', { class: 'rows' }, [...d.notes].sort((a, b) => collate(b.date, a.date)).map((n) =>
      row(n.text.split('\n')[0], fmt.date(n.date), '', () => noteView(d, n), { thumb: n.photoId ? thumbImg(n.photoId) : null })))) : null,
    d.configs?.length ? box(t('Конфіги'), h('div', { class: 'rows' }, [...d.configs].sort((a, b) => collate(b.date, a.date)).map((c) =>
      row(c.name || t('Конфіг'), [fmt.date(c.date), parseConfig(c.text)?.label].filter(Boolean).join(' · '), '', () => configView(d, c))))) : null,
    d.history?.length ? fold('drone-history', t('Історія'), historyList(d.history)) : null);
}

function historyList(list) {
  return h('ul', { class: 'changes' }, [...list].reverse().map((x) => h('li', {}, `${fmt.date(x.date)} — ${x.text}`)));
}

function slotRow(d, s) {
  const it = findItem(s.itemId);
  return h('div', { class: 'row slot' },
    h('span', { class: 'row-main', onclick: it ? () => itemDetail(it.id) : null },
      h('span', { class: 'muted small' }, slotLabel(s)),
      h('span', { class: 'row-title' }, it ? itemName(it) : '—'),
      it?.fw ? h('span', { class: 'muted small' }, `${t('Прошивка')}: ${it.fw}`, fwHint(it) ? h('span', { class: 'fw-new' }, ` · ${fwHint(it)}`) : null) : null),
    btn(t('Замінити'), () => replaceSheet(d.id, s.id), 'quiet'));
}

function buildText(d) {
  const lines = [`${d.name} — ${kindLabel(d.kind)}`];
  for (const s of d.slots) {
    const it = findItem(s.itemId);
    if (it) lines.push(`${slotLabel(s)}: ${itemName(it)}${it.fw ? ` · ${t('прошивка')} ${it.fw}` : ''}`);
  }
  return lines.join('\n');
}

function copyText(text) {
  const fallback = () => sheet(t('Скопіювати'), h('textarea', { class: 'copy-box', rows: 12, readonly: true }, text));
  if (!navigator.clipboard?.writeText) { fallback(); return; }
  navigator.clipboard.writeText(text).then(() => toast(t('Скопійовано')), fallback);
}

/** «Замінити»: нова деталь зі складу (або порожньо); зняту — на склад чи «зламана» з причиною. Історія — у дрона й обох деталей. */
/** preset — { outcome: 'broken', reason } з польоту з падінням: знята деталь одразу «зламана» з причиною. */
function replaceSheet(droneId, slotId, preset = {}) {
  const d = findDrone(droneId);
  const s = d.slots.find((x) => x.id === slotId);
  const cur = findItem(s.itemId);
  const free = state.items.filter((it) => it.kind === 'unit' && it.status === 'stock').sort((a, b) => collate(itemName(a), itemName(b)));
  const fits = free.filter((it) => it.cat === s.cat);
  const select = h('select', { name: 'item' }, selectOptions([['', t('— порожньо —')],
    { group: t('Підходять'), options: fits.map((it) => [it.id, itemName(it)]) },
    { group: t('Інше на складі'), options: free.filter((it) => it.cat !== s.cat).map((it) => [it.id, `${itemName(it)} (${catLabel(it.cat)})`]) }], ''));
  let outcome = preset.outcome ?? 'stock';
  const reason = form([{ name: 'reason', label: t('Причина'), value: preset.reason, placeholder: t('напр. погнутий вал після падіння') }]);
  reason.el.hidden = outcome !== 'broken';
  const out = chips([['stock', t('На склад')], ['broken', t('Зламана')]], outcome, (v) => { outcome = v; reason.el.hidden = v !== 'broken'; });
  out.classList.add('segmented');
  const close = sheet(`${t('Замінити')}: ${slotLabel(s)}`, h('div', {},
    cur ? kv([[t('Зараз'), itemName(cur)]]) : null,
    h('label', { class: 'field' }, h('span', { class: 'field-label' }, t('Нова деталь')), select),
    h('div', { class: 'btn-row' }, btn(t('Нова деталь, якої ще немає на складі…'), () => {
      close();
      itemForm(null, { preset: { cat: s.cat }, onSaved: (it) => replaceSlot(droneId, slotId, it.id, 'stock', '') });
    }, 'quiet')),
    cur ? [h('div', { class: 'field-label' }, t('Зняту деталь')), out, reason.el] : null), {
    actions: [btn(t('Скасувати'), () => close()), btn(t('Зберегти'), async () => {
      const r = reason.values().reason;
      if (cur && outcome === 'broken' && !r) { fieldError(reason.inputs.reason, t('Вкажіть причину')); return; }
      if ((select.value || null) === (s.itemId || null)) { close(); return; }
      close();
      await replaceSlot(droneId, slotId, select.value || null, outcome, r, preset.flightId);
    }, 'primary')],
  });
}

/** flightId — зламана в падінні цього польоту: brokeIn пам'ятає, звідки зняли, щоб видалення польоту могло повернути деталь. */
async function replaceSlot(droneId, slotId, newId, outcome, reason, flightId = null) {
  const d = findDrone(droneId);
  const s = d.slots.find((x) => x.id === slotId);
  const old = findItem(s.itemId);
  const nw = findItem(newId);
  const where = { d: d.name, slot: slotLabel(s) };
  const put = [];
  if (old) {
    put.push(logged({ ...old, status: outcome === 'broken' ? 'broken' : 'stock', droneId: null, brokeIn: outcome === 'broken' && flightId ? { flightId, droneId, slotId } : null, ...(outcome === 'broken' ? { reason } : {}) },
      outcome === 'broken' ? t('Знято з «{d}» ({slot}), зламана: {r}', { ...where, r: reason }) : t('Знято з «{d}» ({slot}) на склад', where)));
  }
  if (nw) put.push(logged({ ...nw, status: 'installed', droneId: d.id, brokeIn: null }, t('Встановлено на «{d}» ({slot})', where)));
  const text = `${slotLabel(s)}: ${old ? itemName(old) : '—'} → ${nw ? itemName(nw) : '—'}${old && outcome === 'broken' ? ` (${t('зламана')}: ${reason})` : ''}`;
  const drone = logged({ ...d, slots: d.slots.map((x) => (x.id === slotId ? { ...x, itemId: newId || null } : x)) }, text);
  await save({ drones: { put: [drone] }, items: { put } }, [d.id, ...put.map((x) => x.id)]);
}

function slotForm(d) {
  const f = form([
    { name: 'label', label: t('Назва слота'), required: true, placeholder: t('напр. Бузер') },
    { name: 'cat', label: t('Категорія'), type: 'select', options: catOptions(), value: 'other' },
  ]);
  const close = sheet(t('Новий слот'), f.el, {
    actions: [btn(t('Скасувати'), () => close()), btn(t('Додати'), async () => {
      if (invalidField(f)) return;
      const v = f.values();
      close();
      await save({ drones: { put: [{ ...d, slots: [...d.slots, { id: db.uid(), cat: v.cat, label: v.label, itemId: null }] }] } }, [d.id]);
    }, 'primary')],
  });
}


function removeDrone(d) {
  confirmSheet(t('Видалити «{name}»?', { name: d.name }), t('Деталі з нього повернуться на склад, нотатки й конфіги зникнуть.'), t('Видалити'), async () => {
    const items = d.slots.map((s) => findItem(s.itemId)).filter(Boolean)
      .map((it) => logged({ ...it, status: 'stock', droneId: null }, t('Знято з «{d}» (дрон видалено)', { d: d.name })));
    const ph = dropPhotos([d.photoId, ...(d.notes ?? []).map((n) => n.photoId)].filter(Boolean));
    await save({ drones: { del: [d.id] }, items: { put: items }, ...ph });
    toast(t('Видалено'));
  });
}

function noteForm(d) {
  let file = null;
  const f = form([
    { name: 'date', label: t('Дата'), type: 'dmy', value: today(), required: true },
    { name: 'text', label: t('Текст'), type: 'textarea', rows: 5, required: true },
  ]);
  const pick = btn(t('Додати фото'), () => pickFile((x) => { file = x; pick.textContent = `✓ ${x.name}`; }));
  const close = sheet(t('Нотатка'), h('div', {}, f.el, h('div', { class: 'btn-row' }, pick)), {
    actions: [btn(t('Скасувати'), () => close()), btn(t('Зберегти'), async () => {
      if (invalidField(f)) return;
      const v = f.values();
      close();
      const p = file ? await newPhoto(file, d.id) : null;
      const note = { id: db.uid(), date: v.date, text: v.text, photoId: p?.id ?? null };
      const cur = findDrone(d.id);
      await save({ drones: { put: [{ ...cur, notes: [...(cur.notes ?? []), note] }] }, ...(p ? { photos: p.photos, blobs: p.blobs } : {}) }, [d.id]);
    }, 'primary')],
  });
}

function noteView(d, n) {
  const close = sheet(fmt.date(n.date), h('div', {},
    h('p', { class: 'pre' }, n.text),
    n.photoId && findPhoto(n.photoId) ? h('img', { class: 'drone-photo', src: findPhoto(n.photoId).thumb, alt: '', onclick: () => showPhoto(n.photoId, dronePhotos(findDrone(d.id) ?? d)) }) : null), {
    tools: [toolBtn('delete', t('Видалити'), () => confirmSheet(t('Видалити нотатку?'), '', t('Видалити'), async () => {
      close();
      const cur = findDrone(d.id);
      await save({ drones: { put: [{ ...cur, notes: cur.notes.filter((x) => x.id !== n.id) }] }, ...dropPhotos([n.photoId].filter(Boolean)) });
    }), 'danger')],
  });
}

function configForm(d) {
  const f = form([
    { name: 'name', label: t('Назва'), placeholder: 'Betaflight 4.5 · diff all', half: true },
    { name: 'date', label: t('Дата'), type: 'dmy', value: today(), half: true, required: true },
    { name: 'text', label: t('Текст (diff all / dump)'), type: 'textarea', rows: 10, required: true },
  ]);
  const close = sheet(t('Конфіг'), f.el, {
    actions: [btn(t('Скасувати'), () => close()), btn(t('Зберегти'), async () => {
      if (invalidField(f)) return;
      const v = f.values();
      close();
      const cur = findDrone(d.id);
      const c = { id: db.uid(), ...v };
      await save({ drones: { put: [{ ...cur, configs: [...(cur.configs ?? []), c] }] } }, [d.id]);
      // Одразу підсумок розбору: звідти — оновити прошивку польотника
      if (parseConfig(c.text)) configView(findDrone(d.id), c);
    }, 'primary')],
  });
}

/** Деталь у слоті польотника: FC, AIO чи стек (у самозборі стек часто стоїть у слоті регулятора). */
function fcItem(d) {
  const FC = ['fc', 'aio', 'stack'];
  return d.slots.map((s) => findItem(s.itemId)).find((it, i) => it && (FC.includes(d.slots[i].cat) || FC.includes(it.cat))) ?? null;
}

function configView(d, c) {
  const p = parseConfig(c.text);
  const fc = p?.label ? fcItem(d) : null;
  const close = sheet(c.name || t('Конфіг'), h('div', {},
    h('p', { class: 'muted small' }, fmt.date(c.date)),
    p ? box(t('З конфігу'), h('div', {},
      kv([[t('Прошивка'), p.label], [t('Ціль'), p.target], [t('Плата'), p.board], [t('Ім’я (craft_name)'), p.craft],
        [t('Приймач'), p.rx], [t('Протокол моторів'), p.motor], ['GPS', p.gps]]),
      fc && fc.fw !== p.label ? h('p', { class: 'muted small' }, t('У «{name}» записано: {fw}', { name: itemName(fc), fw: fc.fw || '—' })) : null,
      h('div', { class: 'btn-row' },
        fc && fc.fw !== p.label ? btn(t('Оновити прошивку польотника'), () => { close(); fwSheet(fc, p.label); }, 'primary') : null,
        p.craft && p.craft !== d.name ? btn(t('Назвати дрон «{name}»', { name: p.craft }), async () => {
          close();
          await save({ drones: { put: [logged({ ...findDrone(d.id), name: p.craft }, t('Перейменовано: {from} → {to}', { from: d.name, to: p.craft }))] } }, [d.id]);
        }) : null))) : null,
    h('pre', { class: 'config' }, c.text)), {
    actions: [btn(t('Скопіювати'), () => copyText(c.text), 'primary')],
    tools: [toolBtn('delete', t('Видалити'), () => confirmSheet(t('Видалити конфіг?'), '', t('Видалити'), async () => {
      close();
      const cur = findDrone(d.id);
      await save({ drones: { put: [{ ...cur, configs: cur.configs.filter((x) => x.id !== c.id) }] } });
    }), 'danger')],
  });
}

// ---------- склад ----------

const STOCK_SEGS = [['units', 'Деталі'], ['cons', 'Розхідники'], ['orders', 'Замовлення'], ['wish', 'Хочу']];
let stockSeg = STOCK_SEGS.some(([k]) => k === recall('fpv-log:stock-seg')) ? recall('fpv-log:stock-seg') : 'units';

const isLow = (it) => it.kind === 'consumable' && num(it.qty) <= num(it.low);

function itemRow(it) {
  const where = it.status === 'installed' ? findDrone(it.droneId)?.name : it.status === 'broken' ? it.reason : '';
  if (it.kind === 'consumable') {
    return row(itemName(it), catLabel(it.cat), `${fmt.num(it.qty)} ${t('шт')}`, () => itemDetail(it.id), { id: it.id, cls: isLow(it) ? 'low' : '', thumb: thumbImg(it.photoId, null) });
  }
  return row(itemName(it), [catLabel(it.cat), it.fw, fwHint(it), where].filter(Boolean).join(' · '), it.price ? fmt.money(it.price) : '', () => itemDetail(it.id), { id: it.id, thumb: thumbImg(it.photoId, null) });
}

// Відбір за дроном у «Хочу» й журналі польотів: «Усі» + дрони, що є в списку; спільний вибір, пам'ятається
let droneFilter = recall('fpv-log:drone-filter') ?? '';
const NO_DRONE = '-';

function droneFilterChips(list) {
  const ids = [...new Set(list.map((x) => x.droneId || NO_DRONE))];
  if (ids.length < 2) return null;
  const opts = ids.map((id) => [id, id === NO_DRONE ? t('Без дрона') : findDrone(id)?.name ?? '—']).sort((a, b) => collate(a[1], b[1]));
  const c = chips([['', t('Усі')], ...opts], ids.includes(droneFilter) ? droneFilter : '', (v) => { droneFilter = v; remember('fpv-log:drone-filter', v); render(); });
  c.classList.add('drone-filter');
  return c;
}

const byDroneFilter = (list) => list.filter((x) => !droneFilter || !list.some((y) => (y.droneId || NO_DRONE) === droneFilter) || (x.droneId || NO_DRONE) === droneFilter);

function renderStock() {
  const seg = chips(STOCK_SEGS.map(([k, l]) => [k, t(l)]), stockSeg, (v) => { stockSeg = v; remember('fpv-log:stock-seg', v); render(); });
  seg.classList.add('segmented', 'seg-fit');
  const byName = (a, b) => collate(catLabel(a.cat), catLabel(b.cat)) || collate(itemName(a), itemName(b));
  let body;
  if (stockSeg === 'orders') {
    const list = [...state.orders].sort((a, b) => collate(b.date, a.date));
    body = list.length ? h('div', { class: 'rows' }, list.map((o) =>
      row(o.shop || t('Замовлення'), `${fmt.date(o.date)} · ${t('позицій: {n}', { n: o.lines.length })}`, fmt.money(orderTotal(o)), () => orderForm(o), { id: o.id })))
      : empty(t('Замовлень немає'), t('Покупка — це замовлення: магазин, дата, позиції й доставка. Позиції одразу лягають на склад.'));
  } else if (stockSeg === 'wish') {
    const all = state.wishes;
    const list = byDroneFilter(all);
    // Групи за дроном із сумою: одразу видно, скільки коштує збірка
    const groups = [...new Set(list.map((w) => w.droneId || NO_DRONE))]
      .map((id) => [id, id === NO_DRONE ? t('Без дрона') : findDrone(id)?.name ?? '—']).sort((a, b) => collate(a[1], b[1]));
    const total = (ws) => ['UAH', 'USD'].map((c) => {
      const s = ws.reduce((n, w) => n + (w.currency === c ? num(w.price) : 0), 0);
      return s ? `${fmt.num(s)} ${c === 'USD' ? '$' : t('грн')}` : null;
    }).filter(Boolean).join(' + ');
    body = all.length ? h('div', {}, droneFilterChips(all), groups.map(([id, name]) => {
      const ws = list.filter((w) => (w.droneId || NO_DRONE) === id).sort((a, b) => collate(a.name, b.name));
      return box([name, ws.length, total(ws)].filter(Boolean).join(' · '), h('div', { class: 'rows' }, ws.map(wishRow)));
    }))
      : empty(t('Список «Хочу купити» порожній'), t('Що придивилися: назва, посилання, орієнтовна ціна й для якого дрона. Одним дотиком — у чернетку замовлення.'),
        [btn(t('Додати'), () => wishForm(), 'primary add')]);
  } else if (stockSeg === 'cons') {
    const list = state.items.filter((it) => it.kind === 'consumable').sort(byName);
    body = list.length ? h('div', { class: 'rows' }, list.map(itemRow))
      : empty(t('Розхідників немає'), t('Пропелери, ремінці, гвинти — кількістю, з порогом «мало».'));
  } else {
    const units = state.items.filter((it) => it.kind !== 'consumable').sort(byName);
    body = units.length ? h('div', {}, Object.keys(STATUS).map((st) => {
      const list = units.filter((it) => (it.status ?? 'stock') === st);
      return list.length ? box(`${t(STATUS[st])} · ${list.length}`, h('div', { class: 'rows' }, list.map(itemRow))) : null;
    })) : empty(t('Склад порожній'), t('Додайте замовлення або деталь, що вже була, кнопкою «+».'));
  }
  return h('div', {}, staleBanner(),
    h('section', { class: 'hero' }, h('div', { class: 'hero-label' }, t('Вкладено в хобі')), h('div', { class: 'hero-value' }, fmt.money(invested()))),
    seg, body);
}

function stockAddMenu() {
  if (stockSeg === 'wish') { wishForm(); return; }
  const close = sheet(t('Додати'), h('div', { class: 'btn-col' },
    btn(t('Замовлення'), () => { close(); orderForm(); }, 'primary'),
    btn(t('Деталь, що вже була'), () => { close(); itemForm(null, { preset: { kind: 'unit' } }); }),
    btn(t('Розхідник'), () => { close(); itemForm(null, { preset: { kind: 'consumable' } }); })));
}

// ---------- хочу купити ----------

function wishRow(w) {
  return h('div', { class: 'row slot', dataset: { id: w.id } },
    thumbImg(w.photoId, null),
    h('span', { class: 'row-main', onclick: () => wishForm(w) },
      h('span', { class: 'row-title' }, w.name),
      h('span', { class: 'muted small' }, [w.price ? `${fmt.num(w.price)} ${w.currency === 'USD' ? '$' : t('грн')}` : null, findDrone(w.droneId)?.name, w.note].filter(Boolean).join(' · '))),
    btn(t('У замовлення'), () => wishToOrder(w), 'quiet'));
}

/** Чернетка замовлення з побажання: магазин — з адреси посилання, позиція — назва й ціна; збереження прибирає побажання. */
function wishToOrder(w) {
  let shop = '';
  try { shop = new URL(w.link).hostname.replace(/^www\./, ''); } catch { /* без посилання */ }
  orderForm(null, {
    wishId: w.id, shop, currency: w.currency, note: [w.link, w.note].filter(Boolean).join(' · '),
    lines: [{ kind: 'unit', cat: 'other', model: w.name, price: w.price, qty: 1 }],
  });
}

function wishForm(w = null, { draft = null, file = null } = {}) {
  const src = w ?? draft;
  let currency = src?.currency ?? 'UAH';
  const f = form([
    { name: 'name', label: t('Що'), value: src?.name, required: true, placeholder: t('напр. DJI O4 Air Unit') },
    { name: 'link', label: t('Посилання'), value: src?.link, placeholder: 'https://' },
    { name: 'price', label: t('Орієнтовна ціна'), type: 'number', value: src?.price, half: true },
    { name: 'droneId', label: t('Для якого дрона'), type: 'select', half: true, value: src?.droneId ?? '',
      options: [['', '—'], ...[...state.drones].sort((a, b) => collate(a.name, b.name)).map((d) => [d.id, d.name])] },
    { name: 'note', label: t('Нотатка'), type: 'textarea', rows: 2, value: src?.note },
  ]);
  const cur = chips([['UAH', 'грн'], ['USD', '$']], currency, (v) => { currency = v; });
  cur.classList.add('segmented');
  const pic = photoPicker(w?.photoId, {
    file, query: () => f.inputs.name.value,
    onSearch: () => remember(PHOTO_FOR, JSON.stringify({ kind: 'wish', id: w?.id ?? null, draft: w ? null : { ...f.values(), currency } })),
  });
  const close = sheet(w ? t('Хочу купити') : t('Нове бажання'), h('div', {}, pic.el, f.el, h('div', { class: 'field-label' }, t('Валюта')), cur), {
    tools: w ? [toolBtn('delete', t('Видалити'), () => confirmSheet(t('Видалити «{name}»?', { name: w.name }), '', t('Видалити'), async () => {
      close();
      await save({ wishes: { del: [w.id] } });
    }), 'danger')] : [],
    actions: [btn(t('Скасувати'), () => close()), btn(t('Зберегти'), async () => {
      if (invalidField(f)) return;
      const v = f.values();
      const rec = { ...(w ?? { id: db.uid(), created: Date.now() }), ...v, droneId: v.droneId || null, currency };
      close();
      const [withPhoto, ph] = await photoChanges(rec, pic.value());
      await save({ wishes: { put: [withPhoto] }, ...ph }, [rec.id]);
    }, 'primary')],
  });
}

/** Деталь чи розхідник без замовлення («вже було») або правка наявного. onSaved — новий запис (для «Замінити»). */
/** preset — поля нової деталі (категорія з «Замінити» чи чернетка, з якою пішли шукати фото); file — картинка з «Поділитися». */
function itemForm(it = null, { preset = {}, onSaved = null, file = null } = {}) {
  const src = it ?? preset;
  const kind = src.kind ?? 'unit';
  const cons = kind === 'consumable';
  const fields = [
    { name: 'cat', label: t('Категорія'), type: 'select', options: catOptions(), value: src.cat ?? (cons ? 'props' : 'other') },
    { name: 'brand', label: t('Бренд'), value: src.brand, half: true },
    { name: 'model', label: t('Модель'), value: src.model, half: true, required: true },
    { name: 'specs', label: t('Характеристики'), type: 'textarea', rows: 2, value: src.specs },
  ];
  if (cons) fields.push({ name: 'qty', label: t('Кількість'), type: 'number', value: src.qty ?? 1, half: true }, { name: 'low', label: t('Поріг «мало»'), type: 'number', value: src.low ?? 0, half: true });
  else if (!it) fields.push({ name: 'fw', label: t('Прошивка'), placeholder: 'Betaflight 4.5.1', value: src.fw });
  if (!it?.orderId) fields.push({ name: 'price', label: t('Ціна, грн'), type: 'number', value: src.price, half: true }, { name: 'buyDate', label: t('Куплено'), type: 'dmy', value: src.buyDate, half: true });
  const f = form(fields);
  const name = () => `${f.inputs.brand.value} ${f.inputs.model.value}`.trim();
  // Характеристики — з сайту виробника чи магазину: пошук у Google за брендом і моделлю, текст вставляють у поле
  f.inputs.specs.closest('.field').after(h('div', { class: 'specs-find' }, btn(`🔍 ${t('Характеристики')}`, () => {
    if (!name()) { toast(t('Спершу впишіть назву')); return; }
    window.open(`https://www.google.com/search?q=${encodeURIComponent(`${name()} ${t('характеристики')}`)}`, '_blank', 'noopener');
  }, 'mini')));
  const pic = photoPicker(it?.photoId, {
    file, query: name,
    onSearch: () => remember(PHOTO_FOR, JSON.stringify({ kind: 'item', id: it?.id ?? null, draft: it ? null : { ...f.values(), kind } })),
  });
  const close = sheet(it ? t('Змінити') : cons ? t('Розхідник') : t('Деталь, що вже була'), h('div', {},
    pic.el, it?.orderId ? h('p', { class: 'muted small' }, t('Ціна й дата — із замовлення.')) : null, f.el), {
    actions: [btn(t('Скасувати'), () => close()), btn(t('Зберегти'), async () => {
      if (invalidField(f)) return;
      const v = f.values();
      const rec = it ? { ...it, ...v } : {
        id: db.uid(), created: Date.now(), kind, status: 'stock', ...v, fwLog: [],
        history: [{ date: today(), text: t('Додано на склад') }],
      };
      if (cons) { rec.qty = num(v.qty); rec.low = num(v.low); }
      close();
      const [withPhoto, ph] = await photoChanges(rec, pic.value());
      await save({ items: { put: [withPhoto] }, ...ph }, [rec.id]);
      if (!it) onSaved?.(rec);
    }, 'primary')],
  });
}

function itemDetail(id) {
  const build = () => { const it = findItem(id); return it ? itemBody(it) : null; };
  sheet(() => itemName(findItem(id)), build(), {
    live: build,
    tools: [toolBtn('edit', t('Змінити'), () => itemForm(findItem(id))), toolBtn('delete', t('Видалити'), () => removeItem(findItem(id)), 'danger')],
  });
}

function itemBody(it) {
  const o = it.orderId ? findOrder(it.orderId) : null;
  const drone = it.status === 'installed' ? findDrone(it.droneId) : null;
  const cons = it.kind === 'consumable';
  const photo = findPhoto(it.photoId);
  const actions = cons ? [btn(t('Списати'), () => qtySheet(it, -1)), btn(t('Додати'), () => qtySheet(it, 1))]
    : it.status === 'installed' ? []
      : [btn(t('Прошивка'), () => fwSheet(it)),
        it.status !== 'stock' ? btn(t('На склад'), () => setStatus(it, 'stock', {}, t('Повернуто на склад'))) : null,
        it.status !== 'broken' ? btn(t('Зламана'), () => brokenSheet(it)) : null,
        it.status !== 'sold' ? btn(t('Продано / списано'), () => soldSheet(it)) : null];
  return h('div', {},
    photo ? h('img', { class: 'drone-photo', src: photo.thumb, alt: '', onclick: () => showPhoto(photo.id) }) : null,
    kv([
      [t('Категорія'), catLabel(it.cat)],
      cons ? [t('Кількість'), h('span', { class: isLow(it) ? 'warn-text' : '' }, `${fmt.num(it.qty)} ${t('шт')}${isLow(it) ? ` · ${t('мало')}` : ''}`)] : [t('Стан'), t(STATUS[it.status ?? 'stock'])],
      drone ? [t('Дрон'), h('button', { type: 'button', class: 'link-btn', onclick: () => droneDetail(drone.id) }, drone.name)] : null,
      it.status === 'broken' ? [t('Причина'), it.reason] : null,
      it.status === 'sold' ? [t('Продано'), `${fmt.money(it.soldPrice)}${it.soldDate ? ` · ${fmt.date(it.soldDate)}` : ''}`] : null,
      cons ? null : [t('Прошивка'), it.fw ? h('span', {}, it.fw, fwHint(it) ? h('span', { class: 'fw-new' }, ` · ${fwHint(it)}`) : null) : null],
      [t('Ціна'), it.price ? fmt.money(it.price) : null],
      [t('Куплено'), [o?.shop, it.buyDate ? fmt.date(it.buyDate) : null].filter(Boolean).join(' · ')],
      [t('Характеристики'), it.specs ? h('span', { class: 'pre' }, it.specs) : null],
    ]),
    it.status === 'installed' ? h('p', { class: 'muted small' }, t('Зняти деталь — у картці дрона, кнопкою «Замінити».')) : null,
    actions.filter(Boolean).length ? h('div', { class: 'btn-row' }, actions) : null,
    it.fwLog?.length ? box(t('Прошивки'), h('ul', { class: 'changes' }, [...it.fwLog].reverse().map((x) => h('li', {}, `${fmt.date(x.date)}: ${x.from || '—'} → ${x.to}`)))) : null,
    it.history?.length ? fold('item-history', t('Історія'), historyList(it.history)) : null);
}

async function setStatus(it, status, extra, text) {
  await save({ items: { put: [logged({ ...it, status, droneId: null, brokeIn: null, ...extra }, text)] } }, [it.id]);
}

function brokenSheet(it) {
  const f = form([{ name: 'reason', label: t('Причина'), required: true }]);
  const close = sheet(t('Зламана'), f.el, {
    actions: [btn(t('Скасувати'), () => close()), btn(t('Зберегти'), () => {
      if (invalidField(f)) return;
      close();
      const { reason } = f.values();
      setStatus(it, 'broken', { reason }, t('Зламана: {r}', { r: reason }));
    }, 'primary')],
  });
}

function soldSheet(it) {
  const f = form([
    { name: 'soldPrice', label: t('Сума продажу, грн'), type: 'number', half: true, hint: t('0 — списано') },
    { name: 'soldDate', label: t('Дата'), type: 'dmy', value: today(), half: true },
  ]);
  const close = sheet(t('Продано / списано'), f.el, {
    actions: [btn(t('Скасувати'), () => close()), btn(t('Зберегти'), () => {
      if (invalidField(f)) return;
      close();
      const v = f.values();
      setStatus(it, 'sold', { soldPrice: num(v.soldPrice), soldDate: v.soldDate }, num(v.soldPrice) ? t('Продано за {sum}', { sum: fmt.money(v.soldPrice) }) : t('Списано'));
    }, 'primary')],
  });
}

function fwSheet(it, to = it.fw) {
  const f = form([
    { name: 'to', label: t('Нова версія'), value: to, required: true },
    { name: 'date', label: t('Дата'), type: 'dmy', value: today(), required: true },
  ]);
  const close = sheet(t('Прошивка'), f.el, {
    actions: [btn(t('Скасувати'), () => close()), btn(t('Зберегти'), async () => {
      if (invalidField(f)) return;
      const v = f.values();
      if (v.to === it.fw) { close(); return; }
      close();
      const rec = logged({ ...it, fw: v.to, fwLog: [...(it.fwLog ?? []), { date: v.date, from: it.fw ?? '', to: v.to }] },
        t('Прошивка: {from} → {to}', { from: it.fw || '—', to: v.to }), v.date);
      await save({ items: { put: [rec] } }, [it.id]);
    }, 'primary')],
  });
}

/** Ручне списання (sign −1) чи поповнення (+1) розхідника. */
function qtySheet(it, sign) {
  const f = form([{ name: 'n', label: t('Скільки'), type: 'number', value: 1, required: true }, { name: 'note', label: t('Примітка') }]);
  const close = sheet(sign < 0 ? t('Списати') : t('Додати'), f.el, {
    actions: [btn(t('Скасувати'), () => close()), btn(t('Зберегти'), async () => {
      if (invalidField(f)) return;
      const { n, note } = f.values();
      if (!(n > 0)) { fieldError(f.inputs.n, t('Більше нуля')); return; }
      close();
      const rec = logged({ ...it, qty: Math.max(0, num(it.qty) + sign * n) }, `${sign < 0 ? '−' : '+'}${fmt.num(n)} ${t('шт')}${note ? ` · ${note}` : ''}`);
      await save({ items: { put: [rec] } }, [it.id]);
    }, 'primary')],
  });
}

function removeItem(it) {
  if (it.status === 'installed') { toast(t('Спершу зніміть деталь із дрона («Замінити»)')); return; }
  if (it.orderId && findOrder(it.orderId)) { toast(t('Деталь із замовлення — приберіть позицію в самому замовленні')); return; }
  confirmSheet(t('Видалити «{name}»?', { name: itemName(it) }), t('Скасувати не можна.'), t('Видалити'), async () => {
    await save({ items: { del: [it.id] } });
    toast(t('Видалено'));
  });
}

// ---------- замовлення ----------

/**
 * Замовлення: шапка + позиції. Доставка розкидається на позиції пропорційно ціні; ціна деталі на складі —
 * у гривнях за курсом дня покупки. Штучна позиція ×N — N окремих деталей; розхідник — одна з кількістю;
 * «дрон чи шолом цілим» на склад не йде — його обирають у картці дрона як покупку.
 */
function orderForm(o = null, draft = null) {
  const prevLines = o?.lines ?? [];
  let currency = o?.currency ?? draft?.currency ?? 'UAH';
  const head = form([
    { name: 'shop', label: t('Магазин'), value: o?.shop ?? draft?.shop, required: true, half: true },
    { name: 'date', label: t('Дата'), type: 'dmy', value: o?.date ?? today(), required: true, half: true },
    { name: 'shipping', label: t('Доставка'), type: 'number', value: o?.shipping, half: true },
    { name: 'rate', label: t('Курс, грн за $'), type: 'number', value: o?.rate ?? rateOn(o?.date ?? today()), half: true },
    { name: 'note', label: t('Примітка'), value: o?.note ?? draft?.note },
  ]);
  const rateField = head.inputs.rate.closest('.field');
  const cur = chips([['UAH', 'грн'], ['USD', '$']], currency, (v) => { currency = v; rateField.hidden = v !== 'USD'; });
  cur.classList.add('segmented');
  rateField.hidden = currency !== 'USD';
  // Дата змінилась — курс НБУ на неї (якщо людина не вписала свій)
  head.inputs.date.addEventListener('blur', () => {
    const iso = head.values().date;
    if (iso && typeof iso === 'string') head.inputs.rate.value = String(rateOn(iso) ?? head.inputs.rate.value);
  });
  const lines = h('div', { class: 'lines' });
  const lineForms = [];
  const addLine = (l = {}) => {
    const lf = form([
      { name: 'kind', label: t('Вид'), type: 'select', options: [['unit', t('Деталь')], ['consumable', t('Розхідник')], ['drone', t('Дрон чи шолом цілим')]], value: l.kind ?? 'unit', half: true },
      { name: 'cat', label: t('Категорія'), type: 'select', options: catOptions(), value: l.cat ?? 'other', half: true },
      { name: 'brand', label: t('Бренд'), value: l.brand, half: true },
      { name: 'model', label: t('Модель'), value: l.model, half: true, required: true },
      { name: 'price', label: t('Ціна за шт.'), type: 'number', value: l.price, half: true, required: true },
      { name: 'qty', label: t('Кількість'), type: 'number', value: l.qty ?? 1, half: true, required: true },
    ]);
    const entry = { id: l.id ?? db.uid(), itemIds: l.itemIds ?? [], f: lf };
    const el = h('div', { class: 'line' }, lf.el, h('button', { type: 'button', class: 'link-btn', onclick: () => { lineForms.splice(lineForms.indexOf(entry), 1); el.remove(); } }, t('Прибрати позицію')));
    lineForms.push(entry);
    lines.append(el);
  };
  prevLines.forEach(addLine);
  draft?.lines.forEach(addLine);
  if (!prevLines.length && !draft) addLine();
  const close = sheet(o ? t('Замовлення') : t('Нове замовлення'), h('div', {},
    h('div', { class: 'field-label' }, t('Валюта')), cur, head.el,
    h('h3', {}, t('Позиції')), lines,
    h('div', { class: 'btn-row' }, btn(t('+ Позиція'), () => addLine()))), {
    tools: o ? [toolBtn('delete', t('Видалити'), () => removeOrder(o, close), 'danger')] : [],
    actions: [btn(t('Скасувати'), () => close()), btn(t('Зберегти'), async () => {
      if (invalidField(head) || lineForms.some(({ f }) => invalidField(f))) return;
      if (!lineForms.length) { formError(t('Додайте хоча б одну позицію')); return; }
      const v = head.values();
      if (currency === 'USD' && !(v.rate > 0)) { fieldError(head.inputs.rate, t('Вкажіть курс')); return; }
      const rec = {
        ...(o ?? { id: db.uid(), created: Date.now() }), shop: v.shop, date: v.date, currency, rate: currency === 'USD' ? v.rate : null,
        shipping: num(v.shipping), note: v.note,
        lines: lineForms.map(({ id, itemIds, f }) => { const x = f.values(); return { id, itemIds, ...x, price: num(x.price), qty: Math.max(1, Math.round(num(x.qty))) }; }),
      };
      try {
        const changes = orderChanges(rec, prevLines);
        // Куплене з «Хочу купити» зі списку прибирається
        if (draft?.wishId) changes.wishes = { del: [draft.wishId] };
        close();
        await save(changes, [rec.id]);
      } catch (err) {
        formError(err.message);
      }
    }, 'primary')],
  });
}

/** Зміни для бази: замовлення й деталі його позицій. Кидає помилку, якщо прибрати треба деталь не зі складу. */
function orderChanges(o, prevLines) {
  const put = [];
  const del = [];
  const busy = (it) => it.kind === 'unit' && it.status !== 'stock';
  for (const pl of prevLines) {
    const l = o.lines.find((x) => x.id === pl.id);
    if (l && l.kind === (pl.kind ?? 'unit')) continue;
    // Позицію прибрали чи змінили їй вид (деталь ↔ розхідник ↔ дрон) — старі записи складу йдуть, нові створяться нижче
    for (const it of pl.itemIds.map(findItem).filter(Boolean)) {
      if (busy(it)) throw new Error(t('«{name}» не на складі — позицію не прибрати', { name: itemName(it) }));
      del.push(it.id);
    }
    if (l) l.itemIds = [];
  }
  const bought = t('Куплено: {shop}', { shop: o.shop });
  for (const l of o.lines) {
    if (l.kind === 'drone') { l.itemIds = []; continue; }
    const prev = prevLines.find((x) => x.id === l.id && (x.kind ?? 'unit') === l.kind);
    const renamed = !prev || prev.brand !== l.brand || prev.model !== l.model || prev.cat !== l.cat;
    const base = { orderId: o.id, buyDate: o.date, ...(renamed ? { cat: l.cat, brand: l.brand, model: l.model } : {}) };
    const unitUah = lineUah(o, l);
    const ids = l.itemIds.filter((id) => findItem(id));
    if (l.kind === 'consumable') {
      const it = findItem(ids[0]);
      const rec = it ? { ...it, ...base, qty: Math.max(0, num(it.qty) + l.qty - num(prev?.qty)) }
        : { id: db.uid(), created: Date.now(), kind: 'consumable', status: 'stock', low: 0, cat: l.cat, brand: l.brand, model: l.model, ...base, qty: l.qty, history: [{ date: o.date, text: bought }] };
      put.push({ ...rec, price: round2(unitUah * l.qty) });
      l.itemIds = [rec.id];
      continue;
    }
    while (ids.length > l.qty) {
      const at = ids.findLastIndex((id) => !busy(findItem(id)));
      if (at < 0) throw new Error(t('Деталі позиції «{name}» не на складі — кількість не зменшити', { name: l.model }));
      del.push(ids.splice(at, 1)[0]);
    }
    for (const id of ids) put.push({ ...findItem(id), ...base, price: unitUah });
    while (ids.length < l.qty) {
      const rec = { id: db.uid(), created: Date.now(), kind: 'unit', status: 'stock', cat: l.cat, brand: l.brand, model: l.model, ...base, price: unitUah, fwLog: [], history: [{ date: o.date, text: bought }] };
      ids.push(rec.id);
      put.push(rec);
    }
    l.itemIds = ids;
  }
  return { orders: { put: [o] }, items: { put, del } };
}

function removeOrder(o, closeForm) {
  confirmSheet(t('Видалити замовлення?'), t('Деталі з нього теж зникнуть зі складу.'), t('Видалити'), async () => {
    const items = o.lines.flatMap((l) => l.itemIds).map(findItem).filter(Boolean);
    const busy = items.find((it) => it.kind === 'unit' && it.status !== 'stock');
    if (busy) { toast(t('«{name}» не на складі — спершу зніміть чи поверніть', { name: itemName(busy) })); return; }
    await save({ orders: { del: [o.id] }, items: { del: items.map((it) => it.id) } });
    closeForm();
    toast(t('Видалено'));
  });
}

// ---------- батареї ----------

const batTitle = (b) => `#${b.num} · ${[b.brand, b.s && `${b.s}S`, b.mah && `${b.mah} ${t('мАг')}`, b.c && `${b.c}C`].filter(Boolean).join(' ')}`;

function renderBatteries() {
  const list = [...state.batteries].sort((a, b) => collate(a.num, b.num));
  const live = list.filter((b) => b.state !== 'dead');
  const dead = list.filter((b) => b.state === 'dead');
  const batRow = (b) => row(batTitle(b), [b.connector, batStateLabel(b.state), t('циклів: {n}', { n: b.cycles?.length ?? 0 })].filter(Boolean).join(' · '),
    '', () => batteryDetail(b.id), { id: b.id, cls: staleBatteries().includes(b) ? 'low' : '' });
  if (!list.length) return h('div', {}, empty(t('Батарей ще немає'), t('Кожна банка — окремий запис з номером. Додайте кнопкою «+».'), [btn(t('Додати'), () => batteryForm(), 'primary add')]));
  return h('div', {}, staleBanner(),
    h('div', { class: 'rows' }, live.map(batRow)),
    dead.length ? box(t('Списані'), h('div', { class: 'rows' }, dead.map(batRow))) : null,
    h('div', { class: 'btn-row' }, btn(t('Друк наклейок'), () => labelsSheet(live))));
}

// ---------- наклейки з QR ----------

/** Адреса батареї для QR: камера телефона відкриє застосунок одразу на «+ цикл». Хост — поточний, тож працює й не на GitHub Pages. */
const batUrl = (b) => `${location.origin}${location.pathname}#bat=${encodeURIComponent(b.id)}`;

/** Вибір батарей для друку (усі одразу позначені) → аркуш наклейок: великий номер, S і мАг, QR. */
function labelsSheet(list) {
  const picked = new Set(list.map((b) => b.id));
  const pick = h('div', { class: 'chips check' }, list.map((b) => h('button', {
    type: 'button', class: 'on', onclick: (e) => { if (!picked.delete(b.id)) picked.add(b.id); e.currentTarget.classList.toggle('on', picked.has(b.id)); },
  }, `#${b.num}`)));
  const close = sheet(t('Друк наклейок'), h('div', {},
    h('p', { class: 'muted small' }, t('QR веде на батарею: камера телефона відкриє застосунок одразу на «+ цикл».')), pick), {
    actions: [btn(t('Скасувати'), () => close()), btn(t('Друкувати'), async () => {
      const bats = list.filter((b) => picked.has(b.id));
      if (!bats.length) { toast(t('Позначте хоча б одну батарею')); return; }
      close();
      await printLabels(bats);
    }, 'primary')],
  });
}

async function printLabels(bats) {
  const { default: qrcode } = await import('./vendor/qrcode.js');
  const qr = (text) => {
    const q = qrcode(0, 'M');
    q.addData(text);
    q.make();
    const el = h('span', { class: 'label-qr' });
    el.innerHTML = q.createSvgTag({ cellSize: 1, margin: 2, scalable: true });
    return el;
  };
  const sheetEl = h('div', { id: 'labels' }, bats.map((b) => h('div', { class: 'label' },
    h('span', { class: 'label-text' }, h('b', {}, `#${b.num}`), h('span', {}, [b.s && `${b.s}S`, b.mah && `${b.mah} ${t('мАг')}`].filter(Boolean).join(' · ')),
      b.brand ? h('span', {}, b.brand) : null),
    qr(batUrl(b)))));
  document.getElementById('labels')?.remove();
  document.body.append(sheetEl);
  document.body.classList.add('printing');
  const done = () => { sheetEl.remove(); document.body.classList.remove('printing'); };
  window.addEventListener('afterprint', done, { once: true });
  window.print();
}

function batteryForm(b = null) {
  const nextNum = String(Math.max(0, ...state.batteries.map((x) => parseInt(x.num, 10) || 0)) + 1);
  const f = form([
    { name: 'num', label: t('Номер'), value: b?.num ?? nextNum, required: true, half: true },
    { name: 'brand', label: t('Бренд'), value: b?.brand, half: true },
    { name: 's', label: 'S', type: 'number', value: b?.s, half: true, required: true },
    { name: 'mah', label: t('мАг'), type: 'number', value: b?.mah, half: true, required: true },
    { name: 'c', label: 'C', type: 'number', value: b?.c, half: true },
    { name: 'connector', label: t('Роз’єм'), value: b?.connector, half: true, list: 'connectors' },
    { name: 'price', label: t('Ціна, грн'), type: 'number', value: b?.price, half: true },
    { name: 'buyDate', label: t('Куплено'), type: 'dmy', value: b?.buyDate, half: true },
  ]);
  const close = sheet(b ? t('Змінити') : t('Нова батарея'), h('div', {}, f.el, h('datalist', { id: 'connectors' }, CONNECTORS.map((c) => h('option', { value: c })))), {
    actions: [btn(t('Скасувати'), () => close()), btn(t('Зберегти'), async () => {
      if (invalidField(f)) return;
      const v = f.values();
      const rec = b ? { ...b, ...v } : { id: db.uid(), created: Date.now(), ...v, state: 'storage', stateAt: Date.now(), cycles: [] };
      close();
      await save({ batteries: { put: [rec] } }, [rec.id]);
    }, 'primary')],
  });
}

function batteryDetail(id) {
  const build = () => { const b = findBattery(id); return b ? batteryBody(b) : null; };
  sheet(() => (findBattery(id) ? batTitle(findBattery(id)) : ''), build(), {
    live: build,
    tools: [toolBtn('edit', t('Змінити'), () => batteryForm(findBattery(id))), toolBtn('delete', t('Видалити'), () => {
      const b = findBattery(id);
      confirmSheet(t('Видалити батарею #{n}?', { n: b.num }), t('Скасувати не можна.'), t('Видалити'), () => save({ batteries: { del: [id] } }));
    }, 'danger')],
  });
}

function batteryBody(b) {
  const states = chips(BAT_STATES.map(([k, l]) => [k, t(l)]), b.state, (v) => {
    if (v !== b.state) save({ batteries: { put: [{ ...b, state: v, stateAt: Date.now() }] } }, [b.id]);
  });
  states.classList.add('segmented', 'bat-states');
  const days = Math.floor((Date.now() - (b.stateAt ?? Date.now())) / 864e5);
  return h('div', {},
    kv([[t('Роз’єм'), b.connector], [t('Ціна'), b.price ? fmt.money(b.price) : null], [t('Куплено'), b.buyDate ? fmt.date(b.buyDate) : null],
      [t('Циклів'), String(b.cycles?.length ?? 0)], [t('У цьому стані'), t('{n} дн.', { n: days })]]),
    h('div', { class: 'field-label' }, t('Стан')), states,
    h('div', { class: 'btn-row' }, btn(t('+ цикл'), () => cycleSheet(b), 'primary')),
    irBox(b),
    b.cycles?.length ? box(t('Цикли'), h('ul', { class: 'changes' }, [...b.cycles].reverse().map((c) => h('li', {},
      [fmt.date(c.date), c.flightId && t('політ'), c.v && `${c.v} ${t('В/банку')}`, c.ir && `IR ${c.ir} ${t('мОм')}`].filter(Boolean).join(' · '))))) : null);
}

/** IR банок із рядка «4, 4, 5, 4» — мОм, лише додатні числа. */
const irCells = (s) => String(s ?? '').split(/[\s,;/]+/).map(Number).filter((x) => x > 0);

/** IR: лінії середнього й найгіршої банки за циклами, де його міряли, і останні значення по банках. */
function irBox(b) {
  const pts = (b.cycles ?? []).map((c) => ({ date: c.date, cells: irCells(c.ir) })).filter((p) => p.cells.length)
    .map((p) => ({ ...p, avg: p.cells.reduce((n, x) => n + x, 0) / p.cells.length, max: Math.max(...p.cells) }));
  if (!pts.length) return null;
  const last = pts.at(-1).cells;
  const sorted = [...last].sort((x, y) => x - y);
  const median = (sorted[(sorted.length - 1) >> 1] + sorted[sorted.length >> 1]) / 2;
  // Банка з IR понад півтори медіани пакета — перша ознака, що вона здає
  const bad = (v) => last.length > 1 && v > 1.5 * median;
  const f1 = (v) => fmt.num(Math.round(v * 10) / 10);
  let chart = null;
  if (pts.length > 1) {
    const lo = Math.min(...pts.map((p) => p.avg));
    const hi = Math.max(...pts.map((p) => p.max));
    const x = (i) => ((i * 100) / (pts.length - 1)).toFixed(2);
    const y = (v) => (37 - ((v - lo) / (hi - lo || 1)) * 34).toFixed(2);
    const line = (key, cls) => `<polyline class="${cls}" points="${pts.map((p, i) => `${x(i)},${y(p[key])}`).join(' ')}"/>`;
    const svg = h('div', { class: 'ir-plot' });
    svg.innerHTML = `<svg viewBox="0 0 100 40" preserveAspectRatio="none" aria-hidden="true">${line('max', 'ir-max')}${line('avg', 'ir-avg')}</svg>`;
    chart = h('div', { class: 'ir-chart', role: 'img', 'aria-label': t('IR: середній {a} → {b} мОм', { a: f1(pts[0].avg), b: f1(pts.at(-1).avg) }) },
      h('div', { class: 'ir-y muted small' }, h('span', {}, f1(hi)), h('span', {}, f1(lo))), svg,
      h('div', { class: 'ir-x muted small' }, h('span', {}, fmt.date(pts[0].date)), h('span', {}, fmt.date(pts.at(-1).date))),
      h('div', { class: 'ir-legend small' }, h('span', { class: 'ir-avg' }, t('середній')), h('span', { class: 'ir-max' }, t('найгірша банка'))));
  }
  return box(t('IR, мОм'), h('div', {}, chart,
    h('div', { class: 'field-label' }, t('Останній замір по банках · {date}', { date: fmt.date(pts.at(-1).date) })),
    h('div', { class: 'ir-cells' }, last.map((v, i) => h('span', { class: `ir-cell${bad(v) ? ' bad' : ''}` }, h('small', {}, String(i + 1)), f1(v)))),
    last.some(bad) ? h('p', { class: 'warn-text small' }, t('Банка {n}: IR понад 1,5× медіани пакета ({m} мОм) — стежте за нею', { n: last.map((v, i) => (bad(v) ? i + 1 : null)).filter(Boolean).join(', '), m: f1(median) })) : null));
}

function cycleSheet(b) {
  let after = 'storage';
  const f = form([
    { name: 'date', label: t('Дата'), type: 'dmy', value: today(), required: true },
    { name: 'v', label: t('Залишкова напруга, В/банку'), placeholder: '3.75', half: true },
    { name: 'ir', label: t('IR по банках, мОм'), placeholder: '4, 4, 5, 4', half: true },
  ]);
  const st = chips(BAT_STATES.slice(0, 3).map(([k, l]) => [k, t(l)]), after, (v) => { after = v; });
  st.classList.add('segmented');
  const close = sheet(`${t('+ цикл')} · #${b.num}`, h('div', {}, f.el, h('div', { class: 'field-label' }, t('Стан після')), st), {
    actions: [btn(t('Скасувати'), () => close()), btn(t('Зберегти'), async () => {
      if (invalidField(f)) return;
      const v = f.values();
      close();
      await save({ batteries: { put: [{ ...b, cycles: [...(b.cycles ?? []), { id: db.uid(), ...v }], state: after, stateAt: Date.now() }] } }, [b.id]);
    }, 'primary')],
  });
}

// ---------- польоти ----------

const flightMin = (f) => (f.bats ?? []).reduce((n, x) => n + num(x.min), 0);
const batLabel = (id) => { const b = findBattery(id); return b ? `#${b.num}` : '—'; };

const FLIGHT_SEGS = [['log', 'Журнал'], ['stats', 'Статистика'], ['pre', 'Перед польотом']];
let flightSeg = FLIGHT_SEGS.some(([k]) => k === recall('fpv-log:flight-seg')) ? recall('fpv-log:flight-seg') : 'log';

function renderFlights() {
  const list = [...state.flights].sort((a, b) => collate(b.date, a.date) || num(b.created) - num(a.created));
  // Порожній журнал — без статистики, але «Перед польотом» потрібне й до першого польоту
  const segs = list.length ? FLIGHT_SEGS : FLIGHT_SEGS.filter(([k]) => k !== 'stats');
  const seg = chips(segs.map(([k, l]) => [k, t(l)]), segs.some(([k]) => k === flightSeg) ? flightSeg : 'log', (v) => { flightSeg = v; remember('fpv-log:flight-seg', v); render(); });
  seg.classList.add('segmented', 'seg-fit');
  if (flightSeg === 'pre') return h('div', {}, staleBanner(), seg, renderPreflight());
  if (!list.length) {
    return h('div', {}, staleBanner(), seg, empty(t('Польотів ще немає'), t('Політ: дата, місце, дрон і батареї з хвилинами. Кожна батарея отримає цикл, дрон — наліт.'),
      state.drones.length ? [btn(t('Додати'), () => flightForm(), 'primary add')] : []));
  }
  return h('div', {}, staleBanner(), seg, flightSeg === 'stats' ? renderStats() : h('div', {}, droneFilterChips(list), h('div', { class: 'rows' }, byDroneFilter(list).map((f) => row([findDrone(f.droneId)?.name ?? '—', f.place].filter(Boolean).join(' · '),
      [fmt.date(f.date), flightTypeLabel(f.type), f.bats.map((x) => batLabel(x.batteryId)).join(' '), f.crash ? `${t('падіння')}${f.broke ? `: ${f.broke}` : ''}` : ''].filter(Boolean).join(' · '),
      fmtMin(flightMin(f)), () => flightForm(f), { id: f.id, cls: f.crash ? 'low' : '' })))));
}

/** Горизонтальні смуги: [[підпис, значення]], довжина — частка найбільшого. */
function bars(list, format) {
  const max = Math.max(1, ...list.map(([, v]) => v));
  return h('div', { class: 'bars' }, list.map(([label, v]) => h('div', { class: 'bar-row' },
    h('span', { class: 'bar-label' }, label),
    h('span', { class: 'bar-track' }, h('span', { class: 'bar-fill', style: `width:${((v / max) * 100).toFixed(1)}%` })),
    h('span', { class: 'bar-val' }, format(v)))));
}

/** Статистика: польоти, наліт, ціна хвилини (вкладено ÷ хвилини), ремонт (вартість зламаних деталей), наліт за місяцями й дронами. */
function renderStats() {
  const mins = state.flights.reduce((n, f) => n + flightMin(f), 0);
  const repair = state.items.reduce((s, it) => s + (it.status === 'broken' ? num(it.price) : 0), 0);
  const stat = (label, value, cls = '') => h('div', { class: `stat ${cls}` }, h('div', { class: 'stat-value' }, value), h('div', { class: 'muted small' }, label));
  const sum = (key) => {
    const m = new Map();
    for (const f of state.flights) m.set(key(f), (m.get(key(f)) ?? 0) + flightMin(f));
    return m;
  };
  // Місяці — до 12 по останній місяць із польотами, порожні теж: видно перерви
  const byMonth = sum((f) => f.date.slice(0, 7));
  const months = [];
  const keys = [...byMonth.keys()].sort();
  for (let ym = keys.at(-1); ym >= keys[0] && months.length < 12;) {
    months.unshift([new Date(`${ym}-01T00:00:00`).toLocaleDateString(locale(), { month: 'short', year: '2-digit' }), byMonth.get(ym) ?? 0]);
    const [y, mo] = ym.split('-').map(Number);
    ym = mo > 1 ? `${y}-${String(mo - 1).padStart(2, '0')}` : `${y - 1}-12`;
  }
  const byDrone = [...sum((f) => f.droneId)].map(([id, v]) => [findDrone(id)?.name ?? t('Видалений дрон'), v]).sort((a, b) => b[1] - a[1]);
  return h('div', {},
    h('div', { class: 'stats wide' },
      stat(t('Польотів'), fmt.num(state.flights.length)),
      stat(t('Наліт'), fmtMin(mins)),
      stat(t('Хвилина польоту'), mins ? fmt.money(invested() / mins) : '—', 'accent'),
      stat(t('Ремонт (зламане)'), fmt.money(repair))),
    h('p', { class: 'muted small' }, t('Хвилина польоту — «Вкладено в хобі» ({sum}), поділене на хвилини нальоту.', { sum: fmt.money(invested()) })),
    box(t('Наліт за місяцями'), bars(months, fmtMin)),
    box(t('Наліт за дронами'), bars(byDrone, fmtMin)));
}

// ---------- перед польотом ----------

// Місце, останній прогноз і галочки — на пристрої (localStorage): погода в кожного своя, галочки — на сьогодні.
// Сам чекліст — у prefs, їде з Диском.
const PRE_PLACE = 'fpv-log:pre-place';
const PRE_CACHE = 'fpv-log:pre-cache';
const PRE_TICKS = 'fpv-log:pre-ticks';
const CHECKLIST = ['Пропелери затягнуті', 'GPS: є фікс, Rescue налаштовано', 'Напруга батарей', 'Failsafe перевірено', 'VTX: потужність і канал', 'Зона вільна, людей немає'];
const readJson = (key) => { try { return JSON.parse(recall(key)) ?? null; } catch { return null; } };
const placeKey = (p) => `${p.lat.toFixed(2)},${p.lon.toFixed(2)}`;
const checklist = () => prefs().checklist ?? CHECKLIST.map((x) => t(x));
let preLoading = false;
let preTried = 0;

/** Погода й Kp для місця → кеш; Kp не прийшов — лишається попередній. Інтерфейс не чекає: перемальовує, коли готово. */
async function loadWeather(place) {
  if (preLoading) return;
  preLoading = true;
  preTried = Date.now();
  try {
    const [w, k] = await Promise.allSettled([hourly(place), kpIndex()]);
    if (w.status === 'rejected') throw w.reason;
    remember(PRE_CACHE, JSON.stringify({ key: placeKey(place), at: Date.now(), hours: w.value, kp: k.value ?? readJson(PRE_CACHE)?.kp ?? null }));
  } catch {
    toast(t('Погода не оновилась — перевірте інтернет'));
  } finally {
    preLoading = false;
  }
  if (tab === 'flights' && flightSeg === 'pre') render();
}

function setPlace(p) {
  remember(PRE_PLACE, JSON.stringify(p));
  preTried = 0;
  loadWeather(p);
  render();
}

function locate() {
  if (!navigator.geolocation) { toast(t('Геолокація недоступна — виберіть місце вручну')); return; }
  toast(t('Визначаю місце…'));
  navigator.geolocation.getCurrentPosition(
    (pos) => setPlace({ label: t('Моє місце ({lat}, {lon})', { lat: pos.coords.latitude.toFixed(2), lon: pos.coords.longitude.toFixed(2) }), lat: pos.coords.latitude, lon: pos.coords.longitude }),
    () => toast(t('Не вдалося визначити місце — виберіть вручну')), { timeout: 15000, maximumAge: 600_000 });
}

function placeSheet() {
  const last = [...state.flights].sort((a, b) => collate(b.date, a.date))[0]?.place;
  const f = form([{ name: 'name', label: t('Місце'), placeholder: t('Назва села чи міста'), value: last }]);
  const found = h('div', { class: 'chips' });
  const close = sheet(t('Місце для погоди'), h('div', {}, f.el, found), {
    actions: [btn(t('Скасувати'), () => close()), btn(t('Знайти'), async () => {
      const name = String(f.values().name ?? '').trim();
      if (name.length < 2) { fieldError(f.inputs.name, t('Введіть назву')); return; }
      try {
        const list = await searchPlace(name, lang());
        if (!list.length) { fieldError(f.inputs.name, t('Нічого не знайдено — спробуйте інакше написати')); return; }
        found.replaceChildren(...list.map((p) => h('button', { type: 'button', onclick: () => { close(); setPlace(p); } }, p.label)));
      } catch {
        toast(t('Не вдалося знайти місце — перевірте інтернет'));
      }
    }, 'primary')],
  });
}

function checklistSheet() {
  const f = form([{ name: 'list', label: t('Пункти — по одному в рядку'), type: 'textarea', rows: 8, value: checklist().join('\n') }]);
  const close = sheet(t('Чекліст'), f.el, {
    actions: [btn(t('Типовий'), async () => { close(); await save({ prefs: { put: [{ ...prefs(), checklist: null }] } }); }),
      btn(t('Зберегти'), async () => {
        const list = String(f.values().list ?? '').split('\n').map((x) => x.trim()).filter(Boolean);
        close();
        await save({ prefs: { put: [{ ...prefs(), checklist: list.length ? list : null }] } });
      }, 'primary')],
  });
}

/** «Перед польотом»: вердикт за вітром, поривами, опадами, морозом і Kp на 3 години, погодинна таблиця й чекліст. */
function renderPreflight() {
  const place = readJson(PRE_PLACE);
  const cache = readJson(PRE_CACHE);
  const mine = place && cache?.key === placeKey(place) ? cache : null;
  // Старіше 20 хвилин — оновити, але не частіше раз на 5 хвилин: офлайн не смикає мережу з кожним перемальовуванням
  if (place && (!mine || Date.now() - mine.at > 1_200_000) && Date.now() - preTried > 300_000) loadWeather(place);
  const ms = (v) => fmt.num(Math.round(v * 10) / 10);
  const head = h('div', { class: 'pre-place' },
    h('span', { class: 'row-title' }, place ? place.label : t('Місце не вибрано')),
    h('div', { class: 'btn-row' }, btn(t('Моє місце'), locate), btn(t('Інше місце'), placeSheet),
      place ? btn(preLoading ? t('Оновлюю…') : t('Оновити'), () => { preTried = 0; loadWeather(place); render(); }, 'quiet') : null));
  let weather;
  if (mine?.hours.length) {
    const v = verdict(mine.hours, mine.kp?.kp ?? null);
    const WHY = { вітер: t('вітер {v} м/с'), пориви: t('пориви {v} м/с'), опади: t('опади {v} мм/год'), Kp: 'Kp {v}', мороз: t('мороз {v} °C') };
    const kp = mine.kp?.kp;
    const kpState = kp >= LIMITS.kp[1] ? t('магнітна буря, GPS і компас можуть брехати') : kp >= LIMITS.kp[0] ? t('збурення') : t('спокійно');
    weather = h('div', {},
      h('div', { class: `verdict ${v.level}` },
        h('b', {}, { green: t('Можна літати'), yellow: t('Обережно'), red: t('Краще не літати') }[v.level]),
        h('span', {}, v.why.length ? v.why.map(([k, x]) => WHY[k].replace('{v}', ms(x))).join(' · ') : t('Найближчі 3 години — у межах порогів'))),
      h('div', { class: 'wx' },
        [t('Час'), '°C', t('10 м'), t('80 м'), t('120 м'), t('Пориви'), t('Опади')].map((x) => h('b', {}, x)),
        mine.hours.flatMap((x) => [x.time.slice(11, 16), ms(x.t), ms(x.w10), ms(x.w80), ms(x.w120), ms(x.g), x.p ? ms(x.p) : x.pp ? `${x.pp}%` : '—'].map((c) => h('span', {}, c)))),
      h('p', { class: 'muted small' }, [
        t('Вітер і пориви — м/с, опади — мм/год (або ймовірність).'),
        kp === undefined ? t('Kp недоступний.') : t('Kp {kp} — {state} (NOAA, {at} UTC).', { kp: ms(kp), state: kpState, at: String(mine.kp.at).slice(11, 16) }),
        t('Оновлено {time}.', { time: shortWhen(mine.at) })].join(' ')),
      h('p', { class: 'muted small' }, t('Пороги на найближчі 3 години (жовтий / червоний): вітер на 10 м {w} м/с, пориви {g} м/с, опади {r} мм/год, Kp {k}; мороз — жовтий (LiPo гріти).',
        { w: LIMITS.wind.join(' / '), g: LIMITS.gust.join(' / '), r: LIMITS.rain.map(fmt.num).join(' / '), k: LIMITS.kp.join(' / ') })));
  } else {
    weather = h('p', { class: 'muted' }, !place ? t('Виберіть місце — з телефона чи назвою: буде вітер на висотах, пориви, опади й Kp.')
      : preLoading ? t('Завантажую погоду…') : t('Погоди ще немає — потрібен інтернет.'));
  }
  const ticks = readJson(PRE_TICKS);
  const done = new Set(ticks?.date === today() ? ticks.done : []);
  const items = checklist();
  const count = h('span', {});
  const recount = () => { count.textContent = ` · ${items.filter((x) => done.has(x)).length} / ${items.length}`; };
  recount();
  return h('div', {}, head, weather,
    box([t('Чекліст'), count], h('div', {}, items.map((x) => h('label', { class: 'check' },
      h('input', {
        type: 'checkbox', checked: done.has(x), onchange: (e) => {
          if (e.target.checked) done.add(x); else done.delete(x);
          remember(PRE_TICKS, JSON.stringify({ date: today(), done: [...done] }));
          recount();
        },
      }), h('span', {}, x))),
    h('p', { class: 'muted small' }, t('Галочки скидаються щодня.')), h('div', { class: 'btn-row' }, btn(t('Змінити чекліст'), checklistSheet, 'quiet')))));
}

/** Політ: батареї з хвилинами; кожна отримує цикл (cycles[].flightId), наліт дрона рахується з польотів. */
function flightForm(f = null) {
  const drones = state.drones.filter((d) => d.group !== 'ground').sort((a, b) => collate(a.name, b.name));
  if (!drones.length) { toast(t('Спершу додайте дрон')); return; }
  const lastDrone = recall('fpv-log:flight-drone');
  const places = [...new Set([...state.flights].sort((a, b) => collate(b.date, a.date)).map((x) => x.place).filter(Boolean))].slice(0, 15);
  let type = f?.type ?? 'freestyle';
  let crash = f?.crash ? 'yes' : 'no';
  const head = form([
    { name: 'date', label: t('Дата'), type: 'dmy', value: f?.date ?? today(), required: true, half: true },
    { name: 'place', label: t('Місце'), value: f?.place ?? places[0], list: 'places', half: true },
    { name: 'droneId', label: t('Дрон'), type: 'select', options: drones.map((d) => [d.id, d.name]),
      value: f?.droneId ?? (drones.some((d) => d.id === lastDrone) ? lastDrone : drones[0].id) },
  ]);
  const types = chips(FLIGHT_TYPES.map(([k, l]) => [k, t(l)]), type, (v) => { type = v; });
  types.classList.add('segmented');
  // Батареї: номер (або без номера — лише хвилини) і хвилини; нова — наступна ще не вибрана
  const usable = [...state.batteries].filter((b) => b.state !== 'dead' || f?.bats.some((x) => x.batteryId === b.id)).sort((a, b) => collate(a.num, b.num));
  const bats = h('div', { class: 'lines' });
  const batForms = [];
  const addBat = (x = {}) => {
    const used = batForms.map((e) => e.f.values().batteryId);
    const bf = form([
      { name: 'batteryId', label: t('Батарея'), type: 'select', half: true, options: [['', t('Без номера')], ...usable.map((b) => [b.id, batTitle(b)])],
        value: x.batteryId !== undefined ? x.batteryId ?? '' : usable.find((b) => !used.includes(b.id))?.id ?? '' },
      { name: 'min', label: t('Хвилин'), type: 'number', value: x.min, half: true, required: true },
    ]);
    const entry = { f: bf };
    const el = h('div', { class: 'line' }, bf.el, h('button', { type: 'button', class: 'link-btn', onclick: () => { batForms.splice(batForms.indexOf(entry), 1); el.remove(); } }, t('Прибрати')));
    batForms.push(entry);
    bats.append(el);
  };
  (f?.bats.length ? f.bats : [{}]).forEach(addBat);
  // Падіння: що зламалось і, за бажанням, яку деталь зняти зламаною (звичне «Замінити»)
  const crashForm = form([
    { name: 'broke', label: t('Що зламалось'), value: f?.broke, placeholder: t('напр. пропелер, вал мотора') },
    { name: 'slotId', label: t('Позначити деталь зламаною'), type: 'select', options: [] },
  ]);
  const fillSlots = () => {
    const d = findDrone(head.inputs.droneId.value);
    crashForm.inputs.slotId.replaceChildren(...selectOptions([['', t('— ні —')],
      ...(d?.slots ?? []).filter((sl) => findItem(sl.itemId)).map((sl) => [sl.id, `${slotLabel(sl)}: ${itemName(findItem(sl.itemId))}`])], ''));
  };
  fillSlots();
  head.inputs.droneId.addEventListener('change', fillSlots);
  crashForm.el.hidden = crash !== 'yes';
  const crashChips = chips([['no', t('Без падіння')], ['yes', t('Падіння')]], crash, (v) => { crash = v; crashForm.el.hidden = v !== 'yes'; });
  crashChips.classList.add('segmented');
  const note = form([{ name: 'note', label: t('Нотатка'), type: 'textarea', rows: 3, value: f?.note }]);
  const close = sheet(f ? t('Політ') : t('Новий політ'), h('div', {},
    head.el, h('datalist', { id: 'places' }, places.map((p) => h('option', { value: p }))),
    h('div', { class: 'field-label' }, t('Тип')), types,
    h('h3', {}, t('Батареї')), bats, h('div', { class: 'btn-row' }, btn(t('+ Батарея'), () => addBat())),
    h('div', { class: 'field-label' }, t('Падіння')), crashChips, crashForm.el, note.el), {
    tools: f ? [toolBtn('delete', t('Видалити'), () => confirmSheet(t('Видалити політ?'), t('Цикли батарей із цього польоту теж приберуться.'), t('Видалити'), async () => {
      close();
      await save(flightChanges(null, f));
      toast(t('Видалено'));
      unbreakSheet(f);
    }), 'danger')] : [],
    actions: [btn(t('Скасувати'), () => close()), btn(t('Зберегти'), async () => {
      if (invalidField(head) || batForms.some(({ f: bf }) => invalidField(bf))) return;
      if (!batForms.length) { formError(t('Додайте хоча б одну батарею')); return; }
      const bad = batForms.find(({ f: bf }) => !(bf.values().min > 0));
      if (bad) { fieldError(bad.f.inputs.min, t('Більше нуля')); return; }
      const v = head.values();
      const c = crashForm.values();
      const rec = {
        ...(f ?? { id: db.uid(), created: Date.now() }), date: v.date, place: v.place, droneId: v.droneId, type,
        bats: batForms.map(({ f: bf }) => { const x = bf.values(); return { batteryId: x.batteryId || null, min: x.min }; }),
        crash: crash === 'yes', broke: crash === 'yes' ? c.broke : '', note: note.values().note,
      };
      remember('fpv-log:flight-drone', v.droneId);
      close();
      await save(flightChanges(rec, f), [rec.id]);
      if (rec.crash && c.slotId) replaceSheet(rec.droneId, c.slotId, { outcome: 'broken', flightId: rec.id, reason: [c.broke, t('падіння {date}', { date: fmt.date(rec.date) })].filter(Boolean).join(', ') });
    }, 'primary')],
  });
}

/**
 * Видалили політ, у падінні якого деталь позначили зламаною (і вона досі зламана) — запропонувати повернути:
 * у той самий слот, якщо він порожній, інакше на склад.
 */
function unbreakSheet(f) {
  const list = state.items.filter((it) => it.status === 'broken' && it.brokeIn?.flightId === f.id);
  if (!list.length) return;
  confirmSheet(t('Повернути деталі?'), t('У падінні цього польоту зламаними позначено: {list}. Повернути їх у слот (якщо він вільний) або на склад?', { list: list.map(itemName).join(', ') }), t('Повернути'), async () => {
    const drones = new Map();
    const items = list.map((it) => {
      const d = drones.get(it.brokeIn.droneId) ?? findDrone(it.brokeIn.droneId);
      const s = d?.slots.find((x) => x.id === it.brokeIn.slotId);
      const rec = { ...it, brokeIn: null, reason: null };
      if (!s || s.itemId) return logged({ ...rec, status: 'stock', droneId: null }, t('Політ видалено — повернуто на склад'));
      drones.set(d.id, logged({ ...d, slots: d.slots.map((x) => (x.id === s.id ? { ...x, itemId: it.id } : x)) }, `${slotLabel(s)}: — → ${itemName(it)} (${t('політ видалено')})`));
      return logged({ ...rec, status: 'installed', droneId: d.id }, t('Політ видалено — повернуто на «{d}» ({slot})', { d: d.name, slot: slotLabel(s) }));
    });
    await save({ items: { put: items }, drones: { put: [...drones.values()] } }, items.map((it) => it.id));
  });
}

/**
 * Зміни для бази: політ (next; null — видалити prev) і цикли його батарей. Цикли попередньої версії польоту
 * прибираються, нові додаються — правка й видалення не лишають зайвих циклів. Новий сьогоднішній політ
 * переводить батареї в «розряджена».
 */
function flightChanges(next, prev) {
  const id = (next ?? prev).id;
  const fresh = next && !prev && next.date === today();
  const put = [];
  for (const bid of new Set([...(prev?.bats ?? []), ...(next?.bats ?? [])].map((x) => x.batteryId).filter(Boolean))) {
    const b = findBattery(bid);
    if (!b) continue;
    const cycles = (b.cycles ?? []).filter((c) => c.flightId !== id);
    // Напруга й IR, уже вписані в цикл, переживають правку польоту
    next?.bats.forEach((x, i) => { if (x.batteryId === bid) cycles.push({ ...b.cycles?.find((c) => c.id === `${id}-${i}`), id: `${id}-${i}`, date: next.date, flightId: id }); });
    cycles.sort((a, c) => collate(a.date, c.date));
    put.push({ ...b, cycles, ...(fresh && b.state !== 'dead' ? { state: 'empty', stateAt: Date.now() } : {}) });
  }
  return { flights: next ? { put: [next] } : { del: [id] }, batteries: { put } };
}

// ---------- налаштування: копія, імпорт, демо ----------

function download(name, content) {
  const url = URL.createObjectURL(content instanceof Blob ? content : new Blob([content], { type: 'application/json' }));
  const a = h('a', { href: url, download: name });
  document.body.append(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}

/** Файл — через «Поділитися» (на телефоні: Telegram, Диск…), де не вміє — завантаженням; false — скасували. */
async function offerFile(name, content, type, share = true) {
  if (share) {
    const file = new File([content], name, { type });
    if (navigator.canShare?.({ files: [file] })) {
      try { await navigator.share({ files: [file], title: name }); return true; } catch (e) { if (e.name === 'AbortError') return false; }
    }
  }
  download(name, new Blob([content], { type }));
  return true;
}

const BACKUP_KEY = 'fpv-log:backup-at';
const BACKUP_EVERY = 30;

async function exportData(share) {
  const payload = JSON.stringify({ app: 'fpv-log', format: 1, exportedAt: new Date().toISOString(), data: state }, null, 1);
  if (await offerFile(`fpv-log-${today()}.json`, payload, 'application/json', share)) remember(BACKUP_KEY, today());
}

/** Без Google Диска раз на місяць: дані лише на пристрої — нагадати зберегти копію. */
function backupReminder() {
  const own = db.DATA_STORES.reduce((n, s) => n + state[s].filter((x) => !/^(demo|st)-/.test(String(x.id))).length, 0);
  const last = [recall(BACKUP_KEY), recall('fpv-log:backup-reminded')].filter(Boolean).sort().pop();
  if (sync.enabled() || own < 10 || (last && addDays(last, BACKUP_EVERY) > today())) return;
  remember('fpv-log:backup-reminded', today());
  toast(t('Дані лише на цьому пристрої — збережіть копію'), { action: t('Зберегти'), onAction: () => exportData(true), reminder: true });
}

function importData(file) {
  const reader = new FileReader();
  reader.onload = () => {
    let parsed;
    try { parsed = JSON.parse(reader.result); } catch { toast(t('Файл не схожий на JSON')); return; }
    importParsed(parsed);
  };
  reader.readAsText(file);
}

function importBtn() {
  const input = h('input', { type: 'file', accept: '.json,application/json', hidden: true, onchange: (e) => { if (e.target.files[0]) importData(e.target.files[0]); } });
  return btn(t('Імпорт'), () => input.click());
}

function importChanges(data) {
  const validId = (id) => (typeof id === 'string' && id !== '') || Number.isFinite(id);
  return Object.fromEntries(db.STORES.map((s) => [s, { put: (data[s] ?? []).filter((x) => x && validId(x.id)) }]));
}

const isEmpty = () => !db.DATA_STORES.some((s) => state[s]?.length);

function importParsed(parsed) {
  const data = parsed?.data;
  if (parsed?.app !== 'fpv-log' || !data || !db.STORES.every((s) => !data[s] || Array.isArray(data[s]))) {
    toast(t('Це не файл FPV Log'));
    return;
  }
  const count = db.DATA_STORES.reduce((s, k) => s + (data[k]?.length ?? 0), 0);
  const changes = importChanges(data);
  const merge = async () => { await db.mergeImport(changes); await refresh(); toast(t('Імпортовано')); };
  // база порожня — об'єднувати нічого: без шторки
  if (isEmpty()) { merge(); return; }
  const close = sheet(t('Імпорт'), h('div', {},
    h('p', {}, t('У файлі записів: {n}.', { n: count })),
    h('p', { class: 'muted small' }, t('«Об’єднати» — додасть нові записи й оновить ті, що у файлі новіші. «Замінити все» — спершу видалить поточні дані.')),
    sync.enabled() ? h('p', { class: 'muted small' }, t('Увімкнено синхронізацію: «Замінити все» замінить дані й на Google Диску, і на інших пристроях.')) : null), {
    actions: [
      btn(t('Скасувати'), () => close()),
      btn(t('Об’єднати'), () => { close(); merge(); }),
      btn(t('Замінити все'), () => {
        close();
        confirmSheet(t('Замінити всі дані?'), t('Поточні дані буде видалено. Спершу зробіть експорт, якщо вони потрібні.'), t('Замінити'), async () => {
          sync.markRestore(await db.replaceAll(changes));
          await refresh();
          toast(t('Дані замінено'));
        });
      }, 'danger'),
    ],
  });
}

async function loadDemo() {
  try {
    const res = await fetch('./demo.json', { cache: 'no-store' });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    importParsed(await res.json());
  } catch {
    toast(t('Не вдалося завантажити демодані'));
  }
}

// ---------- синхронізація ----------

function syncTime(ms) {
  if (!ms) return t('ще не було');
  const d = new Date(ms);
  return d.toDateString() === new Date().toDateString()
    ? t('сьогодні о {time}', { time: fmt.time(ms) })
    : `${fmt.date(new Date(ms - d.getTimezoneOffset() * 60_000).toISOString().slice(0, 10))} ${fmt.time(ms)}`;
}

function connectGoogle() {
  sync.connect().then(() => toast(t('Google Диск підключено'))).catch((err) => toast(err.message));
}

function syncBody() {
  const s = sync.status;
  const panel = h('div', { class: 'set-sub' });
  if (!sync.configured()) {
    panel.append(h('p', { class: 'muted small' }, t('Не налаштовано: у js/config.js не вказано Google Client ID.')));
  } else if (!sync.enabled()) {
    panel.append(
      h('p', { class: 'muted small' }, t('Дані зберігатимуться у файлі fpv-log.json на вашому Google Диску й збігатимуться на телефоні та комп’ютері. Застосунок бачить лише свої файли.')),
      h('div', { class: 'btn-row' }, btn(t('Підключити Google Диск'), connectGoogle, 'primary')));
  } else {
    panel.append(
      kv([[t('Акаунт'), s.email ?? '—'], [t('Остання'), syncTime(s.lastSync)], [t('Статус'), s.message || null]]),
      h('div', { class: 'btn-row' },
        s.state === 'auth' ? btn(t('Увійти в Google'), connectGoogle, 'primary') : btn(t('Синхронізувати'), () => sync.syncNow(), 'primary'),
        btn(t('Вимкнути'), () => confirmSheet(t('Вимкнути синхронізацію?'), t('Дані залишаться і на пристрої, і на Google Диску, просто перестануть обмінюватися.'), t('Вимкнути'), () => sync.disconnect()))));
  }
  return panel;
}

const CHIP = {
  idle: () => `☁ ✓ ${fmt.time(sync.status.lastSync)}`,
  syncing: () => '☁ ',
  offline: () => t('☁ офлайн'),
  auth: () => t('☁ увійти'),
  error: () => t('☁ помилка'),
};

function renderSyncChip(s) {
  const chip = $('sync-chip');
  chip.hidden = !CHIP[s.state];
  if (CHIP[s.state]) {
    chip.textContent = CHIP[s.state]();
    if (s.state === 'syncing') chip.append(h('span', { class: 'sync-dots', 'aria-hidden': 'true' }, h('i'), h('i'), h('i')));
    chip.className = `sync-chip ${s.state}`;
    chip.title = s.message || t('Синхронізація з Google Диском');
  }
  if (tab === 'settings') render();
}

function onSyncChip() {
  const { state: st, message } = sync.status;
  if (st === 'auth') connectGoogle();
  else if (st === 'offline') toast(t('Немає інтернету — синхронізація відбудеться, коли з’явиться зв’язок'));
  else if (st === 'error') { toast(message || t('Помилка синхронізації')); sync.syncNow(); } else sync.syncNow();
}

// ---------- тема й мова ----------

// Тема: auto — як у системі. Першу розстановку до малювання робить скрипт в index.html.
const THEMES = [['auto', 'Авто'], ['dark', 'Темна'], ['light', 'Світла'], ['lime', 'Лайм'], ['night', 'Нічна'], ['phosphor', 'Фосфор'], ['amber', 'Бурштин'], ['white', 'Білий фосфор']];
const SPECIAL_THEMES = ['night', 'phosphor', 'amber', 'white'];
const lightScheme = matchMedia('(prefers-color-scheme: light)');

function themePref() {
  const v = recall('fpv-log:theme');
  return THEMES.some(([k]) => k === v) ? v : 'auto';
}

/** Яскравість червоного в нічній темі, 20–100 %. */
function nightLevel() {
  const v = Number(recall('fpv-log:night-level'));
  return v >= 20 && v <= 100 ? v : 80;
}

// Фон під картками: темний набір — для «Темної» й «Лайму» (спільний вибір), світлий — для «Світлої», у спецрежимах немає
const BACKDROPS = {
  dark: [['plain', 'Без малюнка'], ['carbon', 'Карбон'], ['map', 'Карта'], ['grid', 'Сітка OSD'], ['acc-lines', 'З акцентом']],
  light: [['l-plain', 'Без малюнка'], ['l-map', 'Карта'], ['l-grid', 'Сітка OSD'], ['l-acc-lines', 'З акцентом']],
};
const bgFamily = (theme) => (theme === 'light' ? 'light' : theme === 'dark' || theme === 'lime' ? 'dark' : null);
const BG_KEY = { dark: 'fpv-log:bg', light: 'fpv-log:bg-light' };

function backdropPref(fam) {
  const list = BACKDROPS[fam];
  if (!list) return null;
  const v = recall(BG_KEY[fam]);
  return list.some(([k]) => k === v) ? v : list[0][0];
}

function applyTheme() {
  const pref = themePref();
  const theme = pref === 'auto' ? (lightScheme.matches ? 'light' : 'dark') : pref;
  document.documentElement.dataset.theme = theme;
  const bg = backdropPref(bgFamily(theme));
  if (bg && !bg.endsWith('plain')) document.documentElement.dataset.bg = bg; else delete document.documentElement.dataset.bg;
  const k = nightLevel() / 100;
  document.querySelector('#night-red feColorMatrix')?.setAttribute('values',
    `${(0.5 * k).toFixed(3)} ${(0.6 * k).toFixed(3)} ${(0.1 * k).toFixed(3)} 0 0  0 0 0 0 0  0 0 0 0 0  0 0 0 1 0`);
  document.querySelector('meta[name="theme-color"]')?.setAttribute('content', getComputedStyle(document.documentElement).getPropertyValue('--bg').trim() || '#0e1114');
}

lightScheme.addEventListener('change', applyTheme);

function switchLang(code) {
  setLang(code);
  applyStatic();
  renderSyncChip(sync.status);
  render();
}

// ---------- що нового ----------

const SEEN_KEY = 'fpv-log:seen-version';
const allChanges = () => import('./changelog.js').then((m) => m.CHANGES);
const verParts = (v) => String(v).split('.').map(Number);

/** a новіша за b (версії виду 0.1.0). */
function newer(a, b) {
  const [x, y] = [verParts(a), verParts(b)];
  for (let i = 0; i < Math.max(x.length, y.length); i += 1) {
    if ((x[i] ?? 0) !== (y[i] ?? 0)) return (x[i] ?? 0) > (y[i] ?? 0);
  }
  return false;
}

function changesSheet(list) {
  const close = sheet(t('Що нового'), h('div', {}, list.map((c) => box(`${c.v} · ${fmt.date(c.date)}`,
    h('ul', { class: 'changes' }, (c[lang()] ?? c.uk).map((x) => h('li', {}, x)))))),
  { actions: [btn(t('Зрозуміло'), () => close(), 'primary')] });
}

function showNews() {
  const seen = recall(SEEN_KEY);
  remember(SEEN_KEY, self.APP_VERSION);
  if (!seen || !newer(self.APP_VERSION, seen)) return;
  allChanges().then((all) => {
    const list = all.filter((c) => newer(c.v, seen));
    if (list.length) changesSheet(list);
  }).catch(() => {});
}

async function checkUpdate() {
  if (!('serviceWorker' in navigator)) { toast(t('Оновлення працюють лише через https')); return; }
  const reg = await navigator.serviceWorker.getRegistration();
  if (!reg) { toast(t('Застосунок ще не встановлено як офлайн-копію')); return; }
  if (!navigator.onLine) { toast(t('Немає зв’язку із сервером')); return; }
  toast(t('Перевіряю оновлення…'));
  try {
    const res = await fetch('./version.js', { method: 'HEAD', cache: 'no-store', signal: AbortSignal.timeout(8000) });
    if (!res.ok) throw new Error(String(res.status));
    await reg.update();
  } catch {
    toast(t('Немає зв’язку із сервером'));
    return;
  }
  if (reg.installing || reg.waiting) toast(t('Є нова версія — натисніть «Оновити» вгорі'));
  else toast(t('У вас найновіша версія'));
}

// ---------- налаштування ----------

const SET_OPEN_KEY = 'fpv-log:set-open';

function settingsGroup(title, items) {
  const list = items.filter(Boolean);
  return list.length ? h('fieldset', { class: 'box settings-group' }, h('legend', {}, title), list) : null;
}

/** Рядок налаштувань: іконка, назва й поточне значення; тап розгортає керування. Відкритий — один. */
function setRow(key, ico, title, value, body, { tone = '', danger = false } = {}) {
  const open = recall(SET_OPEN_KEY) === key;
  const el = h('div', { class: `set-row${open ? ' open' : ''}${danger ? ' danger' : ''}` });
  const head = h('button', {
    type: 'button', class: 'set-head', 'aria-expanded': String(open), onclick: () => {
      const opening = !el.classList.contains('open');
      document.querySelectorAll('.set-row.open').forEach((r) => setOpen(r, false));
      setOpen(el, opening);
      remember(SET_OPEN_KEY, opening ? key : '');
    },
  }, toolIcon(ico), h('span', { class: 'set-title' }, title),
  h('span', { class: `set-val${tone ? ` ${tone}` : ''}` }, value), h('span', { class: 'set-chev', 'aria-hidden': 'true' }, '›'));
  el.append(head, h('div', { class: 'set-body', inert: !open }, h('div', { class: 'set-inner' }, h('div', { class: 'set-pane' }, body))));
  return el;
}

function setOpen(el, open) {
  el.classList.toggle('open', open);
  el.querySelector('.set-head').setAttribute('aria-expanded', String(open));
  el.querySelector('.set-body').inert = !open;
}

function shortWhen(ms) {
  const d = new Date(ms);
  return d.toDateString() === new Date().toDateString() ? fmt.time(ms)
    : fmt.date(new Date(ms - d.getTimezoneOffset() * 60_000).toISOString().slice(0, 10));
}

function syncRow() {
  const s = sync.status;
  const on = sync.configured() && sync.enabled();
  const bad = on && (s.state === 'auth' || s.state === 'error');
  const value = !sync.configured() ? t('Не налаштовано') : !on ? t('Вимкнено')
    : s.state === 'auth' ? t('Увійти') : s.state === 'error' ? t('Похибка') : s.state === 'offline' ? t('Офлайн')
      : s.lastSync ? shortWhen(s.lastSync) : t('Ще не було');
  return setRow('sync', 'cloud', t('Google Диск'), value, syncBody(), { tone: bad ? 'bad' : on ? 'ok' : '' });
}

function backupRow() {
  const fileInput = h('input', { type: 'file', accept: '.json,application/json', hidden: true, onchange: (e) => { if (e.target.files[0]) importData(e.target.files[0]); e.target.value = ''; } });
  const last = recall(BACKUP_KEY);
  return setRow('backup', 'save', t('Резервна копія'), last ? fmt.date(last) : t('Ще не було'), [
    h('p', { class: 'muted small' }, sync.enabled()
      ? t('Основна копія — на Google Диску. Файл нижче — додатковий знімок про всяк випадок.')
      : t('Без синхронізації дані зберігаються лише на цьому пристрої. Час від часу зберігайте копію — наприклад, «Поділитися» → Google Диск або Telegram «Збережене».')),
    h('p', { class: 'muted small' }, t('У файл копії потрапляють лише мініатюри фото. «Імпорт» приймає й стартовий набір (starter.json).')),
    h('div', { class: 'btn-row' },
      btn(t('Поділитися копією'), () => exportData(true), 'primary'),
      btn(t('Завантажити файл'), () => exportData(false)),
      btn(t('Імпорт'), () => fileInput.click())),
    fileInput]);
}

/**
 * Копія у форматі Марнотрата для «Резервна копія → Додати до наявних»: { app: 'marnotrat', coins, ops }.
 * Монети зливаються за видом і назвою (наявні «Готівка» й «FPV» беруться ті самі, нових — створюються),
 * операції з уже відомим id пропускаються — id замовлень сталі, тож повторний експорт не дублює.
 * Витрата = рахунок → категорія, сума — замовлення з доставкою в гривнях (рахунок має бути гривневий).
 */
function marnotratFile(orders, accName, catName) {
  const coin = (id, kind, name, icon, order) => ({ id, kind, name, icon, currency: 'UAH', budget: 0, start: 0, order, archived: false });
  const acc = coin('fpv-log-account', 'account', accName, 'wallet', 0);
  const cat = coin('fpv-log-category', 'expense', catName, 'plane', 1);
  const ops = orders.map((o, i) => ({
    id: `fpv-log-${o.id}`, from: acc.id, to: cat.id, amount: orderTotal(o), date: o.date, tags: [],
    comment: `${o.shop}: ${o.lines.map((l) => [l.brand, l.model].filter(Boolean).join(' ')).join(', ')}`.slice(0, 200), created: Date.now() + i,
  }));
  return { app: 'marnotrat', version: `fpv-log ${self.APP_VERSION}`, exported: new Date().toISOString(), coins: [acc, cat], ops };
}

function marnotratRow() {
  const f = form([
    { name: 'from', label: t('Від'), type: 'dmy', value: `${today().slice(0, 4)}-01-01`, required: true, half: true },
    { name: 'to', label: t('До'), type: 'dmy', value: today(), required: true, half: true },
    { name: 'acc', label: t('Рахунок у Марнотраті'), value: recall('fpv-log:mn-acc') || 'Готівка', required: true, half: true },
    { name: 'cat', label: t('Категорія'), value: recall('fpv-log:mn-cat') || 'FPV', required: true, half: true },
  ]);
  return setRow('marnotrat', 'share', t('Експорт у Марнотрат'), '', [
    h('p', { class: 'muted small' }, t('Замовлення за період (з доставкою, у гривнях) — витратами з рахунку в категорію. У Марнотраті: Резервна копія → файл → «Додати до наявних»; повторний імпорт не дублює.')),
    f.el,
    h('div', { class: 'btn-row' }, btn(t('Зберегти файл'), async () => {
      if (invalidField(f)) return;
      const v = f.values();
      const list = state.orders.filter((o) => o.date >= v.from && o.date <= v.to && orderTotal(o) > 0).sort((a, b) => collate(a.date, b.date));
      if (!list.length) { toast(t('За цей період замовлень немає')); return; }
      remember('fpv-log:mn-acc', v.acc);
      remember('fpv-log:mn-cat', v.cat);
      const file = JSON.stringify(marnotratFile(list, v.acc, v.cat), null, 1);
      if (await offerFile(`marnotrat-fpv-${v.from}-${v.to}.json`, file, 'application/json')) {
        toast(t('Замовлень: {n}, разом {sum}', { n: list.length, sum: fmt.money(list.reduce((s, o) => s + orderTotal(o), 0)) }));
      }
    }, 'primary'))]);
}

function demoRow() {
  return setRow('demo', 'play', t('Демодані'), '', [
    h('p', { class: 'muted small' }, t('Вигаданий 5″ самозбір на Walksnail з історією заміни мотора й прошивок, BNF Meteor75 із замовлення, шолом Cobra X, батареї й десять польотів.')),
    h('div', { class: 'btn-row' }, btn(t('Завантажити демодані'), loadDemo))]);
}

function wipeRow() {
  return setRow('wipe', 'delete', t('Видалити дані з пристрою'), '',
    h('div', { class: 'btn-row' }, btn(t('Видалити дані з пристрою'), () => confirmSheet(t('Видалити дані з пристрою?'), sync.enabled()
      ? t('Дані буде видалено з цього пристрою. Копія на Google Диску залишиться й повернеться під час наступної синхронізації — щоб цього не сталося, спершу вимкніть синхронізацію.')
      : t('Дрони, склад, замовлення, батареї й фото буде видалено з цього пристрою. Скасувати не можна.'), t('Видалити'), async () => {
      await db.clearAll(); await refresh(); toast(t('Дані видалено'));
    }), 'danger')),
    { danger: true });
}

function langRow() {
  const c = chips(Object.entries(LANGS), lang(), switchLang);
  c.classList.add('segmented');
  return setRow('lang', 'globe', 'Мова · Язык', LANGS[lang()], c);
}

function themeRow() {
  const themeChips = (special) => {
    const c = chips(THEMES.filter(([k]) => SPECIAL_THEMES.includes(k) === special).map(([k, label]) => [k, t(label)]), themePref(),
      (v) => { remember('fpv-log:theme', v); applyTheme(); render(); });
    c.classList.add('segmented');
    return c;
  };
  return setRow('theme', 'palette', t('Тема'), t(THEMES.find(([k]) => k === themePref())[1]), [
    themeChips(false),
    h('div', { class: 'field-label theme-group' }, t('Спецрежими')), themeChips(true),
    themePref() === 'night' ? h('label', { class: 'field night-level' }, h('span', {}, t('Яскравість червоного')),
      h('input', { type: 'range', min: '20', max: '100', step: '5', value: String(nightLevel()),
        oninput: (e) => { remember('fpv-log:night-level', e.target.value); applyTheme(); } })) : null]);
}

function backdropRow() {
  const fam = bgFamily(document.documentElement.dataset.theme);
  const list = BACKDROPS[fam];
  if (!list) return null;
  const now = backdropPref(fam);
  const c = chips(list.map(([k, label]) => [k, t(label)]), now, (v) => { remember(BG_KEY[fam], v); applyTheme(); render(); });
  c.classList.add('segmented');
  return setRow('backdrop', 'gallery', t('Фон'), t(list.find(([k]) => k === now)[1]), [c]);
}

function staleRow() {
  const input = h('input', { type: 'number', min: '1', max: '30', inputmode: 'numeric', value: String(staleDays()) });
  return setRow('stale', 'battery', t('Заряджена довше'), t('{n} дн.', { n: staleDays() }), [
    h('p', { class: 'muted small' }, t('Плашка нагадає перевести батарею в зберігання, якщо вона «заряджена» довше стількох днів.')),
    h('label', { class: 'field' }, h('span', { class: 'field-label' }, t('Днів')), input),
    h('div', { class: 'btn-row' }, btn(t('Зберегти'), () => {
      const n = Math.round(Number(input.value));
      if (!(n >= 1)) { toast(t('Більше нуля')); return; }
      save({ prefs: { put: [{ ...prefs(), staleDays: n }] } });
    }, 'primary'))]);
}

function aboutPanel() {
  const link = (href, text) => h('a', { href, target: '_blank', rel: 'noopener' }, text);
  return h('section', { class: 'panel about' },
    h('div', { class: 'about-head' },
      h('img', { src: './icons/icon-192.png', alt: '', width: 48, height: 48, class: 'app-icon big' }),
      h('div', {}, h('h3', {}, 'FPV Log'),
        h('p', { class: 'muted small' }, t('Версія {v} · збірка {b}', { v: self.APP_VERSION, b: self.APP_BUILD ?? '—' })))),
    h('p', { class: 'muted small about-desc' }, t('З чого зібрані дрони й наземка, прошивки, покупки, склад і батареї. Працює без інтернету: усе зберігається на пристрої.')),
    h('div', { class: 'btn-row' }, btn(t('Перевірити оновлення'), () => checkUpdate()), btn(t('Що нового'), () => allChanges().then(changesSheet))),
    h('nav', { class: 'about-links' },
      link('https://github.com/VitaliyLobko/fpv-log/issues/new', t('Повідомити про помилку')),
      link('https://github.com/VitaliyLobko/fpv-log', t('Код')),
      link('https://github.com/VitaliyLobko/fpv-log/blob/main/LICENSE', t('Ліцензія MIT'))));
}

function renderSettings() {
  $('subtitle').textContent = t('версія {v}', { v: self.APP_VERSION });
  return h('div', { class: 'settings' },
    settingsGroup(t('Про застосунок'), [aboutPanel()]),
    settingsGroup(t('Дані'), [syncRow(), backupRow(), marnotratRow(), demoRow(), wipeRow()]),
    settingsGroup(t('Вигляд'), [langRow(), themeRow(), backdropRow()]),
    settingsGroup(t('Батареї'), [staleRow()]));
}

// ---------- навігація ----------

const VIEWS = {
  drones: { title: 'Дрони', render: renderDrones, fab: () => droneForm() },
  flights: { title: 'Польоти', render: renderFlights, fab: () => flightForm() },
  stock: { title: 'Склад', render: renderStock, fab: stockAddMenu },
  batteries: { title: 'Батареї', render: renderBatteries, fab: () => batteryForm() },
  settings: { title: 'Налаштування', render: renderSettings },
};

function render() {
  const view = VIEWS[tab];
  $('title').textContent = t(view.title);
  $('subtitle').textContent = '';
  $('view').replaceChildren(view.render());
  $('fab').hidden = !view.fab || Boolean($('view').querySelector('.empty .btn.add'));
  $('fab').classList.remove('away');
  document.querySelectorAll('.tabs a').forEach((a) => a.classList.toggle('active', a.dataset.tab === tab));
  document.querySelector('.tabs a[data-tab="batteries"]').classList.toggle('alert', staleBatteries().length > 0);
}

function route() {
  // QR з наклейки: #bat=<id> — картка батареї й одразу «+ цикл»; адреса стає звичайною вкладкою
  const bat = location.hash.match(/^#bat=(.+)$/)?.[1];
  if (bat) {
    history.replaceState(null, '', '#batteries');
    tab = 'batteries';
    render();
    const b = findBattery(decodeURIComponent(bat));
    if (b) { batteryDetail(b.id); cycleSheet(b); } else toast(t('Батарею з наклейки не знайдено'));
    return;
  }
  const next = location.hash.slice(1);
  tab = VIEWS[next] ? next : 'drones';
  render();
  window.scrollTo(0, 0);
}

function registerWorker() {
  if (!('serviceWorker' in navigator)) return;
  // Локальна розробка: без worker і його кешу, щоб правки видно було одразу; офлайн перевіряти з ?sw
  if (['127.0.0.1', 'localhost', '[::1]'].includes(location.hostname) && !new URLSearchParams(location.search).has('sw')) {
    navigator.serviceWorker.getRegistrations().then((regs) => regs.forEach((r) => r.unregister()));
    caches.keys().then((keys) => keys.forEach((k) => caches.delete(k)));
    return;
  }
  const offer = (worker) => {
    $('update').hidden = false;
    $('update-btn').onclick = () => worker.postMessage('skipWaiting');
  };
  navigator.serviceWorker.register('./sw.js', { updateViaCache: 'none' }).then((reg) => {
    if (reg.waiting && navigator.serviceWorker.controller) offer(reg.waiting);
    reg.addEventListener('updatefound', () => {
      const worker = reg.installing;
      worker?.addEventListener('statechange', () => {
        if (worker.state === 'installed' && navigator.serviceWorker.controller) offer(worker);
      });
    });
    document.addEventListener('visibilitychange', () => { if (document.visibilityState === 'visible') reg.update().catch(() => {}); });
    reg.update().catch(() => {});
  }).catch((err) => console.warn('SW registration failed', err));
  // Перший візит: worker щойно взяв сторінку під контроль — це не оновлення, перезавантажувати нічого
  let controlled = Boolean(navigator.serviceWorker.controller);
  let reloading = false;
  navigator.serviceWorker.addEventListener('controllerchange', () => {
    if (!controlled) { controlled = true; return; }
    if (reloading) return;
    reloading = true;
    location.reload();
  });
}

applyStatic();
applyTheme();
$('fab').addEventListener('click', () => VIEWS[tab].fab?.());
let fabY = window.scrollY;
window.addEventListener('scroll', () => {
  const y = window.scrollY;
  const end = y + innerHeight >= document.documentElement.scrollHeight - 40;
  if (Math.abs(y - fabY) < 12 && !end) return;
  $('fab').classList.toggle('away', y > fabY && y > 80 && !end);
  fabY = y;
}, { passive: true });
$('sync-chip').addEventListener('click', onSyncChip);
window.addEventListener('hashchange', route);
swipeStep(document.querySelector('.tabs'), (dir) => {
  const links = [...document.querySelectorAll('.tabs a')];
  const next = links[links.findIndex((a) => a.classList.contains('active')) + dir];
  if (next) goTab(next.getAttribute('href'));
  return Boolean(next);
});
if (window.visualViewport) {
  const placeTabs = () => {
    const vv = window.visualViewport;
    const gap = Math.round(document.documentElement.clientHeight - vv.height - vv.offsetTop);
    document.documentElement.style.setProperty('--vv-gap', `${gap > 0 && gap < 120 ? gap : 0}px`);
  };
  window.visualViewport.addEventListener('resize', placeTabs);
  window.visualViewport.addEventListener('scroll', placeTabs);
  placeTabs();
}
window.addEventListener('sync-applied', refresh);
window.addEventListener('unhandledrejection', (e) => {
  const err = e.reason;
  if (err?.name === 'AbortError') return;
  console.error(err);
  toast(err?.name === 'QuotaExceededError'
    ? t('Не збереглося: на пристрої скінчилося місце')
    : t('Помилка: {msg}', { msg: err?.message || String(err) }), { timeout: 9000 });
});
window.addEventListener('db-blocked', () => toast(t('Закрийте інші вкладки застосунку — база оновлюється')));
registerWorker();
navigator.storage?.persist?.().catch(() => {});
try {
  await load();
} catch (err) {
  window.removeEventListener('hashchange', route);
  $('fab').hidden = true;
  $('view').replaceChildren(h('div', { class: 'empty' },
    h('h3', {}, t('Не вдалося відкрити дані на пристрої')),
    h('p', { class: 'muted' }, err?.message || String(err)),
    btn(t('Спробувати ще раз'), () => location.reload(), 'primary')));
  throw err;
}
route();
// «Поділитися» → FPV Log: service worker відкрив ?go=shared — забрати картинку; параметр прибираємо, щоб оновлення не повторило
if (new URLSearchParams(location.search).get('go') === 'shared') {
  history.replaceState(history.state, '', location.pathname + location.hash);
  takeSharedImage().catch((err) => toast(err.message));
}
showNews();
setTimeout(backupReminder, 1500);
sync.onStatus(renderSyncChip);
sync.preload();
sync.syncNow();
refreshRates(today()).catch(() => {});
checkFw();
