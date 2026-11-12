// FPV Log: дрони й наземка зі слотами деталей, склад, замовлення, батареї.
// Інфраструктура (база, синхронізація, шторки, теми, «Що нового») — з shooting-log.
import * as db from './db.js';
import * as sync from './sync.js';
import { t, lang, setLang, LANGS, collate, applyStatic } from './i18n.js';
import { prepare as preparePhoto } from './photos.js';
import { rateOn, refreshRates } from './usd.js';
import { h, fmt, sheet, refreshSheets, toast, form, chips, confirmSheet, selectOptions, toolBtn, toolIcon, goTab, confirmed, fieldError, formError, swipeStep } from './ui.js';

let state = { drones: [], items: [], orders: [], batteries: [], photos: [], prefs: [] };
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
const SLOTS = {
  self: [['frame'], ['motors'], ['fc'], ['esc', 'Регулятор / стек'], ['vtx'], ['camera'], ['rx'], ['gps'], ['antenna', 'Антена VTX'], ['antenna', 'Антена RX'], ['props']],
  bnf: [['frame'], ['aio'], ['motors'], ['camera'], ['vtx'], ['props']],
  goggles: [['vrx'], ['antenna', 'Антени'], ['gbattery', 'Батарея']],
  radio: [['txmodule', 'Внутрішній модуль'], ['txmodule', 'Зовнішній модуль']],
};

const STATUS = { stock: 'На складі', installed: 'На дроні', broken: 'Зламаний', sold: 'Продано / списано' };
const BAT_STATES = [['charged', 'Заряджена'], ['storage', 'Зберігання'], ['empty', 'Розряджена'], ['dead', 'Здута / списана']];
const batStateLabel = (k) => t(BAT_STATES.find(([x]) => x === k)?.[1] ?? '');
const CONNECTORS = ['XT60', 'XT30', 'BT2.0', 'PH2.0', 'A30', 'XT90'];

// ---------- дрібниці ----------

function today(when = new Date()) {
  const d = new Date(when);
  d.setMinutes(d.getMinutes() - d.getTimezoneOffset());
  return d.toISOString().slice(0, 10);
}
const addDays = (date, n) => new Date(Date.parse(date) + n * 864e5).toISOString().slice(0, 10);
const round2 = (n) => Math.round((Number(n) || 0) * 100) / 100;
const num = (v) => Number(v) || 0;

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

async function refresh() {
  state = await db.loadAll();
  render();
  refreshSheets();
}

async function save(changes, ids = []) {
  await db.write(changes);
  await refresh();
  confirmed(ids);
}

const itemName = (it) => (it ? [it.brand, it.model].filter(Boolean).join(' ') || catLabel(it.cat) : '—');
const slotLabel = (s) => s.label || (s.tpl ? t(s.tpl) : catLabel(s.cat));
const prefs = () => state.prefs.find((p) => p.id === 'settings') ?? { id: 'settings' };
const staleDays = () => num(prefs().staleDays) || 3;

/** Вартість дрона: свій кошт (BNF, рама шолома) + деталі, що на ньому стоять, із долею доставки. */
const droneCost = (d) => num(d.price) + d.slots.reduce((s, sl) => s + num(findItem(sl.itemId)?.price), 0);

const orderK = (o) => (o.currency === 'USD' ? num(o.rate) || rateOn(o.date) || 0 : 1);
const orderSub = (o) => o.lines.reduce((s, l) => s + num(l.price) * num(l.qty), 0);
const orderTotal = (o) => round2((orderSub(o) + num(o.shipping)) * orderK(o));

/** Вкладено в хобі: замовлення + куплене без замовлення + дрони й батареї − продане. */
function invested() {
  return state.orders.reduce((s, o) => s + orderTotal(o), 0)
    + state.items.reduce((s, it) => s + (it.orderId ? 0 : num(it.price)) - (it.status === 'sold' ? num(it.soldPrice) : 0), 0)
    + state.drones.reduce((s, d) => s + num(d.price), 0)
    + state.batteries.reduce((s, b) => s + num(b.price), 0);
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

function thumbImg(photoId, fallback = '') {
  const p = findPhoto(photoId);
  return p ? h('img', { class: 'thumb', src: p.thumb, alt: '' }) : h('span', { class: 'thumb mono', style: '--h: 25' }, fallback);
}

async function showPhoto(id) {
  const p = findPhoto(id);
  if (!p) return;
  const blob = await db.getBlob(id);
  const url = blob ? URL.createObjectURL(blob) : p.thumb;
  sheet(t('Фото'), h('img', { class: 'photo-full', src: url, alt: '' }), { full: true, onClose: () => blob && URL.revokeObjectURL(url) });
}

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
  return row(d.name, [kindLabel(d.kind), t('деталей: {n}', { n: filled })].join(' · '), droneCost(d) ? fmt.money(droneCost(d)) : '',
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

function droneForm(d = null) {
  let kind = d?.kind ?? 'self';
  const f = form([
    { name: 'name', label: t('Назва'), value: d?.name, required: true, placeholder: t('напр. 5″ фристайл') },
    { name: 'price', label: t('Ціна, грн'), type: 'number', value: d?.price, half: true, hint: t('Для BNF чи шолома; деталі рахуються окремо') },
    { name: 'buyDate', label: t('Куплено'), type: 'dmy', value: d?.buyDate, half: true },
  ]);
  const kinds = chips(KINDS.map(([k, l]) => [k, t(l)]), kind, (v) => { kind = v; });
  kinds.classList.add('segmented');
  const close = sheet(d ? t('Змінити') : t('Новий дрон чи наземка'), h('div', {},
    d ? null : h('div', { class: 'field-label' }, t('Тип')), d ? null : kinds, f.el), {
    actions: [btn(t('Скасувати'), () => close()), btn(t('Зберегти'), async () => {
      if (invalidField(f)) return;
      const v = f.values();
      const rec = d ? { ...d, name: v.name, price: v.price, buyDate: v.buyDate }
        : {
          id: db.uid(), created: Date.now(), name: v.name, kind, group: groupOf(kind), price: v.price, buyDate: v.buyDate,
          slots: SLOTS[kind].map(([cat, tpl]) => ({ id: db.uid(), cat, ...(tpl ? { tpl } : {}), itemId: null })),
          notes: [], configs: [], history: [{ date: today(), text: t('Заведено') }],
        };
      close();
      await save({ drones: { put: [rec] } }, [rec.id]);
      if (!d) droneDetail(rec.id);
    }, 'primary')],
  });
}

function droneDetail(id) {
  const build = () => { const d = findDrone(id); return d ? droneBody(d) : null; };
  const d = findDrone(id);
  sheet(d.name, build(), {
    live: build,
    tools: [toolBtn('edit', t('Змінити'), () => droneForm(findDrone(id))), toolBtn('delete', t('Видалити'), () => removeDrone(findDrone(id)), 'danger')],
  });
}

function droneBody(d) {
  const photo = findPhoto(d.photoId);
  return h('div', {},
    photo ? h('img', { class: 'drone-photo', src: photo.thumb, alt: '', onclick: () => showPhoto(photo.id) }) : null,
    kv([[t('Тип'), kindLabel(d.kind)], [t('Вартість'), fmt.money(droneCost(d))], [t('Куплено'), d.buyDate ? fmt.date(d.buyDate) : null]]),
    box(t('Збірка'), h('div', {},
      h('div', { class: 'rows' }, d.slots.map((s) => slotRow(d, s))),
      h('div', { class: 'btn-row' }, btn(t('+ Слот'), () => slotForm(d))))),
    h('div', { class: 'btn-row' },
      btn(t('Скопіювати збірку'), () => copyText(buildText(d)), 'primary'),
      btn(photo ? t('Змінити фото') : t('Фото'), () => pickFile((file) => setDronePhoto(d, file))),
      btn(t('Нотатка'), () => noteForm(d)),
      btn(t('Конфіг'), () => configForm(d))),
    d.notes?.length ? box(t('Нотатки'), h('div', { class: 'rows' }, [...d.notes].sort((a, b) => collate(b.date, a.date)).map((n) =>
      row(n.text.split('\n')[0], fmt.date(n.date), '', () => noteView(d, n), { thumb: n.photoId ? thumbImg(n.photoId) : null })))) : null,
    d.configs?.length ? box(t('Конфіги'), h('div', { class: 'rows' }, [...d.configs].sort((a, b) => collate(b.date, a.date)).map((c) =>
      row(c.name || t('Конфіг'), fmt.date(c.date), '', () => configView(d, c))))) : null,
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
      it?.fw ? h('span', { class: 'muted small' }, `${t('Прошивка')}: ${it.fw}`) : null),
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
function replaceSheet(droneId, slotId) {
  const d = findDrone(droneId);
  const s = d.slots.find((x) => x.id === slotId);
  const cur = findItem(s.itemId);
  const free = state.items.filter((it) => it.kind === 'unit' && it.status === 'stock').sort((a, b) => collate(itemName(a), itemName(b)));
  const fits = free.filter((it) => it.cat === s.cat);
  const select = h('select', { name: 'item' }, selectOptions([['', t('— порожньо —')],
    { group: t('Підходять'), options: fits.map((it) => [it.id, itemName(it)]) },
    { group: t('Інше на складі'), options: free.filter((it) => it.cat !== s.cat).map((it) => [it.id, `${itemName(it)} (${catLabel(it.cat)})`]) }], ''));
  let outcome = 'stock';
  const reason = form([{ name: 'reason', label: t('Причина'), placeholder: t('напр. погнутий вал після падіння') }]);
  reason.el.hidden = true;
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
      await replaceSlot(droneId, slotId, select.value || null, outcome, r);
    }, 'primary')],
  });
}

async function replaceSlot(droneId, slotId, newId, outcome, reason) {
  const d = findDrone(droneId);
  const s = d.slots.find((x) => x.id === slotId);
  const old = findItem(s.itemId);
  const nw = findItem(newId);
  const where = { d: d.name, slot: slotLabel(s) };
  const put = [];
  if (old) {
    put.push(logged({ ...old, status: outcome === 'broken' ? 'broken' : 'stock', droneId: null, ...(outcome === 'broken' ? { reason } : {}) },
      outcome === 'broken' ? t('Знято з «{d}» ({slot}), зламана: {r}', { ...where, r: reason }) : t('Знято з «{d}» ({slot}) на склад', where)));
  }
  if (nw) put.push(logged({ ...nw, status: 'installed', droneId: d.id }, t('Встановлено на «{d}» ({slot})', where)));
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

async function setDronePhoto(d, file) {
  const p = await newPhoto(file, d.id);
  const old = dropPhotos([d.photoId].filter(Boolean));
  await save({
    drones: { put: [{ ...findDrone(d.id), photoId: p.id }] },
    photos: { put: p.photos.put, del: old.photos?.del ?? [] },
    blobs: { put: p.blobs.put, del: old.blobs?.del ?? [] },
  }, [d.id]);
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
    n.photoId && findPhoto(n.photoId) ? h('img', { class: 'drone-photo', src: findPhoto(n.photoId).thumb, alt: '', onclick: () => showPhoto(n.photoId) }) : null), {
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
      await save({ drones: { put: [{ ...cur, configs: [...(cur.configs ?? []), { id: db.uid(), ...v }] }] } }, [d.id]);
    }, 'primary')],
  });
}

function configView(d, c) {
  const close = sheet(c.name || t('Конфіг'), h('div', {},
    h('p', { class: 'muted small' }, fmt.date(c.date)),
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

const STOCK_SEGS = [['units', 'Деталі'], ['cons', 'Розхідники'], ['orders', 'Замовлення']];
let stockSeg = STOCK_SEGS.some(([k]) => k === recall('fpv-log:stock-seg')) ? recall('fpv-log:stock-seg') : 'units';

const isLow = (it) => it.kind === 'consumable' && num(it.qty) <= num(it.low);

function itemRow(it) {
  const where = it.status === 'installed' ? findDrone(it.droneId)?.name : it.status === 'broken' ? it.reason : '';
  if (it.kind === 'consumable') {
    return row(itemName(it), catLabel(it.cat), `${fmt.num(it.qty)} ${t('шт')}`, () => itemDetail(it.id), { id: it.id, cls: isLow(it) ? 'low' : '' });
  }
  return row(itemName(it), [catLabel(it.cat), it.fw, where].filter(Boolean).join(' · '), it.price ? fmt.money(it.price) : '', () => itemDetail(it.id), { id: it.id });
}

function renderStock() {
  const seg = chips(STOCK_SEGS.map(([k, l]) => [k, t(l)]), stockSeg, (v) => { stockSeg = v; remember('fpv-log:stock-seg', v); render(); });
  seg.classList.add('segmented');
  const byName = (a, b) => collate(catLabel(a.cat), catLabel(b.cat)) || collate(itemName(a), itemName(b));
  let body;
  if (stockSeg === 'orders') {
    const list = [...state.orders].sort((a, b) => collate(b.date, a.date));
    body = list.length ? h('div', { class: 'rows' }, list.map((o) =>
      row(o.shop || t('Замовлення'), `${fmt.date(o.date)} · ${t('позицій: {n}', { n: o.lines.length })}`, fmt.money(orderTotal(o)), () => orderForm(o), { id: o.id })))
      : empty(t('Замовлень немає'), t('Покупка — це замовлення: магазин, дата, позиції й доставка. Позиції одразу лягають на склад.'));
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
  const close = sheet(t('Додати'), h('div', { class: 'btn-col' },
    btn(t('Замовлення'), () => { close(); orderForm(); }, 'primary'),
    btn(t('Деталь, що вже була'), () => { close(); itemForm(null, { preset: { kind: 'unit' } }); }),
    btn(t('Розхідник'), () => { close(); itemForm(null, { preset: { kind: 'consumable' } }); })));
}

/** Деталь чи розхідник без замовлення («вже було») або правка наявного. onSaved — новий запис (для «Замінити»). */
function itemForm(it = null, { preset = {}, onSaved = null } = {}) {
  const kind = it?.kind ?? preset.kind ?? 'unit';
  const cons = kind === 'consumable';
  const fields = [
    { name: 'cat', label: t('Категорія'), type: 'select', options: catOptions(), value: it?.cat ?? preset.cat ?? (cons ? 'props' : 'other') },
    { name: 'brand', label: t('Бренд'), value: it?.brand, half: true },
    { name: 'model', label: t('Модель'), value: it?.model, half: true, required: true },
    { name: 'specs', label: t('Характеристики'), type: 'textarea', rows: 2, value: it?.specs },
  ];
  if (cons) fields.push({ name: 'qty', label: t('Кількість'), type: 'number', value: it?.qty ?? 1, half: true }, { name: 'low', label: t('Поріг «мало»'), type: 'number', value: it?.low ?? 0, half: true });
  else if (!it) fields.push({ name: 'fw', label: t('Прошивка'), placeholder: 'Betaflight 4.5.1' });
  if (!it?.orderId) fields.push({ name: 'price', label: t('Ціна, грн'), type: 'number', value: it?.price, half: true }, { name: 'buyDate', label: t('Куплено'), type: 'dmy', value: it?.buyDate, half: true });
  const f = form(fields);
  const close = sheet(it ? t('Змінити') : cons ? t('Розхідник') : t('Деталь, що вже була'), h('div', {},
    it?.orderId ? h('p', { class: 'muted small' }, t('Ціна й дата — із замовлення.')) : null, f.el), {
    actions: [btn(t('Скасувати'), () => close()), btn(t('Зберегти'), async () => {
      if (invalidField(f)) return;
      const v = f.values();
      const rec = it ? { ...it, ...v } : {
        id: db.uid(), created: Date.now(), kind, status: 'stock', ...v, fwLog: [],
        history: [{ date: today(), text: t('Додано на склад') }],
      };
      if (cons) { rec.qty = num(v.qty); rec.low = num(v.low); }
      close();
      await save({ items: { put: [rec] } }, [rec.id]);
      if (!it) onSaved?.(rec);
    }, 'primary')],
  });
}

function itemDetail(id) {
  const build = () => { const it = findItem(id); return it ? itemBody(it) : null; };
  const it = findItem(id);
  sheet(itemName(it), build(), {
    live: build,
    tools: [toolBtn('edit', t('Змінити'), () => itemForm(findItem(id))), toolBtn('delete', t('Видалити'), () => removeItem(findItem(id)), 'danger')],
  });
}

function itemBody(it) {
  const o = it.orderId ? findOrder(it.orderId) : null;
  const drone = it.status === 'installed' ? findDrone(it.droneId) : null;
  const cons = it.kind === 'consumable';
  const actions = cons ? [btn(t('Списати'), () => qtySheet(it, -1)), btn(t('Додати'), () => qtySheet(it, 1))]
    : it.status === 'installed' ? []
      : [btn(t('Прошивка'), () => fwSheet(it)),
        it.status !== 'stock' ? btn(t('На склад'), () => setStatus(it, 'stock', {}, t('Повернуто на склад'))) : null,
        it.status !== 'broken' ? btn(t('Зламана'), () => brokenSheet(it)) : null,
        it.status !== 'sold' ? btn(t('Продано / списано'), () => soldSheet(it)) : null];
  return h('div', {},
    kv([
      [t('Категорія'), catLabel(it.cat)],
      cons ? [t('Кількість'), h('span', { class: isLow(it) ? 'warn-text' : '' }, `${fmt.num(it.qty)} ${t('шт')}${isLow(it) ? ` · ${t('мало')}` : ''}`)] : [t('Стан'), t(STATUS[it.status ?? 'stock'])],
      drone ? [t('Дрон'), h('button', { type: 'button', class: 'link-btn', onclick: () => droneDetail(drone.id) }, drone.name)] : null,
      it.status === 'broken' ? [t('Причина'), it.reason] : null,
      it.status === 'sold' ? [t('Продано'), `${fmt.money(it.soldPrice)}${it.soldDate ? ` · ${fmt.date(it.soldDate)}` : ''}`] : null,
      cons ? null : [t('Прошивка'), it.fw],
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
  await save({ items: { put: [logged({ ...it, status, droneId: null, ...extra }, text)] } }, [it.id]);
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

function fwSheet(it) {
  const f = form([
    { name: 'to', label: t('Нова версія'), value: it.fw, required: true },
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
 * у гривнях за курсом дня покупки. Штучна позиція ×N — N окремих деталей; розхідник — одна з кількістю.
 */
function orderForm(o = null) {
  const prevLines = o?.lines ?? [];
  let currency = o?.currency ?? 'UAH';
  const head = form([
    { name: 'shop', label: t('Магазин'), value: o?.shop, required: true, half: true },
    { name: 'date', label: t('Дата'), type: 'dmy', value: o?.date ?? today(), required: true, half: true },
    { name: 'shipping', label: t('Доставка'), type: 'number', value: o?.shipping, half: true },
    { name: 'rate', label: t('Курс, грн за $'), type: 'number', value: o?.rate ?? rateOn(o?.date ?? today()), half: true },
    { name: 'note', label: t('Примітка'), value: o?.note },
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
      { name: 'kind', label: t('Вид'), type: 'select', options: [['unit', t('Деталь')], ['consumable', t('Розхідник')]], value: l.kind ?? 'unit', half: true },
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
  if (!prevLines.length) addLine();
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
  const k = orderK(o);
  const sub = orderSub(o);
  const ship = sub ? num(o.shipping) / sub : 0;
  const put = [];
  const del = [];
  const busy = (it) => it.kind === 'unit' && it.status !== 'stock';
  for (const pl of prevLines) {
    if (o.lines.some((l) => l.id === pl.id)) continue;
    for (const it of pl.itemIds.map(findItem).filter(Boolean)) {
      if (busy(it)) throw new Error(t('«{name}» не на складі — позицію не прибрати', { name: itemName(it) }));
      del.push(it.id);
    }
  }
  const bought = t('Куплено: {shop}', { shop: o.shop });
  for (const l of o.lines) {
    const prev = prevLines.find((x) => x.id === l.id);
    const renamed = !prev || prev.brand !== l.brand || prev.model !== l.model || prev.cat !== l.cat;
    const base = { orderId: o.id, buyDate: o.date, ...(renamed ? { cat: l.cat, brand: l.brand, model: l.model } : {}) };
    const unitUah = round2(l.price * (1 + ship) * k);
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
    dead.length ? box(t('Списані'), h('div', { class: 'rows' }, dead.map(batRow))) : null);
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
  sheet(batTitle(findBattery(id)), build(), {
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
    b.cycles?.length ? box(t('Цикли'), h('ul', { class: 'changes' }, [...b.cycles].reverse().map((c) => h('li', {},
      [fmt.date(c.date), c.v && `${c.v} ${t('В/банку')}`, c.ir && `IR ${c.ir} ${t('мОм')}`].filter(Boolean).join(' · '))))) : null);
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
const THEMES = [['auto', 'Авто'], ['dark', 'Темна'], ['light', 'Світла'], ['night', 'Нічна'], ['phosphor', 'Фосфор'], ['amber', 'Бурштин'], ['white', 'Білий фосфор']];
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

function applyTheme() {
  const pref = themePref();
  document.documentElement.dataset.theme = pref === 'auto' ? (lightScheme.matches ? 'light' : 'dark') : pref;
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

function demoRow() {
  return setRow('demo', 'play', t('Демодані'), '', [
    h('p', { class: 'muted small' }, t('Вигаданий 5″ самозбір на Walksnail з історією заміни мотора й прошивок, шолом Cobra X і батареї CNHL 6S 2200.')),
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
    settingsGroup(t('Дані'), [syncRow(), backupRow(), demoRow(), wipeRow()]),
    settingsGroup(t('Вигляд'), [langRow(), themeRow()]),
    settingsGroup(t('Батареї'), [staleRow()]));
}

// ---------- навігація ----------

const VIEWS = {
  drones: { title: 'Дрони', render: renderDrones, fab: () => droneForm() },
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
  state = await db.loadAll();
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
showNews();
setTimeout(backupReminder, 1500);
sync.onStatus(renderSyncChip);
sync.preload();
sync.syncNow();
refreshRates(today()).catch(() => {});
