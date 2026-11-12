// Розбір конфігу польотника (`diff all` / `dump` з CLI Betaflight чи INAV) — чиста функція, без DOM.

// «# Betaflight / STM32F405 (S405) 4.5.1 Nov 22 2024 …», «# INAV/SPEEDYBEEF405V4 7.1.2 Jun  3 2024 …»
const HEAD = /^#\s*(betaflight|inav|emuflight)\s*\/\s*(.*?)\s+(\d+\.\d+(?:\.\d+)?)(?=\s|$)/im;
const NAMES = { betaflight: 'Betaflight', inav: 'INAV', emuflight: 'EmuFlight' };

/**
 * { fw: 'Betaflight', ver: '4.5.1', label: 'Betaflight 4.5.1', target, board, craft, rx, motor, gps } —
 * чого в тексті немає, того й у результаті немає (diff all не пише стандартних значень). Не конфіг — null.
 */
export function parseConfig(text) {
  const src = String(text ?? '');
  const out = {};
  const head = src.match(HEAD);
  if (head) {
    out.fw = NAMES[head[1].toLowerCase()];
    out.target = head[2];
    out.ver = head[3];
    out.label = `${out.fw} ${out.ver}`;
  }
  const set = (key) => src.match(new RegExp(`^\\s*set\\s+${key}\\s*=\\s*(.*?)\\s*$`, 'im'))?.[1] || undefined;
  out.board = src.match(/^\s*board_name\s+(\S+)/im)?.[1];
  // Старі версії й INAV пишуть ім'я командою «name X», нові Betaflight — «set craft_name = X»; «-» означає порожнє
  out.craft = set('craft_name') ?? src.match(/^\s*name\s+(.+?)\s*$/im)?.[1];
  if (out.craft === '-') delete out.craft;
  out.rx = set('serialrx_provider');
  out.motor = set('motor_pwm_protocol');
  out.gps = set('gps_provider');
  for (const k of Object.keys(out)) if (!out[k]) delete out[k];
  return Object.keys(out).length ? out : null;
}
