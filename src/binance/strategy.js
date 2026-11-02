// BINANCE — estrategias en monedas grandes (BTC, ETH, BNB…), comprobadas con el historial de cada moneda.
// Cada estrategia se prueba primero con el pasado y solo opera en las monedas donde ha funcionado.
// De momento opera en simulado (los gráficos de Binance son públicos: no hace falta API key).
import fs from 'node:fs';
import { cfg } from '../config.js';
import { log } from '../state.js';
import { sleep } from '../http.js';
import { detect, PATTERNS, ema, rsi } from '../agents/chartist.js';
import { history, recent } from './market.js';

const FILE = 'data/binance.json';
const VERSION = 2;
const M15 = 15 * 60_000;
const H = 3600_000;
const val = (x) => (typeof x === 'function' ? x() : x);
const coin = (symbol) => symbol.replace(/USDT$/, '');
const fees = () => cfg.binanceFeePct * 2; // compra + venta, en %

// --- Estrategias ---------------------------------------------------------------------
// exit.type: fixed = objetivo y stop fijos · dips = sale al rebotar a la media de 5 · trail = stop que sube · hold = solo stop
export const STRATS = {
  patrones: {
    name: 'Patrones',
    help: 'Patrones clásicos en velas de 15 min',
    interval: '15m',
    ms: M15,
    exit: { type: 'fixed', tp: () => cfg.binanceTpPct, sl: () => cfg.binanceSlPct, horizon: () => cfg.binanceHoldCandles },
    gate: 'winrate',
    setting: 'bnPatterns',
  },
  tendencia: {
    name: 'Patrones a favor de la tendencia',
    help: 'Los mismos patrones, solo si la tendencia de fondo (media de ~200 h) sube',
    interval: '15m',
    ms: M15,
    exit: { type: 'fixed', tp: () => cfg.binanceTpPct, sl: () => cfg.binanceSlPct, horizon: () => cfg.binanceHoldCandles },
    gate: 'winrate',
    setting: 'bnTrend',
  },
  caidas: {
    name: 'Comprar caídas en tendencia',
    help: 'En tendencia alcista, compra tras una caída brusca (RSI 2 < 10) y vende al rebotar a la media de 5 h',
    interval: '1h',
    ms: H,
    exit: { type: 'dips', sl: 3, horizon: 48 },
    gate: 'winrate',
    min: 20,
    setting: 'bnDips',
  },
  ruptura: {
    name: 'Ruptura de canal',
    help: 'Compra al superar el máximo de 20 h (en tendencia alcista); stop que sube con el mínimo de 10 h',
    interval: '1h',
    ms: H,
    exit: { type: 'trail', sl: 4, lookback: 10, horizon: 120 },
    gate: 'profit',
    min: 20,
    setting: 'bnBreakout',
  },
  rotacion: {
    name: 'Rotación de la más fuerte',
    help: 'Cada día tiene la moneda que más subió en 7 días (si ninguna sube, se queda en dólares)',
    interval: '1h',
    ms: H,
    exit: { type: 'hold', sl: 8, horizon: 1e9 },
    setting: 'bnRotation',
  },
};
const SIGNAL_STRATS = ['patrones', 'tendencia', 'caidas', 'ruptura'];
export const enabled = (id) => cfg.stratBinance && cfg[STRATS[id].setting] !== false;

// --- Estado -----------------------------------------------------------------------------

function fresh() {
  return {
    v: VERSION,
    cashUsd: cfg.binanceStartUsd,
    startUsd: cfg.binanceStartUsd,
    positions: [],
    closed: [],
    stats: {}, // stats[estrategia][moneda][señal] = { n, wins, sumRet, grossWin, grossLoss }
    rotation: { backtest: null, lastDay: null },
    lastBacktest: null,
    scans: 0,
    lastScan: null,
    lastError: null,
  };
}

export const bn = (() => {
  try {
    const saved = JSON.parse(fs.readFileSync(FILE, 'utf8'));
    return saved.v === VERSION ? { ...fresh(), ...saved } : fresh();
  } catch {
    return fresh();
  }
})();

function persist() {
  fs.writeFileSync(FILE + '.tmp', JSON.stringify(bn));
  fs.renameSync(FILE + '.tmp', FILE);
}

// --- Indicadores y señales -------------------------------------------------------------

export function prep(c) {
  c.ema5 = ema(c.c, 5);
  c.ema200 = ema(c.c, 200);
  c.ema800 = ema(c.c, 800);
  c.rsi2 = rsi(c.c, 2);
  return c;
}

export function signals(id, c, i) {
  switch (id) {
    case 'patrones':
      return i >= 20 ? detect(c, i) : [];
    case 'tendencia': // en velas de 15 min, 800 velas ≈ 200 horas
      return i >= 816 && c.c[i] > c.ema800[i] && c.ema800[i] > c.ema800[i - 16] ? detect(c, i) : [];
    case 'caidas':
      return i >= 200 && c.c[i] > c.ema200[i] && c.rsi2[i] < 10 ? ['caidas'] : [];
    case 'ruptura':
      return i >= 200 && c.c[i] > Math.max(...c.h.slice(i - 20, i)) && c.c[i] > c.ema200[i] ? ['ruptura'] : [];
    default:
      return [];
  }
}

// Recorre las velas posteriores a la entrada y devuelve la salida (o null si sigue abierta).
// Si la vela abre por debajo del stop (hueco), se vende al precio de apertura: lo realista.
export function walk(c, pos, rule, ms) {
  const initialStop = pos.entryPrice * (1 - val(rule.sl) / 100);
  let stop = Math.max(initialStop, pos.stop || 0);
  for (let i = 0; i < c.c.length; i++) {
    if (c.t[i] <= pos.entryT) continue;
    if (rule.type === 'trail' && i >= rule.lookback) stop = Math.max(stop, Math.min(...c.l.slice(i - rule.lookback, i)));
    if (c.l[i] <= stop) {
      const reason = stop > initialStop ? 'stop dinámico' : `stop −${val(rule.sl)}%`;
      return { price: Math.min(stop, c.o[i]), reason, idx: i };
    }
    if (rule.type === 'fixed') {
      const tp = pos.entryPrice * (1 + val(rule.tp) / 100);
      if (c.h[i] >= tp) return { price: Math.max(tp, c.o[i]), reason: `objetivo +${val(rule.tp)}%`, idx: i };
    }
    if (rule.type === 'dips' && c.c[i] > c.ema5[i]) return { price: c.c[i], reason: 'rebote a la media', idx: i };
    if ((c.t[i] - pos.entryT) / ms >= val(rule.horizon)) return { price: c.c[i], reason: 'tiempo máximo', idx: i };
  }
  pos.stop = stop; // el stop dinámico se recuerda entre análisis
  return null;
}

// --- Comprobación con el historial -------------------------------------------------------

function addStat(stats, key, ret) {
  const s = (stats[key] ||= { n: 0, wins: 0, sumRet: 0, grossWin: 0, grossLoss: 0 });
  s.n++;
  s.sumRet += ret;
  if (ret > 0) {
    s.wins++;
    s.grossWin += ret;
  } else {
    s.grossLoss -= ret;
  }
}

export function backtest(id, symbol, c) {
  const s = STRATS[id];
  const stats = {};
  let busyUntil = -1; // como en vivo: una operación a la vez por moneda y estrategia
  for (let i = 20; i < c.c.length; i++) {
    if (i <= busyUntil) continue;
    const sig = signals(id, c, i);
    if (!sig.length) continue;
    const ex = walk(c, { entryPrice: c.c[i], entryT: c.t[i] }, s.exit, s.ms);
    if (!ex) continue; // aún no se sabe cómo acaba
    const ret = (ex.price / c.c[i] - 1) * 100 - fees();
    for (const key of sig) addStat(stats, key, ret);
    busyUntil = ex.idx;
  }
  (bn.stats[id] ||= {})[symbol] = stats;
  return stats;
}

export function isProven(id, symbol, key) {
  const s = STRATS[id];
  const st = bn.stats[id]?.[symbol]?.[key];
  const min = s.min ? Math.min(cfg.patternMinSamples, s.min) : cfg.patternMinSamples;
  if (!st || st.n < min || st.sumRet / st.n <= 0) return false;
  if (s.gate === 'profit') return st.grossLoss === 0 || st.grossWin / st.grossLoss >= 1.3;
  return (st.wins / st.n) * 100 >= cfg.patternMinWinRate;
}

// Rotación: cada día a las 00:00 UTC, la moneda con mejor subida en 7 días (si es positiva).
export function bestOf(series, t) {
  let best = null;
  for (const [symbol, c] of Object.entries(series)) {
    const i = c.t.indexOf(t);
    const j = c.t.indexOf(t - 168 * H);
    if (i < 0 || j < 0) continue;
    const ret = c.c[i] / c.c[j] - 1;
    if (ret > 0 && (!best || ret > best.ret)) best = { symbol, ret };
  }
  return best;
}

export function rotationBacktest(series) {
  const ref = series.BTCUSDT || Object.values(series)[0];
  if (!ref) return null;
  const days = ref.t.filter((t) => new Date(t).getUTCHours() === 0 && ref.t.includes(t - 168 * H) && ref.t.includes(t + 24 * H));
  let equity = 1;
  let held = null;
  let periods = 0;
  let wins = 0;
  for (const t of days) {
    const best = bestOf(series, t)?.symbol || null;
    if (best !== held) equity *= 1 - fees() / 100 / (held && best ? 1 : 2); // cambio = vender + comprar
    held = best;
    if (!held) continue;
    const c = series[held];
    const i = c.t.indexOf(t);
    const k = c.t.indexOf(t + 24 * H);
    if (i < 0 || k < 0) continue;
    const r = c.c[k] / c.c[i];
    equity *= r;
    periods++;
    if (r > 1) wins++;
  }
  const first = ref.t.indexOf(days[0]);
  const last = ref.t.indexOf(days[days.length - 1] + 24 * H);
  return {
    days: days.length,
    periods,
    wins,
    totalRetPct: (equity - 1) * 100,
    btcHoldPct: first >= 0 && last >= 0 ? (ref.c[last] / ref.c[first] - 1) * 100 : 0,
  };
}

export const rotationProven = () => {
  const b = bn.rotation.backtest;
  return Boolean(b && b.periods >= 20 && b.totalRetPct > 0 && b.totalRetPct > b.btcHoldPct);
};

export async function backtestAll() {
  const hourly = {};
  for (const symbol of cfg.binanceSymbols) {
    try {
      const c15 = prep(await history(symbol, '15m'));
      backtest('patrones', symbol, c15);
      backtest('tendencia', symbol, c15);
      const c1h = prep(await history(symbol, '1h'));
      hourly[symbol] = c1h;
      backtest('caidas', symbol, c1h);
      backtest('ruptura', symbol, c1h);
    } catch (e) {
      bn.lastError = `historial ${coin(symbol)}: ${e.message}`;
    }
  }
  bn.rotation.backtest = rotationBacktest(hourly);
  bn.lastBacktest = Date.now();
  persist();
  const ok = provenList().filter((p) => p.proven);
  log('binance', `historial comprobado: ${ok.length} combinaciones operables${ok.length ? ` (${ok.slice(0, 3).map((p) => `${p.symbol} · ${p.signal} ${p.winRate.toFixed(0)}%`).join(', ')})` : ''} · rotación ${rotationProven() ? 'operable' : 'no supera a guardar BTC'}`);
}

export function provenList() {
  const out = [];
  for (const id of SIGNAL_STRATS) {
    for (const [symbol, keys] of Object.entries(bn.stats[id] || {})) {
      for (const [key, s] of Object.entries(keys)) {
        out.push({
          strategy: STRATS[id].name,
          symbol: coin(symbol),
          signal: id === 'patrones' || id === 'tendencia' ? PATTERNS[key] || key : STRATS[id].name,
          n: s.n,
          winRate: (s.wins / s.n) * 100,
          avgRet: s.sumRet / s.n,
          proven: isProven(id, symbol, key),
        });
      }
    }
  }
  return out.sort((a, b) => Number(b.proven) - Number(a.proven) || b.avgRet - a.avgRet);
}

// --- Operativa (simulada) -----------------------------------------------------------------

function close(pos, exit) {
  const proceeds = pos.qty * exit.price * (1 - cfg.binanceFeePct / 100);
  bn.cashUsd += proceeds;
  const pnlUsd = proceeds - pos.costUsd;
  bn.positions = bn.positions.filter((p) => p.id !== pos.id);
  bn.closed.unshift({ ...pos, closedAt: Date.now(), exitPrice: exit.price, exitReason: exit.reason, pnlUsd, pnlPct: (proceeds / pos.costUsd - 1) * 100 });
  if (bn.closed.length > 300) bn.closed.length = 300;
  log('binance', `[SIM] ${STRATS[pos.strategy].name}: vendió ${coin(pos.symbol)} (${exit.reason}) ${pnlUsd >= 0 ? '+' : '−'}$${Math.abs(pnlUsd).toFixed(2)}`);
}

function open(id, symbol, c, label) {
  const i = c.c.length - 1;
  const price = c.c[i];
  if (bn.positions.length >= cfg.binanceMaxPositions) return log('binance', `– ${coin(symbol)} (${STRATS[id].name}) ignorado: máximo de posiciones`);
  const sizeUsd = Math.min(cfg.binanceTradeUsd, bn.cashUsd);
  if (sizeUsd < 5) return log('binance', `– ${coin(symbol)} (${STRATS[id].name}) ignorado: sin saldo simulado`);
  bn.cashUsd -= sizeUsd;
  const pos = {
    id: `${id}-${symbol}-${Date.now()}`,
    strategy: id,
    symbol,
    label,
    openedAt: Date.now(),
    entryT: c.t[i],
    entryPrice: price,
    qty: (sizeUsd * (1 - cfg.binanceFeePct / 100)) / price,
    costUsd: sizeUsd,
  };
  bn.positions.push(pos);
  log('binance', `[SIM] ${STRATS[id].name}: compró ${coin(symbol)} a $${price} ($${sizeUsd.toFixed(2)}) · ${label}`);
}

const signaled = new Map(); // estrategia+moneda → última vela con señal

async function rotationStep(hourly) {
  const today = new Date().toISOString().slice(0, 10);
  const current = bn.positions.find((p) => p.strategy === 'rotacion');
  if (!enabled('rotacion') || !rotationProven()) return;
  if (bn.rotation.lastDay === today && current) return;
  const ref = hourly.BTCUSDT || Object.values(hourly)[0];
  if (!ref?.t.length) return;
  const best = bestOf(hourly, ref.t[ref.t.length - 1]);
  bn.rotation.lastDay = today;
  if (current && current.symbol === best?.symbol) return;
  if (current) {
    const c = hourly[current.symbol];
    close(current, { price: c.c[c.c.length - 1], reason: best ? `rotación a ${coin(best.symbol)}` : 'rotación: ninguna sube' });
  }
  if (best) open('rotacion', best.symbol, hourly[best.symbol], `la más fuerte (+${(best.ret * 100).toFixed(1)}% en 7 días)`);
}

export async function scanOnce() {
  const hourly = {};
  for (const symbol of cfg.binanceSymbols) {
    try {
      const sets = { '15m': prep(await recent(symbol, '15m', 1000)), '1h': prep(await recent(symbol, '1h', 300)) };
      hourly[symbol] = sets['1h'];
      for (const pos of bn.positions.filter((p) => p.symbol === symbol)) {
        const s = STRATS[pos.strategy];
        const ex = walk(sets[s.interval], pos, s.exit, s.ms);
        if (ex) close(pos, ex);
      }
      for (const id of SIGNAL_STRATS) {
        if (!enabled(id)) continue;
        const c = sets[STRATS[id].interval];
        const i = c.c.length - 1;
        const key = `${id}:${symbol}`;
        if (signaled.get(key) === c.t[i]) continue;
        const sig = signals(id, c, i).filter((k) => isProven(id, symbol, k));
        if (!sig.length || bn.positions.some((p) => p.symbol === symbol && p.strategy === id)) continue;
        signaled.set(key, c.t[i]);
        const label = id === 'patrones' || id === 'tendencia' ? sig.map((k) => PATTERNS[k] || k).join(' + ') : STRATS[id].name;
        open(id, symbol, c, label);
      }
    } catch (e) {
      bn.lastError = `${coin(symbol)}: ${e.message}`;
    }
    await sleep(200);
  }
  await rotationStep(hourly);
  bn.scans++;
  bn.lastScan = Date.now();
  persist();
}

export async function binanceLoop() {
  await sleep(30_000);
  for (;;) {
    try {
      if (!bn.lastBacktest || Date.now() - bn.lastBacktest > 12 * H) await backtestAll();
      await scanOnce();
    } catch (e) {
      bn.lastError = e.message;
    }
    await sleep(cfg.patternIntervalMs);
  }
}

export function resetBinance() {
  Object.assign(bn, { ...fresh(), stats: bn.stats, rotation: { ...bn.rotation, lastDay: null }, lastBacktest: bn.lastBacktest });
  persist();
}

export function binanceSummary() {
  const posValue = bn.positions.reduce((s, p) => s + p.costUsd, 0);
  const strategies = Object.entries(STRATS).map(([id, s]) => {
    const ts = bn.closed.filter((t) => t.strategy === id);
    const wins = ts.filter((t) => t.pnlUsd > 0).length;
    const operable = id === 'rotacion' ? (rotationProven() ? 1 : 0) : provenList().filter((p) => p.proven && p.strategy === s.name).length;
    return { id, name: s.name, help: s.help, on: enabled(id), trades: ts.length, wins, winRate: ts.length ? (wins / ts.length) * 100 : null, pnlUsd: ts.reduce((a, t) => a + t.pnlUsd, 0), operable };
  });
  const wins = bn.closed.filter((t) => t.pnlUsd > 0).length;
  return {
    enabled: cfg.stratBinance,
    symbols: cfg.binanceSymbols.map(coin),
    minWinRate: cfg.patternMinWinRate,
    cashUsd: bn.cashUsd,
    equityUsd: bn.cashUsd + posValue,
    startUsd: bn.startUsd,
    strategies,
    positions: bn.positions.map((p) => ({ ...p, strategyName: STRATS[p.strategy].name })),
    closed: bn.closed.slice(0, 15).map((t) => ({ ...t, strategyName: STRATS[t.strategy]?.name || t.strategy })),
    trades: bn.closed.length,
    wins,
    winRate: bn.closed.length ? (wins / bn.closed.length) * 100 : null,
    pnlUsd: bn.closed.reduce((s, t) => s + t.pnlUsd, 0),
    proven: provenList().slice(0, 15),
    provenCount: provenList().filter((p) => p.proven).length,
    rotation: { ...bn.rotation.backtest, operable: rotationProven() },
    lastBacktest: bn.lastBacktest,
    lastScan: bn.lastScan,
    lastError: bn.lastError,
  };
}
