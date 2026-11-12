// Інтерфейс — лише українською. t() лишився, щоб не переписувати сотні викликів: ключ і є текст, {name} — підстановка.
export const locale = () => 'uk-UA';

const collator = new Intl.Collator('uk-UA', { numeric: true, sensitivity: 'base' });

/** Порівняння рядків за українськими правилами (і, ї, є, ґ стають на свої місця). */
export const collate = (a, b) => collator.compare(String(a ?? ''), String(b ?? ''));

export function t(text, params) {
  return params ? text.replace(/\{(\w+)\}/g, (m, name) => (name in params ? params[name] : m)) : text;
}
