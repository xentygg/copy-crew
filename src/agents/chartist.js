// CHARTIST — analiza gráficos de velas de 5 min y da señal cuando aparece un patrón alcista clásico.
// Además lleva la cuenta de cómo acaba cada patrón, para ver en el panel cuáles funcionan en memecoins.
import fs from 'node:fs';
import { cfg } from '../config.js';
import { GT, geckoGet } from '../gecko.js';

const FILE = 'data/patterns.json';
const CANDLE_MS = 5 * 60_000;
const FEES_PCT = 2; // comisiones + slippage de ida y vuelta, aproximado

export const PATTERNS = {
  ruptura: 'Ruptura con volumen',
  volumen: 'Volumen explosivo',
  rebote_ema: 'Rebote en la media (EMA 20)',
  suelos: 'Suelos crecientes',
  rsi: 'Rebote desde sobreventa (RSI)',
  compresion: 'Compresión y ruptura',
  bandera: 'Bandera alcista',
  doble_suelo: 'Doble suelo',
  cruce_ema: 'Cruce de medias (EMA 9 / 21)',
};

function fresh() {
  return { stats: {}, cursor: {}, scans: 0, lastScan: null, lastError: null };
}

export const book = (() => {
  try {
    return { ...fresh(), ...JSON.parse(fs.readFileSync(FILE, 'utf8')) };
  } catch {
    return fresh();
  }
})();

export function persist() {
  fs.writeFileSync(FILE + '.tmp', JSON.stringify(book));
  fs.renameSync(FILE + '.tmp', FILE);
}

// --- Indicadores -----------------------------------------------------------

const avg = (a) => (a.length ? a.reduce((s, x) => s + x, 0) / a.length : 0);

export function ema(values, period) {
  const k = 2 / (period + 1);
  const out = [];
  values.forEach((v, i) => out.push(i === 0 ? v : v * k + out[i - 1] * (1 - k)));
  return out;
}

export function rsi(closes, period = 14) {
  const out = new Array(closes.length).fill(50);
  let gain = 0;
  let loss = 0;
  for (let i = 1; i < closes.length; i++) {
    const d = closes[i] - closes[i - 1];
    const g = Math.max(d, 0);
    const l = Math.max(-d, 0);
    if (i <= period) {
      gain += g / period;
      loss += l / period;
    } else {
      gain = (gain * (period - 1) + g) / period;
      loss = (loss * (period - 1) + l) / period;
    }
    if (i >= period) out[i] = loss === 0 ? 100 : 100 - 100 / (1 + gain / loss);
  }
  return out;
}

// --- Patrones ----------------------------------------------------------------
// c = { o, h, l, c, v, ema20, rsi } arrays ordenados del más antiguo al más reciente.

export function detect(c, i) {
  if (i < 20) return [];
  const found = [];
  const green = c.c[i] > c.o[i];
  const prevHigh12 = Math.max(...c.h.slice(i - 12, i));
  const vol12 = avg(c.v.slice(i - 12, i));
  const vol20 = avg(c.v.slice(i - 20, i));

  if (green && c.c[i] > prevHigh12 && c.v[i] > 2 * vol12) found.push('ruptura');
  if (green && c.v[i] > 3 * vol20 && c.c[i] / c.o[i] - 1 > 0.05) found.push('volumen');
  if (
    green &&
    c.ema20[i] > c.ema20[i - 5] &&
    c.c[i] > c.ema20[i] &&
    [i - 1, i - 2, i - 3].some((k) => c.l[k] <= c.ema20[k] * 1.01)
  ) {
    found.push('rebote_ema');
  }
  if (c.l[i] > c.l[i - 1] && c.l[i - 1] > c.l[i - 2] && c.c[i] > c.c[i - 1] && c.c[i - 1] > c.c[i - 2] && green) found.push('suelos');
  if (c.rsi[i - 1] < 30 && c.rsi[i] >= 30) found.push('rsi');

  const range = (a, b) => (Math.max(...c.h.slice(a, b)) - Math.min(...c.l.slice(a, b))) / c.c[b - 1];
  const recent = range(i - 6, i);
  const before = avg([range(i - 20, i - 14), range(i - 14, i - 8)]);
  if (green && recent < 0.6 * before && c.c[i] > Math.max(...c.h.slice(i - 6, i))) found.push('compresion');

  // Bandera alcista: subida fuerte (mástil), unas velas de descanso con menos volumen y ruptura del descanso.
  for (const flag of [3, 4, 5]) {
    const poleEnd = i - flag; // última vela del mástil
    const poleStart = poleEnd - 4;
    if (poleStart < 0) continue;
    const pole = c.c[poleEnd] / c.o[poleStart] - 1;
    const flagHigh = Math.max(...c.h.slice(poleEnd + 1, i));
    const flagLow = Math.min(...c.l.slice(poleEnd + 1, i));
    const holds = flagLow > c.c[poleEnd] - (c.c[poleEnd] - c.o[poleStart]) * 0.5; // no devuelve más de la mitad
    const quiet = avg(c.v.slice(poleEnd + 1, i)) < avg(c.v.slice(poleStart, poleEnd + 1));
    if (green && pole > 0.15 && holds && quiet && c.c[i] > flagHigh) {
      found.push('bandera');
      break;
    }
  }

  // Doble suelo: dos mínimos parecidos (±3 %) separados por un rebote, y ruptura del rebote.
  const win = 20;
  const lows = c.l.slice(i - win, i);
  const a = lows.indexOf(Math.min(...lows.slice(0, win / 2)));
  const b = win / 2 + lows.slice(win / 2).indexOf(Math.min(...lows.slice(win / 2)));
  if (b - a >= 5) {
    const neck = Math.max(...c.h.slice(i - win + a + 1, i - win + b));
    const similar = Math.abs(lows[a] - lows[b]) / lows[a] < 0.03;
    if (green && similar && neck > lows[a] * 1.05 && c.c[i] > neck) found.push('doble_suelo');
  }

  // Cruce de medias: la EMA 9 cruza por encima de la EMA 21.
  if (c.ema9[i - 1] <= c.ema21[i - 1] && c.ema9[i] > c.ema21[i] && green) found.push('cruce_ema');
  return found;
}

// ¿Qué pasó después? Gana si toca +TP antes que −SL dentro del horizonte (mismo plan que al operar).
export function outcome(c, i, { tpPct = cfg.patternTpPct, slPct = cfg.patternSlPct, horizon = cfg.patternHoldCandles, feesPct = FEES_PCT } = {}) {
  const entry = c.c[i];
  const tp = entry * (1 + tpPct / 100);
  const sl = entry * (1 - slPct / 100);
  for (let j = i + 1; j <= i + horizon && j < c.c.length; j++) {
    const hitTp = c.h[j] >= tp;
    const hitSl = c.l[j] <= sl;
    if (hitSl) return { win: false, ret: -slPct - feesPct }; // si ambos en la misma vela, se asume lo peor
    if (hitTp) return { win: true, ret: tpPct - feesPct };
  }
  const last = c.c[Math.min(i + horizon, c.c.length - 1)];
  const ret = (last / entry - 1) * 100 - feesPct;
  return { win: ret > 0, ret };
}

export function toCandles(ohlcvList, now = Date.now()) {
  // GeckoTerminal: [timestamp(s), open, high, low, close, volume], del más reciente al más antiguo.
  const rows = [...ohlcvList]
    .map((r) => r.map(Number))
    .sort((a, b) => a[0] - b[0])
    .filter((r) => r[0] * 1000 + CANDLE_MS <= now); // fuera la vela que aún se está formando
  const c = { t: [], o: [], h: [], l: [], c: [], v: [] };
  for (const [t, o, h, l, cl, v] of rows) {
    c.t.push(t * 1000);
    c.o.push(o);
    c.h.push(h);
    c.l.push(l);
    c.c.push(cl);
    c.v.push(v);
  }
  return withIndicators(c);
}

// Añade las medias y el RSI a unas velas { t, o, h, l, c, v }.
export function withIndicators(c) {
  c.ema9 = ema(c.c, 9);
  c.ema20 = ema(c.c, 20);
  c.ema21 = ema(c.c, 21);
  c.rsi = rsi(c.c);
  return c;
}

// Aprende de todas las velas cuyo resultado ya se conoce y que no había visto antes.
export function learn(poolAddress, c) {
  const horizon = cfg.patternHoldCandles;
  const seenUntil = book.cursor[poolAddress] || 0;
  let newest = seenUntil;
  let samples = 0;
  for (let i = 20; i + horizon < c.c.length; i++) {
    if (c.t[i] <= seenUntil) continue;
    for (const p of detect(c, i)) {
      const r = outcome(c, i);
      const s = (book.stats[p] ||= { n: 0, wins: 0, sumRet: 0 });
      s.n++;
      if (r.win) s.wins++;
      s.sumRet += r.ret;
      samples++;
    }
    newest = Math.max(newest, c.t[i]);
  }
  book.cursor[poolAddress] = newest;
  return samples;
}

export function patternStatus(p) {
  const s = book.stats[p] || { n: 0, wins: 0, sumRet: 0 };
  const winRate = s.n ? (s.wins / s.n) * 100 : 0;
  const avgRet = s.n ? s.sumRet / s.n : 0;
  let status = 'aprendiendo';
  if (s.n >= cfg.patternMinSamples) status = winRate >= cfg.patternMinWinRate && avgRet > 0 ? 'activo' : 'descartado';
  // Modo clásico: se operan todos; la estadística solo informa.
  if (!cfg.patternRequireProof) status = 'clasico';
  return { id: p, name: PATTERNS[p], n: s.n, winRate, avgRet, status };
}

export async function fetchCandles(poolAddress, get = geckoGet) {
  const res = await get(`${GT}/networks/solana/pools/${poolAddress}/ohlcv/minute?aggregate=5&limit=100&currency=usd`);
  return toCandles(res?.data?.attributes?.ohlcv_list || []);
}

// Señales en la última vela cerrada (si es reciente) con patrones activos.
export function liveSignals(c, now = Date.now()) {
  const i = c.c.length - 1;
  if (i < 20 || now - c.t[i] > 2 * CANDLE_MS) return [];
  return detect(c, i).filter((p) => ['activo', 'clasico'].includes(patternStatus(p).status));
}
