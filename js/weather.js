// Погода перед польотом: вітер на висотах, пориви, опади й температура з Open-Meteo, індекс Kp з NOAA SWPC.
// Обидва без ключа й з CORS; verdict — чиста функція, без DOM і мережі.

async function getJson(url) {
  const res = await fetch(url);
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  return res.json();
}

/** Населені пункти за назвою: [{ label, lat, lon }], до п'яти. */
export async function searchPlace(name, language = 'uk') {
  const q = new URLSearchParams({ name, count: 5, language, format: 'json' });
  const json = await getJson(`https://geocoding-api.open-meteo.com/v1/search?${q}`);
  return (json.results ?? []).map((r) => ({
    label: [r.name, r.admin1, r.country_code === 'UA' ? null : r.country].filter(Boolean).join(', '),
    lat: r.latitude, lon: r.longitude,
  }));
}

/** Найближчі hours годин від поточної: [{ time, t, p, pp, w10, w80, w120, g }] — °C, мм, %, м/с. */
export async function hourly({ lat, lon }, hours = 6) {
  const q = new URLSearchParams({
    latitude: lat.toFixed(3), longitude: lon.toFixed(3), timezone: 'auto', forecast_days: 2, wind_speed_unit: 'ms',
    hourly: 'temperature_2m,precipitation,precipitation_probability,wind_speed_10m,wind_speed_80m,wind_speed_120m,wind_gusts_10m',
  });
  const json = await getJson(`https://api.open-meteo.com/v1/forecast?${q}`);
  const x = json.hourly;
  // Час у відповіді — місцевий для точки; поточна година там же — за зсувом від UTC
  const now = new Date(Date.now() + json.utc_offset_seconds * 1000).toISOString().slice(0, 13);
  const from = Math.max(0, x.time.findIndex((tm) => tm.slice(0, 13) >= now));
  return x.time.slice(from, from + hours).map((time, k) => {
    const i = from + k;
    return { time, t: x.temperature_2m[i], p: x.precipitation[i], pp: x.precipitation_probability[i], w10: x.wind_speed_10m[i], w80: x.wind_speed_80m[i], w120: x.wind_speed_120m[i], g: x.wind_gusts_10m[i] };
  });
}

/** Останній планетарний Kp (3-годинний): { kp, at }. Стара форма відповіді — масив рядків із заголовком. */
export async function kpIndex() {
  const list = await getJson('https://services.swpc.noaa.gov/products/noaa-planetary-k-index.json');
  const last = list.at(-1);
  const kp = Number(Array.isArray(last) ? last[1] : last.Kp);
  if (!Number.isFinite(kp)) throw new Error('Kp');
  return { kp, at: Array.isArray(last) ? last[0] : last.time_tag };
}

// Пороги: [жовтий, червоний]. Показуються в застосунку — людина бачить, звідки вердикт.
export const LIMITS = { wind: [6, 9], gust: [9, 13], rain: [0.2, 1], kp: [4, 5], cold: 0 };

/**
 * Вердикт на найближчі 3 години: { level: 'green' | 'yellow' | 'red', why: [[ключ, значення]] }.
 * Ключі — тексти для t(): вітер, пориви, опади, мороз, Kp. kp може бути null (NOAA недоступний).
 */
export function verdict(hours, kp) {
  const soon = hours.slice(0, 3);
  const max = (k) => Math.max(...soon.map((x) => Number(x[k]) || 0));
  const why = [];
  let level = 0;
  const check = (key, value, [y, r]) => {
    const l = value >= r ? 2 : value >= y ? 1 : 0;
    if (l) why.push([key, value]);
    level = Math.max(level, l);
  };
  check('вітер', max('w10'), LIMITS.wind);
  check('пориви', max('g'), LIMITS.gust);
  check('опади', max('p'), LIMITS.rain);
  if (kp !== null && kp !== undefined) check('Kp', kp, LIMITS.kp);
  const cold = Math.min(...soon.map((x) => x.t));
  if (cold < LIMITS.cold) { why.push(['мороз', cold]); level = Math.max(level, 1); }
  return { level: ['green', 'yellow', 'red'][level], why };
}
