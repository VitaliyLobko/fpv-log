// Курс долара НБУ на дату: вшита історія (usd-rates.js, з shooting-log) + дні після неї з API НБУ, кеш у localStorage.
// Замовлення в доларах переводимо в гривні курсом дня покупки.
import { FROM, RATES } from './usd-rates.js';

const KEY = 'fpv-log:usd-rates';
const DAY = 864e5;
const BASE = Date.parse(`${FROM}T00:00:00Z`);
// Без мережі старше цього не тягнемо: такі дні приїдуть з наступним релізом разом з історією
const MAX_FETCH = 45;

let extra = load();

function load() {
  try { return JSON.parse(localStorage.getItem(KEY)) ?? {}; } catch { return {}; }
}

const index = (iso) => Math.round((Date.parse(`${iso.slice(0, 10)}T00:00:00Z`) - BASE) / DAY);
const isoAt = (i) => new Date(BASE + i * DAY).toISOString().slice(0, 10);

/** Курс (грн за $1) на день ISO; вихідні — курсом попереднього робочого дня; до 2014 — null. */
export function rateOn(iso) {
  if (typeof iso !== 'string' || !/^\d{4}-\d{2}-\d{2}/.test(iso)) return null;
  let i = index(iso);
  if (i < 0) return null;
  // Після вшитої історії — докачані дні, крок назад через вихідні; нема — останній відомий
  for (let back = 0; i >= RATES.length && back < 10; back++, i--) {
    if (extra[isoAt(i)]) return extra[isoAt(i)];
  }
  return RATES[Math.min(i, RATES.length - 1)];
}

/**
 * Дотягнути з НБУ дні після вшитої історії до сьогодні (запит на день — для діапазону НБУ не дає CORS).
 * true — щось додалось; без мережі тихо повертає false.
 */
export async function refreshRates(today) {
  const last = RATES.length - 1;
  const end = index(today);
  const need = [];
  for (let i = Math.max(last + 1, end - MAX_FETCH); i <= end; i++) if (!extra[isoAt(i)]) need.push(isoAt(i));
  // Сьогоднішній курс НБУ ставить напередодні, але про всяк випадок перепитуємо його щоразу
  if (end > last && !need.includes(isoAt(end))) need.push(isoAt(end));
  let added = false;
  for (const iso of need) {
    try {
      const res = await fetch(`https://bank.gov.ua/NBUStatService/v1/statdirectory/exchange?valcode=USD&date=${iso.replaceAll('-', '')}&json`);
      if (!res.ok) break;
      const rate = (await res.json())?.[0]?.rate;
      if (rate > 0 && extra[iso] !== rate) { extra[iso] = rate; added = true; }
    } catch {
      break;
    }
  }
  if (added) {
    // Дні, що вже є у вшитій історії, кешу не потрібні
    extra = Object.fromEntries(Object.entries(extra).filter(([iso]) => index(iso) > last));
    try { localStorage.setItem(KEY, JSON.stringify(extra)); } catch { /* приватний режим */ }
  }
  return added;
}
