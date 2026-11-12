// Останні релізи прошивок з GitHub (без ключа, 60 запитів на годину — тому кеш на добу в localStorage).
// releases/latest сам пропускає пре-релізи й чернетки.

const REPOS = [[/betaflight/i, 'betaflight/betaflight'], [/\binav\b/i, 'iNavFlight/inav'], [/express\s*lrs|\belrs\b/i, 'ExpressLRS/ExpressLRS'], [/edge\s*tx/i, 'EdgeTX/edgetx']];
const KEY = 'fpv-log:fw-latest';
const DAY = 86_400_000;

/** Репозиторій прошивки за текстом «Betaflight 4.5.1» чи null. */
export const repoOf = (fw) => REPOS.find(([re]) => re.test(String(fw ?? '')))?.[1] ?? null;

/** [major, minor, patch] з тексту: перевага повній трійці («ELRS 2.4GHz 3.5.3» → 3.5.3), інакше остання пара. */
export function verOf(text) {
  const all = [...String(text ?? '').matchAll(/(\d+)\.(\d+)(?:\.(\d+))?/g)];
  const m = all.find((x) => x[3] !== undefined) ?? all.at(-1);
  return m ? [Number(m[1]), Number(m[2]), Number(m[3] ?? 0)] : null;
}

/** latest новіша за current? Не розібрали хоч одну — false: краще промовчати, ніж смикати. */
export function isNewer(latest, current) {
  const a = verOf(latest);
  const b = verOf(current);
  if (!a || !b) return false;
  const i = a.findIndex((x, k) => x !== b[k]);
  return i >= 0 && a[i] > b[i];
}

const read = () => { try { return JSON.parse(localStorage.getItem(KEY)) ?? { at: 0, tags: {} }; } catch { return { at: 0, tags: {} }; } };

/** Збережені теги: { 'betaflight/betaflight': '2026.6.2', … }. */
export const latestTags = () => read().tags;

/** Оновити теги для repos, якщо кешу понад добу чи бракує репозиторію. true — щось змінилось. Мережа впала — тихо лишає старе. */
export async function refreshLatest(repos) {
  const cache = read();
  const need = repos.filter((r) => Date.now() - cache.at > DAY || !(r in cache.tags));
  if (!need.length) return false;
  const got = await Promise.allSettled(need.map(async (r) => {
    const res = await fetch(`https://api.github.com/repos/${r}/releases/latest`, { headers: { Accept: 'application/vnd.github+json' } });
    if (!res.ok) throw new Error(`GitHub ${res.status}`);
    return [r, (await res.json()).tag_name];
  }));
  const ok = got.filter((x) => x.status === 'fulfilled' && x.value[1]).map((x) => x.value);
  if (!ok.length) return false;
  const tags = { ...cache.tags, ...Object.fromEntries(ok) };
  try { localStorage.setItem(KEY, JSON.stringify({ at: Date.now(), tags })); } catch { /* приватний режим */ }
  return ok.some(([r, tag]) => cache.tags[r] !== tag);
}
