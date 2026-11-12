// Дрібні UI-примітиви без фреймворку: елементи, шторка, тост, форма, свайп.
// Скопійовано з shooting-log (без колеса-стрічки й стрілецьких значків).
import { t, locale } from './i18n.js';

export function h(tag, attrs = {}, ...children) {
  const el = document.createElement(tag);
  for (const [key, value] of Object.entries(attrs ?? {})) {
    if (value === undefined || value === null || value === false) continue;
    if (key === 'class') el.className = value;
    else if (key === 'dataset') Object.assign(el.dataset, value);
    else if (key.startsWith('on')) el.addEventListener(key.slice(2), value);
    else if (value === true) el.setAttribute(key, '');
    else el.setAttribute(key, value);
  }
  for (const child of children.flat(Infinity)) {
    if (child === undefined || child === null || child === false) continue;
    el.append(child instanceof Node ? child : document.createTextNode(String(child)));
  }
  return el;
}

const formatters = new Map();

/** Форматер під поточну мову: створюється раз на мову й опції. */
function nf(options) {
  const key = `${locale()}|${JSON.stringify(options)}`;
  if (!formatters.has(key)) formatters.set(key, new Intl.NumberFormat(locale(), options));
  return formatters.get(key);
}

const NUM = { maximumFractionDigits: 3 };
const MONEY = { minimumFractionDigits: 2, maximumFractionDigits: 2 };

export const fmt = {
  num: (n) => nf(NUM).format(Number(n) || 0),
  // Гривня — у самому форматері: інакше валюту довелося б дописувати в кожному рядку.
  money: (n) => `${nf(MONEY).format(Number(n) || 0)} грн`,
  signed: (n) => (n > 0 ? `+${nf(NUM).format(n)}` : nf(NUM).format(n)),
  date: (iso) => (iso ? iso.split('-').reverse().join('.') : t('без дати')),
  time: (ms) => new Date(ms).toLocaleTimeString(locale(), { hour: '2-digit', minute: '2-digit' }),
};

export function vibrate(ms = 12) {
  navigator.vibrate?.(ms);
}

/**
 * Свайп по панелі перемикачів: step(1) — ліворуч (наступний), step(-1) — праворуч (попередній);
 * step повертає true, якщо перемкнув. Горизонтальний рух захоплює панель, тож відпускання й клік
 * дістаються їй, а не кнопці під пальцем — та не перемкне ще раз.
 */
export function swipeStep(el, step) {
  el.classList.add('seg-swipe');
  let start = null;
  el.addEventListener('pointerdown', (e) => {
    if (e.button === 0) start = { x: e.clientX, y: e.clientY, id: e.pointerId, axis: null };
  });
  el.addEventListener('pointermove', (e) => {
    if (!start || e.pointerId !== start.id || start.axis) return;
    const mx = e.clientX - start.x;
    const my = e.clientY - start.y;
    if (Math.abs(mx) < 8 && Math.abs(my) < 8) return;
    start.axis = Math.abs(mx) > Math.abs(my) ? 'x' : 'y';
    if (start.axis === 'x') el.setPointerCapture(e.pointerId);
  });
  const finish = (e) => {
    if (!start || e.pointerId !== start.id) return;
    const { x, axis } = start;
    start = null;
    const dx = e.clientX - x;
    if (e.type !== 'pointerup' || axis !== 'x' || Math.abs(dx) < 40) return;
    if (step(dx < 0 ? 1 : -1)) vibrate();
  };
  el.addEventListener('pointerup', finish);
  el.addEventListener('pointercancel', finish);
  // Посилання мишею інакше починають системне перетягування, і свайп обривається
  el.addEventListener('dragstart', (e) => e.preventDefault());
  return el;
}

/** Нижня шторка. Повертає close(). */
// Відкриті «живі» шторки: картка під іншою шторкою має побачити, що там змінили чи видалили.
const liveSheets = new Set();

/** Перебудовує відкриті живі шторки за свіжим станом; live() поверне null — запису вже нема, шторка закривається. */
export function refreshSheets() {
  for (const s of [...liveSheets]) s();
}

// Шари поверх екрана (шторки, редактори, перегляд фото) мають по запису в історії: «Назад» закриває
// лише верхній, вкладка під ним лишається. Записи вирівнюємо з шарами пачкою після поточного коду —
// закрити й одразу відкрити наступну шторку не смикає історію двічі.
const layers = [];
let entries = 0;
let waiting = false;
let queued = false;
let nextHash = null;

function settle() {
  queued = false;
  if (waiting) return;
  const diff = layers.length - entries;
  for (let i = 0; i < diff; i += 1) history.pushState({ layer: true }, '');
  entries = layers.length;
  if (diff < 0) {
    waiting = true;
    history.go(diff);
    return;
  }
  if (nextHash) {
    location.hash = nextHash;
    nextHash = null;
  }
}
function schedule() {
  if (queued) return;
  queued = true;
  queueMicrotask(settle);
}
window.addEventListener('popstate', () => {
  if (waiting) {
    waiting = false;
    settle();
    return;
  }
  if (!entries) return;
  entries -= 1;
  layers.pop()?.();
});

/** Запис в історії для шару: onBack — що зробити на «Назад». Повертає функцію — викликати, коли шар закрили самі. */
export function backLayer(onBack) {
  layers.push(onBack);
  schedule();
  return () => {
    const i = layers.lastIndexOf(onBack);
    if (i < 0) return;
    layers.splice(i, 1);
    schedule();
  };
}

/** Перейти на вкладку; щойно закритий шар спершу прибирає свій запис, інакше відступ історії скасував би перехід. */
export function goTab(hash) {
  if (queued || waiting) nextHash = hash;
  else location.hash = hash;
}

/**
 * live — функція, що будує тіло заново; з нею шторка оновлюється після refreshSheets().
 * full — на весь екран (картка з великим фото), а не до 92% висоти.
 */
/** lead — кнопка ліворуч від заголовка, окремо від решти (видалення: щоб не натиснути випадково). */
/** title — рядок або функція: у живій шторці заголовок перечитується разом із тілом (перейменували — видно одразу). */
/**
 * dirty — чи є що втратити: тоді фон, ✕, Escape і «Назад» спершу питають (кнопка «Скасувати» закриває одразу).
 * Без dirty шторка з кнопками сама порівнює поля зі знімком при відкритті — питає, лише якщо людина щось змінила;
 * dirty: false — не питати ніколи (фільтр, де закрити = скасувати).
 */
export function sheet(title, body, { actions = [], onClose, live, tools = [], lead = null, full = false, dirty = null } = {}) {
  const titleOf = () => (typeof title === 'function' ? title() : title);
  const layer = document.getElementById('layer');
  const opener = document.activeElement;
  let closed = false;
  const close = () => {
    // Шторка зникає 180 мс — увесь цей час вона глуха: другий тап по «Зберегти» не запише вдруге
    if (closed) return;
    closed = true;
    backdrop.inert = true;
    document.removeEventListener('keydown', onKey);
    // Фокус — назад на кнопку, що відкрила; поле вводу не чіпаємо, щоб на телефоні не вискакувала клавіатура
    if (opener?.isConnected && !opener.matches('input, textarea') && backdrop.contains(document.activeElement)) opener.focus({ preventScroll: true });
    liveSheets.delete(rebuild);
    backdrop.classList.remove('open');
    setTimeout(() => backdrop.remove(), 180);
    unlayer();
    onClose?.();
  };
  const ask = () => {
    if (closed) return;
    if (!dirty?.()) { close(); return; }
    confirmSheet(t('Вийти без збереження?'), t('Введене не збережеться.'), t('Вийти'), close);
  };
  // «Назад» уже забрав запис шторки: є що втратити — повертаємо запис і питаємо
  const onBack = () => {
    if (!dirty?.()) { close(); return; }
    unlayer = backLayer(onBack);
    ask();
  };
  const rebuild = () => {
    const next = live();
    if (!next) { close(); return; }
    panel.querySelector('.sheet-head h2').textContent = titleOf();
    panel.setAttribute('aria-label', titleOf());
    const box = panel.querySelector('.sheet-body');
    const top = box.scrollTop;
    // Фокус (клавіатура, читалка екрана) — на той самий за порядком елемент, інакше він злітає на початок сторінки
    const focusable = () => [...box.querySelectorAll('button, [href], input, select, textarea, [tabindex]')];
    const at = box.contains(document.activeElement) ? focusable().indexOf(document.activeElement) : -1;
    box.replaceChildren(next);
    box.scrollTop = top;
    if (at >= 0) focusable()[at]?.focus({ preventScroll: true });
  };
  if (live) liveSheets.add(rebuild);
  // Червоні дії (кошик) — завжди ліворуч від назви, подалі від ✕: поряд із ним легко схибити
  const danger = [tools].flat(Infinity).filter((x) => x?.classList?.contains('danger'));
  const rest = [tools].flat(Infinity).filter((x) => !danger.includes(x));
  const left = [danger, lead].flat(Infinity).filter(Boolean);
  const panel = h('section', { class: full ? 'sheet full' : 'sheet', role: 'dialog', 'aria-label': titleOf() },
    h('div', { class: 'sheet-grip' }),
    h('header', { class: 'sheet-head' },
      left.length ? h('div', { class: 'sheet-lead' }, left) : null,
      h('h2', {}, titleOf()),
      h('div', { class: 'sheet-tools' }, rest,
        h('button', { type: 'button', class: 'icon-btn', 'aria-label': t('Закрити'), onclick: ask }, '✕'))),
    h('div', { class: 'sheet-body' }, body),
    actions.length ? h('footer', { class: 'sheet-actions' }, actions) : null);
  if (dirty === null && actions.length) {
    const body = panel.querySelector('.sheet-body');
    const snap = () => [...body.querySelectorAll('input, select, textarea, .chips')]
      .map((el) => (el.matches('.chips') ? String(el.value) : el.type === 'checkbox' || el.type === 'radio' ? el.checked : el.value)).join('\u0001');
    // знімок — коли форма вже домальована; зміни з коду (автопідстановка) без дотику людини не рахуються
    let base = null, touched = false;
    requestAnimationFrame(() => { base = snap(); });
    const touch = (e) => { if (e.isTrusted) touched = true; };
    body.addEventListener('input', touch);
    body.addEventListener('change', touch);
    body.addEventListener('click', (e) => { if (e.target.closest('.chips button')) touch(e); });
    dirty = () => touched && base !== null && snap() !== base;
  }
  // Закривати лише якщо й натиск почався на фоні: інакше на сенсорному екрані «фантомний» клік
  // після тапу по картці падає на щойно відкритий фон і одразу закриває шторку.
  let downOnBackdrop = false;
  const backdrop = h('div', {
    class: 'backdrop',
    onpointerdown: (e) => { downOnBackdrop = e.target === backdrop; },
    onclick: (e) => { if (e.target === backdrop && downOnBackdrop) ask(); downOnBackdrop = false; },
  }, panel);
  // Кнопки закритої шторки мовчать і для клавіатури, і для кліку з коду — inert зупиняє лише дотик
  panel.addEventListener('click', (e) => { if (closed) { e.stopImmediatePropagation(); e.preventDefault(); } }, true);
  panel.tabIndex = -1;
  // Escape закриває лише верхню шторку; редактор мішені чи фото поверх неї слухає свій
  const onKey = (e) => { if (e.key === 'Escape' && layer.lastElementChild === backdrop) { e.preventDefault(); ask(); } };
  document.addEventListener('keydown', onKey);
  layer.append(backdrop);
  requestAnimationFrame(() => {
    backdrop.classList.add('open');
    // Читалка й клавіатура опиняються в шторці, а не на сторінці під нею
    if (!closed && !panel.contains(document.activeElement)) panel.focus({ preventScroll: true });
  });
  let unlayer = backLayer(onBack);
  return close;
}

let toastTimer;

/** reminder — нагадування: лежить під шторкою, а не над нею, щоб не закривати її кнопки. */
export function toast(message, { action, onAction, reminder = false, timeout = action ? 8000 : 3500 } = {}) {
  // Нагадування не перебиває тост із дією (наприклад, «Отменить» після видалення) — покажеться наступного разу
  if (reminder && document.querySelector('.toast:not(.reminder) button')) return;
  document.querySelector('.toast')?.remove();
  clearTimeout(toastTimer);
  const root = document.documentElement.style;
  // поки тост на екрані, кнопка «+» піднімається над ним, а не ховається під ним
  const remove = () => { el.remove(); if (!document.querySelector('.toast')) root.removeProperty('--toast-lift'); };
  const el = h('div', { class: reminder ? 'toast reminder' : 'toast', role: 'status' }, h('span', {}, message),
    action ? h('button', { type: 'button', onclick: () => { remove(); onAction(); } }, action) : null);
  // змахнути вбік — закрити, не чекаючи таймера
  let x0 = null;
  el.addEventListener('pointerdown', (e) => { if (!e.target.closest('button')) { x0 = e.clientX; el.setPointerCapture(e.pointerId); } });
  el.addEventListener('pointermove', (e) => {
    if (x0 == null) return;
    const dx = e.clientX - x0;
    el.style.translate = `${dx}px 0`; el.style.opacity = String(Math.max(0.2, 1 - Math.abs(dx) / 200));
  });
  const up = (e) => {
    if (x0 == null) return;
    const dx = e.clientX - x0; x0 = null;
    if (Math.abs(dx) > 60) { clearTimeout(toastTimer); remove(); } else { el.style.translate = ''; el.style.opacity = ''; }
  };
  el.addEventListener('pointerup', up);
  el.addEventListener('pointercancel', up);
  document.body.append(el);
  root.setProperty('--toast-lift', `${el.offsetHeight + 8}px`);
  toastTimer = setTimeout(remove, timeout);
}

/**
 * Перша видима «точка» елемента: він сам або заголовок згорнутої групи, в якій він лежить
 * (групу не розгортаємо — вона пам'ятає свій стан).
 */
function visibleAnchor(el) {
  // вміст закритого <details> Chrome не ховає з розкладки — getClientRects його не відсіює
  let hidden = null;
  for (let p = el.parentElement; p; p = p.parentElement) {
    if ((p.tagName === 'DETAILS' && !p.open) || p.classList.contains('closed')) hidden = p;
  }
  const target = hidden ? hidden.querySelector(':scope > summary, :scope > legend') : el;
  return target?.getClientRects().length ? target : null;
}

/** Де лежить запис id: його картка чи рядок, а якщо згорнута група ще не будувала рядків — її заголовок. */
function holders(id) {
  const q = CSS.escape(id);
  return [...document.querySelectorAll(`[data-id="${q}"]`), ...document.querySelectorAll(`details[data-has~="${q}"]:not([open]) > summary`)];
}

function flash(target) {
  target.classList.remove('flash');
  void target.offsetWidth;   // перезапуск анімації, якщо картка ще світиться
  target.classList.add('flash');
  target.addEventListener('animationend', () => target.classList.remove('flash'), { once: true });
}

/** Підтвердження без таблички: коротка вібрація й підсвічені картки того, що змінилося. */
export function confirmed(ids = []) {
  navigator.vibrate?.(20);
  for (const id of new Set(ids.filter(Boolean))) {
    for (const el of holders(id)) {
      const target = visibleAnchor(el);
      if (target) flash(target);
    }
  }
}

/** Прокрутити до картки id і підсвітити; екран ще малюється — кілька спроб. Повертає, чи знайшли. */
export function reveal(id, tries = 10) {
  const el = holders(id)[0];
  const target = el && visibleAnchor(el);
  if (!target) { if (tries > 0) setTimeout(() => reveal(id, tries - 1), 60); return; }
  target.scrollIntoView({ block: 'center', behavior: matchMedia('(prefers-reduced-motion: reduce)').matches ? 'auto' : 'smooth' });
  flash(target);
}

let undoFn = null;
let undoBtn = null;

/** «Скасувати» в шапці: без таймера, живе до наступної зміни даних. */
export function setUndo(label, fn) {
  if (!undoBtn) {
    undoBtn = h('button', { type: 'button', class: 'undo-btn', hidden: true }, h('span', { 'aria-hidden': 'true' }, '↶'), h('span', {}, t('Скасувати')));
    undoBtn.addEventListener('click', async () => {
      const run = undoFn;
      clearUndo();
      await run?.();
      confirmed();
    });
    document.querySelector('.topbar-actions')?.prepend(undoBtn);
  }
  undoFn = fn;
  undoBtn.title = label;
  undoBtn.setAttribute('aria-label', `${t('Скасувати')}: ${label}`);
  undoBtn.hidden = false;
}

export function clearUndo() {
  undoFn = null;
  if (undoBtn) undoBtn.hidden = true;
}

// Будь-який новий запис робить скасування застарілим (синхронізація цієї події не шле).
window.addEventListener('db-change', clearUndo);
// Синхронізація принесла чужі зміни — старий знімок для скасування перетер би новішу правку з іншого пристрою
window.addEventListener('sync-applied', (e) => { if (e.detail?.remote) clearUndo(); });

/** Помилка під полем: рамка й текст, зникають, щойно поле виправляють. */
export function fieldError(input, message) {
  const field = input?.closest('.field');
  if (!field) { formError(message); return; }
  field.querySelector(':scope > .field-error')?.remove();
  field.classList.add('invalid');
  const note = h('small', { class: 'field-error', role: 'alert' }, message);
  field.append(note);
  const clear = () => { field.classList.remove('invalid'); note.remove(); };
  input.addEventListener('input', clear, { once: true });
  input.addEventListener('change', clear, { once: true });
  // Поле в згорнутому блоці — спершу розгортаємо, інакше помилку не видно
  field.closest('.foldable.closed')?.querySelector(':scope > legend > .box-toggle')?.click();
  input.scrollIntoView({ block: 'center', behavior: matchMedia('(prefers-reduced-motion: reduce)').matches ? 'auto' : 'smooth' });
  input.focus?.({ preventScroll: true });
}

/** Помилка без окремого поля — рядком над кнопками відкритої шторки; немає шторки — тостом. */
export function formError(message) {
  const panel = [...document.querySelectorAll('.sheet')].pop();
  const foot = panel?.querySelector('.sheet-actions');
  if (!foot) { toast(message); return; }
  panel.querySelector('.form-error')?.remove();
  const note = h('p', { class: 'form-error', role: 'alert' }, message);
  foot.before(note);
  const clear = () => note.remove();
  panel.addEventListener('input', clear, { once: true });
  panel.addEventListener('change', clear, { once: true });
}

const pad2 = (n) => String(n).padStart(2, '0');
const TURN = Math.PI * 2;
// Години як на циферблаті Android: зовні 12, 1…11, всередині 00, 13…23
const outerHour = (i) => (i === 0 ? 12 : i);
const innerHour = (i) => (i === 0 ? 0 : i + 12);
// Внутрішнє коло — ближче за цю частку радіуса циферблата
const INNER_RING = 0.62;

/**
 * Вибір часу циферблатом, як в Android: тап чи палець по колу — година, далі коло хвилин (крок 5).
 * Шторка поверх форми; '' — «Без часу», null — закрили без вибору.
 */
export function pickTime(value, title) {
  return new Promise((resolve) => {
    let [hh, mm] = (value || new Date().toTimeString().slice(0, 5)).split(':').map(Number);
    let mode = 'h';
    let result = null;
    const hBtn = h('button', { type: 'button', class: 'tp-part', onclick: () => { mode = 'h'; draw(); } });
    const mBtn = h('button', { type: 'button', class: 'tp-part', onclick: () => { mode = 'm'; draw(); } });
    const dial = h('div', { class: 'tp-dial', role: 'group' });
    const hand = h('span', { class: 'tp-hand', 'aria-hidden': 'true' });
    // Позиція на колі: індекс 0–11 від 12-ї години за стрілкою, r — частка радіуса
    const place = (el, i, r) => {
      const a = (i / 12) * TURN;
      el.style.left = `${50 + Math.sin(a) * r * 50}%`;
      el.style.top = `${50 - Math.cos(a) * r * 50}%`;
    };
    const num = (label, on, i, r, pick, inner = false) => {
      const b = h('button', {
        type: 'button', class: `tp-num${inner ? ' inner' : ''}${on ? ' on' : ''}`, tabindex: on ? 0 : -1,
        // Мишею й пальцем обирає коло (pointer-обробник), кнопка — для клавіатури
        onclick: (e) => { if (e.detail === 0) pick(); },
      }, label);
      place(b, i, r);
      return b;
    };
    const draw = () => {
      hBtn.textContent = pad2(hh);
      mBtn.textContent = pad2(mm);
      hBtn.classList.toggle('on', mode === 'h');
      mBtn.classList.toggle('on', mode === 'm');
      dial.setAttribute('aria-label', mode === 'h' ? t('Година') : t('Хвилини'));
      const nums = [];
      let handI;
      let handR = 0.8;
      if (mode === 'h') {
        for (let i = 0; i < 12; i++) {
          nums.push(num(String(outerHour(i)), hh === outerHour(i), i, 0.8, () => setHour(outerHour(i))));
          nums.push(num(pad2(innerHour(i)), hh === innerHour(i), i, 0.5, () => setHour(innerHour(i)), true));
        }
        handI = hh % 12;
        if (hh === 0 || hh > 12) handR = 0.5;
      } else {
        for (let i = 0; i < 12; i++) nums.push(num(pad2(i * 5), mm === i * 5, i, 0.8, () => setMinute(i * 5)));
        handI = mm / 5;
      }
      hand.style.transform = `rotate(${(handI / 12) * 360}deg)`;
      hand.style.height = `${handR * 50}%`;
      dial.replaceChildren(hand, h('span', { class: 'tp-center', 'aria-hidden': 'true' }), ...nums);
    };
    const setHour = (v) => { hh = v; mode = 'm'; draw(); };
    const setMinute = (v) => { mm = v; draw(); };
    // Палець по колу: найближча поділка; для години — ще й коло (зовнішнє чи внутрішнє)
    const fromPointer = (e) => {
      const r = dial.getBoundingClientRect();
      const dx = e.clientX - (r.left + r.width / 2);
      const dy = e.clientY - (r.top + r.height / 2);
      const i = Math.round((((Math.atan2(dx, -dy) + TURN) % TURN) / TURN) * 12) % 12;
      if (mode === 'h') hh = Math.hypot(dx, dy) < (r.width / 2) * INNER_RING ? innerHour(i) : outerHour(i);
      else mm = i * 5;
      draw();
    };
    let dragging = false;
    dial.addEventListener('pointerdown', (e) => {
      dragging = true;
      try { dial.setPointerCapture(e.pointerId); } catch { /* вказівник уже відпущено */ }
      fromPointer(e);
    });
    dial.addEventListener('pointermove', (e) => { if (dragging) fromPointer(e); });
    dial.addEventListener('pointerup', () => {
      if (!dragging) return;
      dragging = false;
      if (mode === 'h') { mode = 'm'; draw(); }
    });
    dial.addEventListener('pointercancel', () => { dragging = false; });
    draw();
    const done = (v) => { result = v; close(); };
    const close = sheet(title, h('div', { class: 'tp' },
      h('p', { class: 'tp-now' }, hBtn, h('span', { 'aria-hidden': 'true' }, ':'), mBtn), dial), {
      actions: [
        value ? h('button', { type: 'button', class: 'btn', onclick: () => done('') }, t('Без часу')) : null,
        h('button', { type: 'button', class: 'btn primary', onclick: () => done(`${pad2(hh)}:${pad2(mm)}`) }, t('Готово')),
      ].filter(Boolean),
      onClose: () => resolve(result),
    });
  });
}

/** Поле часу замість input type=time: кнопка «ГГ:ХХ» відкриває циферблат; value й події input/change — як у input. */
function timeInput(value, label) {
  let current = '';
  const el = h('button', { type: 'button', class: 'time-field', 'aria-label': label });
  Object.defineProperty(el, 'value', {
    get: () => current,
    set: (v) => { current = v ?? ''; el.textContent = current || '--:--'; },
  });
  el.value = value ?? '';
  el.addEventListener('click', async () => {
    const v = await pickTime(current, label);
    if (v === null || v === current) return;
    el.value = v;
    el.dispatchEvent(new Event('input', { bubbles: true }));
    el.dispatchEvent(new Event('change', { bubbles: true }));
  });
  return el;
}

/** Пункти <select>: [value, label] або група { group, options: [[value, label], …] }. */
export function selectOptions(options, selected) {
  const option = ([value, label]) => h('option', { value, selected: String(value) === String(selected ?? '') }, label);
  return options.map((o) => (Array.isArray(o) ? option(o) : o.options.length ? h('optgroup', { label: o.group }, o.options.map(option)) : null));
}

/**
 * Проста форма. fields: [{ name, label, type, value, options, required, step, min, list, hint, half }]
 * half — поле на пів рядка: два такі поля поспіль стають в одну строку.
 * type: text | number | date | select | textarea | chips
 */
export function form(fields) {
  const inputs = {};
  const el = h('div', { class: 'form' });
  for (const f of fields) {
    let input;
    if (f.type === 'select') {
      input = h('select', { name: f.name }, selectOptions(f.options, f.value));
    } else if (f.type === 'textarea') {
      input = h('textarea', { name: f.name, rows: f.rows ?? 2, placeholder: f.placeholder });
      input.value = f.value ?? '';
    } else if (f.type === 'chips') {
      input = chips(f.options, f.value, f.onPick);
    } else if (f.type === 'dmy') {
      input = dmyInput(f.value);
    } else if (f.type === 'time') {
      input = timeInput(f.value, f.label);
    } else {
      input = h('input', {
        name: f.name, type: f.type ?? 'text', step: f.step, min: f.min, list: f.list,
        inputmode: f.type === 'number' ? 'decimal' : undefined,
        placeholder: f.placeholder, autocomplete: 'off',
      });
      input.value = f.value ?? '';
    }
    inputs[f.name] = input;
    // Чипи — не в <label>: тап по підпису «натискав» би перший чип
    el.append(h(f.type === 'chips' ? 'div' : 'label', { class: `field ${f.wide ? 'wide' : ''} ${f.half ? 'half' : ''}` },
      f.label ? h('span', { class: 'field-label' }, f.label) : null, input,
      f.hint ? h('small', { class: 'muted' }, f.hint) : null));
  }
  const values = () => {
    const out = {};
    for (const f of fields) {
      const input = inputs[f.name];
      let v = input.value;
      if (f.type === 'number') v = v === '' ? null : Number(String(v).replace(',', '.'));
      if (f.type === 'dmy') v = dmyToIso(v) ?? (v.trim() ? NaN : '');
      out[f.name] = typeof v === 'string' ? v.trim() : v;
    }
    return out;
  };
  const invalid = () => fields.find((f) => {
    const v = values()[f.name];
    return (f.required && (v === '' || v === null)) || ((f.type === 'number' || f.type === 'dmy') && Number.isNaN(v));
  });
  return { el, inputs, values, invalid };
}

/** «2026-11-03» → «03.11.2026». */
export function isoToDmy(iso) {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(iso ?? '');
  return m ? `${m[3]}.${m[2]}.${m[1]}` : '';
}

/** «03.11.2026» або «3.11.26» → «2026-11-03»; null — не дата (31.02 теж). */
export function dmyToIso(text) {
  const m = /^(\d{1,2})\.(\d{1,2})\.(\d{2}|\d{4})$/.exec(String(text ?? '').trim());
  if (!m) return null;
  const [d, mo, y] = [Number(m[1]), Number(m[2]), Number(m[3].length === 2 ? `20${m[3]}` : m[3])];
  const date = new Date(Date.UTC(y, mo - 1, d));
  if (date.getUTCMonth() !== mo - 1 || date.getUTCDate() !== d) return null;
  return date.toISOString().slice(0, 10);
}

/**
 * Дата цифрами замість календаря: на роки вперед чи назад календар гортає місяць за місяцем.
 * Крапки ставляться самі: 03112026 → 03.11.2026; рік можна двома цифрами.
 */
function dmyInput(iso) {
  const input = h('input', { type: 'text', inputmode: 'numeric', placeholder: t('ДД.ММ.РРРР'), maxlength: 10, autocomplete: 'off', class: 'dmy' });
  input.value = isoToDmy(iso);
  input.addEventListener('input', () => {
    // Частина перед роздільником завершена: «3.» — це день 03, а не початок «31»
    const parts = input.value.split(/\D+/);
    let d = '';
    parts.forEach((p, i) => { d += i < parts.length - 1 && p.length === 1 && d.length < 4 ? `0${p}` : p; });
    d = d.slice(0, 8);
    input.value = d.slice(0, 2) + (d.length > 2 ? `.${d.slice(2, 4)}` : '') + (d.length > 4 ? `.${d.slice(4)}` : '');
  });
  // Вийшли з поля — рік повністю: 14.10.23 → 14.10.2023
  input.addEventListener('blur', () => { const iso = dmyToIso(input.value); if (iso) input.value = isoToDmy(iso); });
  return input;
}

/** Ряд кнопок-чипів; клік вставляє значення. Повертає контейнер з полем .value. */
export function chips(options, value, onPick) {
  const wrap = h('div', { class: 'chips' });
  wrap.value = value ?? '';
  const sync = () => wrap.querySelectorAll('button').forEach((b) => b.classList.toggle('on', b.dataset.value === String(wrap.value)));
  for (const opt of options) {
    const [val, label] = Array.isArray(opt) ? opt : [opt, opt];
    wrap.append(h('button', {
      type: 'button', dataset: { value: val },
      onclick: () => { wrap.value = String(val); sync(); onPick?.(val); },
    }, label));
  }
  sync();
  return wrap;
}

/**
 * Свайп картки: вправо — onRight, вліво — onLeft. Вертикальний скрол лишається браузеру
 * (touch-action: pan-y), горизонтальний рух перехоплюємо. onSwipe — після будь-якого спрацьованого свайпу.
 */
export function swipeable(card, { onRight, onLeft, onTap, onSwipe, rightLabel, leftLabel }) {
  const body = card.querySelector('.swipe-body');
  card.classList.add('swipe');
  card.prepend(
    h('div', { class: 'swipe-bg right' }, rightLabel ?? ''),
    h('div', { class: 'swipe-bg left' }, leftLabel ?? ''));
  card.tabIndex = 0;
  card.addEventListener('keydown', (e) => { if (e.key === 'Enter') onTap?.(); });
  let start = null;
  let axis = null;
  let dx = 0;
  let armed = false;

  const reset = () => {
    body.style.transition = 'transform .18s ease';
    body.style.transform = '';
    card.classList.remove('armed', 'dir-right', 'dir-left');
    start = null; axis = null; dx = 0; armed = false;
  };

  card.addEventListener('pointerdown', (e) => {
    if (e.button !== 0 || e.target.closest('button, a, input')) return;
    start = { x: e.clientX, y: e.clientY, id: e.pointerId };
    axis = null; dx = 0; tapArmed = false;
    body.style.transition = 'none';
  });
  card.addEventListener('pointermove', (e) => {
    if (!start || e.pointerId !== start.id) return;
    const mx = e.clientX - start.x;
    const my = e.clientY - start.y;
    if (!axis) {
      if (Math.abs(mx) < 8 && Math.abs(my) < 8) return;
      axis = Math.abs(mx) > Math.abs(my) ? 'x' : 'y';
      if (axis === 'x') card.setPointerCapture(start.id);
    }
    if (axis !== 'x') return;
    dx = mx;
    if ((dx > 0 && !onRight) || (dx < 0 && !onLeft)) dx = 0;
    body.style.transform = `translateX(${dx}px)`;
    card.classList.toggle('dir-right', dx > 0);
    card.classList.toggle('dir-left', dx < 0);
    const nowArmed = Math.abs(dx) > card.clientWidth * 0.3;
    if (nowArmed !== armed) { armed = nowArmed; card.classList.toggle('armed', armed); if (armed) vibrate(); }
  });
  const finish = (e) => {
    if (!start || e.pointerId !== start.id) return;
    const wasAxis = axis;
    const wasArmed = armed;
    const dir = dx;
    reset();
    if (wasAxis === 'x') {
      if (wasArmed) { onSwipe?.(); (dir > 0 ? onRight : onLeft)?.(); }
    } else if (!wasAxis && e.type === 'pointerup') {
      tapArmed = true;
    }
  };
  // Тап відкриваємо на click, а не на pointerup: click приходить останнім,
  // тож після відкриття шторки вже нема «фантомного» кліку, який її закриє.
  let tapArmed = false;
  card.addEventListener('click', () => {
    if (!tapArmed) return;
    tapArmed = false;
    onTap?.();
  });
  card.addEventListener('pointerup', finish);
  card.addEventListener('pointercancel', finish);
  return card;
}

const TOOL_ICON = {
  edit: '<path d="M4 20h4L19 9l-4-4L4 16z"/><path d="M13.5 6.5l4 4"/>',
  delete: '<path d="M4 7h16M10 11v6M14 11v6"/><path d="M6 7l1 13h10l1-13M9 7V4h6v3"/>',
  copy: '<path d="M8 8h12v12H8z"/><path d="M16 8V4H4v12h4"/>',
  share: '<path d="M12 3v13"/><path d="M8 7l4-4 4 4"/><path d="M5 14v6h14v-6"/>',
  reset: '<path d="M4 4v6h6"/><path d="M5.6 15a7 7 0 1 0 1.5-7.4L4 10"/>',
  cloud: '<path d="M7 18.5a4.5 4.5 0 0 1-.5-9 6 6 0 0 1 11.6 1.6 3.7 3.7 0 0 1-.6 7.4z"/>',
  save: '<path d="M12 4v11M8 11l4 4 4-4"/><path d="M5 15v5h14v-5"/>',
  database: '<ellipse cx="12" cy="5.5" rx="7.5" ry="2.8"/><path d="M4.5 5.5v13c0 1.5 3.4 2.8 7.5 2.8s7.5-1.3 7.5-2.8v-13M4.5 12c0 1.5 3.4 2.8 7.5 2.8s7.5-1.3 7.5-2.8"/>',
  play: '<circle cx="12" cy="12" r="9"/><path d="M10 8.5v7l5.5-3.5z"/>',
  globe: '<circle cx="12" cy="12" r="9"/><path d="M3 12h18M12 3c2.5 2.7 3.8 5.7 3.8 9s-1.3 6.3-3.8 9c-2.5-2.7-3.8-5.7-3.8-9S9.5 5.7 12 3z"/>',
  palette: '<path d="M12 3a9 9 0 0 0 0 18c1.3 0 2-.9 2-1.9 0-1.1-.9-1.6-.9-2.7 0-1 .8-1.9 1.9-1.9H17a4 4 0 0 0 4-4C21 6.5 17 3 12 3z"/><circle cx="7.5" cy="11.5" r="1.2"/><circle cx="10" cy="7.3" r="1.2"/><circle cx="15" cy="7.5" r="1.2"/>',
  undo: '<path d="M9 14L4 9l5-5"/><path d="M4 9h10.5a5.5 5.5 0 0 1 0 11H11"/>',
  camera: '<path d="M3 8.5h4l2-3h6l2 3h4V19H3z"/><circle cx="12" cy="13" r="3.5"/>',
  gallery: '<rect x="3" y="4.5" width="18" height="15" rx="2"/><circle cx="8.5" cy="9.5" r="1.5"/><path d="M21 15.5l-5-5-8.5 9"/>',
  paste: '<path d="M9 3.5h6v3H9z"/><path d="M9 5H5.5v15.5h13V5H15"/><path d="M9 12h6M9 16h4"/>',
  filter: '<path d="M4 5h16l-6.2 7.6V19l-3.6 1.6v-8z"/>',
  stock: '<path d="M3 21V8.5L12 3l9 5.5V21"/><path d="M7 21v-9h10v9M7 15h10M7 18h10"/>',
  // батарея: «+цикл», стан
  battery: '<rect x="3" y="7" width="16" height="10" rx="2"/><path d="M21 10.5v3M7 10v4M10.5 10v4"/>',
  // гайковий ключ — прошивка/обслуговування
  wrench: '<path d="M14.5 3.5a5 5 0 0 0-5.6 6.7L3.5 15.6v4.9h4.9l5.4-5.4a5 5 0 0 0 6.7-5.6l-3 3-3.5-.5-.5-3.5z"/>',
  // нотатка
  note: '<path d="M5 3h10l4 4v14H5z"/><path d="M9 11h6M9 15h6"/>',
  // сегменти Складу й Польотів: деталь (мікросхема), розхідник (пропелер), замовлення (чек), «хочу» (серце),
  // журнал (список), статистика (стовпчики), перед польотом (вітер)
  chip: '<rect x="7" y="7" width="10" height="10" rx="1.5"/><path d="M10 7V3.5M14 7V3.5M10 20.5V17M14 20.5V17M7 10H3.5M7 14H3.5M20.5 10H17M20.5 14H17"/>',
  prop: '<circle cx="12" cy="12" r="1.8"/><path d="M12 10.2C11.2 6 12.4 3.5 15 3.5c1.6 0 2 1.8.6 3.3zM13.6 12.9c4 1.4 5.4 4 4.1 6.2-.8 1.4-2.6.8-3.2-1.1zM10.4 12.9c-3.2 2.8-6.2 2.7-7.4.5-.8-1.4.6-2.6 2.6-2.1z"/>',
  receipt: '<path d="M6 3h12v18l-3-2-3 2-3-2-3 2z"/><path d="M9 8h6M9 12h6M9 16h3"/>',
  heart: '<path d="M12 20s-7.5-4.6-7.5-10A4.3 4.3 0 0 1 12 7.4 4.3 4.3 0 0 1 19.5 10c0 5.4-7.5 10-7.5 10z"/>',
  list: '<path d="M9 6h11M9 12h11M9 18h11"/><circle cx="4.5" cy="6" r="1"/><circle cx="4.5" cy="12" r="1"/><circle cx="4.5" cy="18" r="1"/>',
  chart: '<path d="M4 20V4M4 20h16"/><path d="M8.5 16v-4M12.5 16V8M16.5 16v-6"/>',
  wind: '<path d="M3 9h11a3 3 0 1 0-3-3"/><path d="M3 15h15a3 3 0 1 1-3 3"/><path d="M3 12h7"/>',
  // рядок коду — конфіг
  code: '<path d="M8 7l-5 5 5 5M16 7l5 5-5 5M13.5 4l-3 16"/>',
};

/** Зірка «найкраще»: SVG, бо гліф ★ у кожному шрифті сидить на своїй висоті й не стає по цифрах поруч. */
export function starIcon(label) {
  const el = h('span', { class: 'star-ico', role: 'img', title: label, 'aria-label': label });
  el.innerHTML = '<svg viewBox="1.7 1.5 20.6 19.6" aria-hidden="true"><path d="M12 1.5l3.1 6.6 7.2.9-5.3 5 1.4 7.1L12 17.6l-6.4 3.5L7 14l-5.3-5 7.2-.9z"/></svg>';
  return el;
}

/** Іконка з набору TOOL_ICON — для своїх кнопок. */
export function icon(name) {
  const el = h('span', { class: 'ico', 'aria-hidden': 'true' });
  el.innerHTML = `<svg viewBox="0 0 24 24">${TOOL_ICON[name]}</svg>`;
  return el;
}

/** Кнопка-іконка в шапці шторки. */
/** Значок без кнопки — той самий, що на кнопці-іконці; для підказок у тексті. */
export function toolIcon(icon) {
  const el = h('span', { class: 'tool-ico', 'aria-hidden': 'true' });
  el.innerHTML = `<svg viewBox="0 0 24 24">${TOOL_ICON[icon]}</svg>`;
  return el;
}

export function toolBtn(icon, label, onclick, cls = '') {
  const el = h('button', { type: 'button', class: `icon-btn tool ${cls}`, 'aria-label': label, title: label, onclick });
  el.innerHTML = `<svg viewBox="0 0 24 24" aria-hidden="true">${TOOL_ICON[icon]}</svg>`;
  return el;
}

export function confirmSheet(title, text, okLabel, onOk) {
  const close = sheet(title, h('p', {}, text), {
    actions: [
      h('button', { type: 'button', class: 'btn', onclick: () => close() }, t('Скасувати')),
      h('button', { type: 'button', class: 'btn danger', onclick: () => { close(); onOk(); } }, okLabel),
    ],
  });
}

