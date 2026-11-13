// NFC-мітки (Web NFC — лише Chrome на Android, HTTPS): прочитати номер і посилання з мітки, записати посилання.
// Як у модулі odoo_nfc: запис перевіряється читанням — write() нічого не повертає, «записано» без нього означало б «команду віддано».
import { t } from './i18n.js';

export const nfcSupported = () => window.isSecureContext && 'NDEFReader' in window;

const dec = new TextDecoder();

/** Перше посилання з мітки або null (порожня, не NDEF чи з текстом). */
function urlOf(message) {
  for (const r of message?.records ?? []) {
    if (r.recordType !== 'url' && r.recordType !== 'absolute-url') continue;
    try { return dec.decode(r.data); } catch { /* зіпсований запис — шукаємо далі */ }
  }
  return null;
}

/**
 * Слухати мітки, доки не викличуть повернену stop(): onTag({ uid, url }) на кожен дотик, onError(текст) — дотик не прочитався.
 * Web NFC не має stop() — радіо вимикає лише AbortSignal, переданий у scan().
 */
export async function listen(onTag, onError) {
  const reader = new NDEFReader();
  const abort = new AbortController();
  try {
    await reader.scan({ signal: abort.signal });
  } catch (err) {
    throw new Error(err.name === 'NotAllowedError'
      ? t('Доступ до NFC не дано: дозвольте його в запиті браузера й перевірте, що NFC увімкнено в налаштуваннях телефона')
      : t('NFC не запустився: {msg}', { msg: err.message }));
  }
  reader.onreading = (e) => onTag({ uid: e.serialNumber || null, url: urlOf(e.message) });
  // Подія без подробиць: найчастіше мітку піднесли краєм чи прибрали зарано
  reader.onreadingerror = () => onError?.(t('Мітку не прочитано — піднесіть рівно до задньої кришки й потримайте секунду'));
  return () => abort.abort();
}

/** Записати посилання на мітку: write() сам чекає дотику. signal — скасувати очікування (закрили шторку). */
export async function writeUrl(url, signal) {
  try {
    await new NDEFReader().write({ records: [{ recordType: 'url', data: url }] }, { signal });
  } catch (err) {
    if (err.name === 'AbortError') throw err;
    throw new Error(err.name === 'NotAllowedError' ? t('Доступ до NFC не дано — дозвольте його в налаштуваннях сайту')
      : err.name === 'NetworkError' ? t('Мітку прибрали зарано — піднесіть ще раз і тримайте до «Готово»')
        : err.name === 'NotSupportedError' ? t('Ця мітка не приймає запис: захищена від запису чи не NDEF')
          : t('Запис не вдався: {msg}', { msg: err.message }));
  }
}
