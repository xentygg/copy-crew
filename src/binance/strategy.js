// BINANCE — patrones comprobados en monedas grandes (BTC, ETH, BNB…).
// Primero prueba cada patrón con ~40 días de historial de cada moneda; solo opera los que, en esa moneda,
// llevan suficientes casos y el acierto mínimo elegido. De momento opera en simulado (sin API key).
import fs from 'node:fs';
import { cfg } from '../config.js';
import { log } from '../state.js';
import { sleep } from '../http.js';
import { detect, outcome, PATTERNS } from '../agents/chartist.js';
import { history, recent } from './market.js';

const FILE = 'data/binance.json';
const INTERVAL_MS = { '5m': 5, '15m': 15, '1h': 60 }[cfg.binanceInterval] * 60_000 || 15 * 60_000;

function fresh() {
  return { cashUsd: cfg.binanceStartUsd, startUsd: cfg.binanceStartUsd, positions: [], closed: [], stats: {}, lastBacktest: null, scans: 0, lastScan: null, lastError: null };
}

export const bn = (() => {
  try {
    return { ...fresh(), ...JSON.parse(fs.readFileSync(FILE, 'utf8')) };
  } catch {
    return fresh();
  }
})();

function persist() {
  fs.writeFileSync(FILE + '.tmp', JSON.stringify(bn));
  fs.renameSync(FILE + '.tmp', FILE);
}

const plan = () => ({ tpPct: cfg.binanceTpPct, slPct: cfg.binanceSlPct, horizon: cfg.binanceHoldCandles, feesPct: cfg.binanceFeePct * 2 });
const coin = (symbol) => symbol.replace(/USDT$/, '');

// --- Comprobación con el historial ------------------------------------------------

export function backtest(symbol, c) {
  const stats = {};
  const p = plan();
  for (let i = 20; i + p.horizon < c.c.length; i++) {
    for (const pat of detect(c, i)) {
      const r = outcome(c, i, p);
      const s = (stats[pat] ||= { n: 0, wins: 0, sumRet: 0 });
      s.n++;
      if (r.win) s.wins++;
      s.sumRet += r.ret;
    }
  }
  bn.stats[symbol] = stats;
  return stats;
}

export function proven(symbol, pattern) {
  const s = bn.stats[symbol]?.[pattern];
  if (!s || s.n < cfg.patternMinSamples) return false;
  return (s.wins / s.n) * 100 >= cfg.patternMinWinRate && s.sumRet / s.n > 0;
}

export function provenList() {
  const out = [];
  for (const [symbol, pats] of Object.entries(bn.stats)) {
    for (const [pat, s] of Object.entries(pats)) {
      out.push({ symbol: coin(symbol), pattern: PATTERNS[pat] || pat, n: s.n, winRate: (s.wins / s.n) * 100, avgRet: s.sumRet / s.n, proven: proven(symbol, pat) });
    }
  }
  return out.sort((a, b) => Number(b.proven) - Number(a.proven) || b.winRate - a.winRate);
}

// --- Operativa (simulada) -------------------------------------------------------

// Revisa las salidas con las velas cerradas desde la entrada: si toca el objetivo o el stop, se cierra a ese precio.
export function checkExit(pos, c, now = Date.now()) {
  for (let i = 0; i < c.t.length; i++) {
    if (c.t[i] < pos.entryCandleEnd) continue;
    if (c.l[i] <= pos.slPrice) return { price: pos.slPrice, reason: `stop −${pos.slPct}%` }; // si ambos en la misma vela, lo peor
    if (c.h[i] >= pos.tpPrice) return { price: pos.tpPrice, reason: `objetivo +${pos.tpPct}%` };
  }
  if (now - pos.openedAt >= pos.horizon * INTERVAL_MS) return { price: c.c[c.c.length - 1], reason: 'tiempo máximo' };
  return null;
}

function close(pos, exit) {
  const gross = pos.qty * exit.price;
  const proceeds = gross * (1 - cfg.binanceFeePct / 100);
  bn.cashUsd += proceeds;
  const pnlUsd = proceeds - pos.costUsd;
  bn.positions = bn.positions.filter((p) => p.id !== pos.id);
  bn.closed.unshift({ ...pos, closedAt: Date.now(), exitPrice: exit.price, exitReason: exit.reason, pnlUsd, pnlPct: (proceeds / pos.costUsd - 1) * 100 });
  if (bn.closed.length > 300) bn.closed.length = 300;
  log('binance', `[SIM] vendió ${coin(pos.symbol)} (${exit.reason}): ${pnlUsd >= 0 ? '+' : '−'}$${Math.abs(pnlUsd).toFixed(2)}`);
}

function open(symbol, c, patterns) {
  const i = c.c.length - 1;
  const price = c.c[i];
  const sizeUsd = Math.min(cfg.binanceTradeUsd, bn.cashUsd);
  if (sizeUsd < 5) return log('binance', `– ${coin(symbol)} ignorado: sin saldo simulado`);
  if (bn.positions.length >= cfg.binanceMaxPositions) return log('binance', `– ${coin(symbol)} ignorado: máximo de posiciones`);
  const qty = (sizeUsd * (1 - cfg.binanceFeePct / 100)) / price;
  bn.cashUsd -= sizeUsd;
  const pos = {
    id: `${symbol}-${Date.now()}`,
    symbol,
    pattern: patterns.map((p) => PATTERNS[p] || p).join(' + '),
    openedAt: Date.now(),
    entryCandleEnd: c.t[i] + INTERVAL_MS,
    entryPrice: price,
    qty,
    costUsd: sizeUsd,
    tpPct: cfg.binanceTpPct,
    slPct: cfg.binanceSlPct,
    tpPrice: price * (1 + cfg.binanceTpPct / 100),
    slPrice: price * (1 - cfg.binanceSlPct / 100),
    horizon: cfg.binanceHoldCandles,
  };
  bn.positions.push(pos);
  log('binance', `[SIM] compró ${coin(symbol)} a $${price} ($${sizeUsd.toFixed(2)}) · ${pos.pattern} · objetivo +${pos.tpPct}% / stop −${pos.slPct}%`);
}

const signaled = new Map(); // moneda → última vela señalada

export async function scanOnce() {
  for (const symbol of cfg.binanceSymbols) {
    try {
      const c = await recent(symbol, cfg.binanceInterval);
      for (const pos of bn.positions.filter((p) => p.symbol === symbol)) {
        const exit = checkExit(pos, c);
        if (exit) close(pos, exit);
      }
      if (!cfg.stratBinance) continue;
      const i = c.c.length - 1;
      if (i < 20 || signaled.get(symbol) === c.t[i]) continue;
      const pats = detect(c, i).filter((p) => proven(symbol, p));
      if (pats.length && !bn.positions.some((p) => p.symbol === symbol)) {
        signaled.set(symbol, c.t[i]);
        open(symbol, c, pats);
      }
    } catch (e) {
      bn.lastError = `${coin(symbol)}: ${e.message}`;
    }
    await sleep(300);
  }
  bn.scans++;
  bn.lastScan = Date.now();
  persist();
}

export async function backtestAll() {
  for (const symbol of cfg.binanceSymbols) {
    try {
      backtest(symbol, await history(symbol, cfg.binanceInterval));
    } catch (e) {
      bn.lastError = `historial ${coin(symbol)}: ${e.message}`;
    }
  }
  bn.lastBacktest = Date.now();
  persist();
  const ok = provenList().filter((p) => p.proven);
  log('binance', `historial comprobado: ${ok.length} combinaciones moneda/patrón superan el ${cfg.patternMinWinRate}%${ok.length ? ` (${ok.slice(0, 3).map((p) => `${p.symbol} ${p.pattern} ${p.winRate.toFixed(0)}%`).join(', ')})` : ''}`);
}

export async function binanceLoop() {
  await sleep(30_000);
  for (;;) {
    try {
      if (!bn.lastBacktest || Date.now() - bn.lastBacktest > 12 * 3600_000) await backtestAll();
      await scanOnce();
    } catch (e) {
      bn.lastError = e.message;
    }
    await sleep(cfg.patternIntervalMs);
  }
}

export function resetBinance() {
  Object.assign(bn, { ...fresh(), stats: bn.stats, lastBacktest: bn.lastBacktest });
  persist();
}

export function binanceSummary() {
  const posValue = bn.positions.reduce((s, p) => s + p.costUsd, 0);
  const wins = bn.closed.filter((t) => t.pnlUsd > 0).length;
  return {
    enabled: cfg.stratBinance,
    symbols: cfg.binanceSymbols.map(coin),
    interval: cfg.binanceInterval,
    tp: cfg.binanceTpPct,
    sl: cfg.binanceSlPct,
    holdHours: (cfg.binanceHoldCandles * INTERVAL_MS) / 3600_000,
    minWinRate: cfg.patternMinWinRate,
    minSamples: cfg.patternMinSamples,
    cashUsd: bn.cashUsd,
    equityUsd: bn.cashUsd + posValue,
    startUsd: bn.startUsd,
    positions: bn.positions,
    closed: bn.closed.slice(0, 30),
    trades: bn.closed.length,
    wins,
    winRate: bn.closed.length ? (wins / bn.closed.length) * 100 : null,
    pnlUsd: bn.closed.reduce((s, t) => s + t.pnlUsd, 0),
    proven: provenList().slice(0, 12),
    provenCount: provenList().filter((p) => p.proven).length,
    lastBacktest: bn.lastBacktest,
    lastScan: bn.lastScan,
    lastError: bn.lastError,
  };
}
