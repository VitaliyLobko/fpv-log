// Мова інтерфейсу. Ключ — український текст: він же й показується. Інша мова — словник
// «український ключ → переклад» (js/ru.js) і рядок у LANGS; без збереженого вибору — українська.
// Параметри підставляються як {name}. Вибір мови зберігається на пристрої.
import { RU } from './ru.js';

const KEY = 'fpv-log:lang';
export const LANGS = { uk: 'Українська', ru: 'Русский' };
const LOCALES = { uk: 'uk-UA', ru: 'ru-RU' };
const DICT = { ru: RU };

let current = load();
let collator = null;
const warned = new Set();

function load() {
  try {
    const v = localStorage.getItem(KEY);
    return LANGS[v] ? v : 'uk';
  } catch {
    return 'uk';
  }
}

export const lang = () => current;
export const locale = () => LOCALES[current] ?? 'uk-UA';

export function setLang(code) {
  if (!LANGS[code]) return;
  current = code;
  collator = null;
  try { localStorage.setItem(KEY, code); } catch { /* приватний режим */ }
}

/** Порівняння рядків за правилами поточної мови (і, ї, є, ґ стають на свої місця). */
export function collate(a, b) {
  collator ??= new Intl.Collator(locale(), { numeric: true, sensitivity: 'base' });
  return collator.compare(String(a ?? ''), String(b ?? ''));
}

export function t(key, params) {
  let text = key;
  const dict = DICT[current];
  if (dict) {
    if (key in dict) text = dict[key];
    else if (!warned.has(key)) { warned.add(key); console.warn('i18n: немає перекладу', key); }
  }
  return params ? text.replace(/\{(\w+)\}/g, (m, name) => (name in params ? params[name] : m)) : text;
}

/** Форма слова за числом: forms — [один, кілька, багато] (1 виїзд, 2 виїзди, 5 виїздів). */
export function plural(n, forms) {
  const kind = new Intl.PluralRules(locale()).select(Math.abs(n));
  return forms[kind === 'one' ? 0 : kind === 'few' ? 1 : 2];
}

/** Статичні тексти index.html: data-i18n — текст, data-i18n-aria — aria-label. */
export function applyStatic() {
  document.documentElement.lang = current;
  document.title = 'FPV Log';
  document.querySelectorAll('[data-i18n]').forEach((el) => { el.textContent = t(el.dataset.i18n); });
  document.querySelectorAll('[data-i18n-aria]').forEach((el) => el.setAttribute('aria-label', t(el.dataset.i18nAria)));
}
