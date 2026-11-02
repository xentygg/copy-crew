// HUNTER — busca smart wallets nuevas mirando quién gana dinero en los tokens que más suben.
// Usa la API gratuita de GeckoTerminal: pools en tendencia + sus últimas operaciones.
import fs from 'node:fs';
import { cfg, QUOTE_MINTS } from '../config.js';
import { GT, geckoGet } from '../gecko.js';

const FILE = 'data/hunter.json';
const DAY = 24 * 3600_000;
// Quien suele vender antes de 5 minutos es un operador rápido: imposible copiarle a tiempo.
const QUICK_FLIP_MS = 5 * 60_000;

function fresh() {
  return { wallets: {}, poolCursor: {}, added: {}, scans: 0, poolsAnalyzed: 0, tradesSeen: 0, lastScan: null, lastError: null };
}

export const hunt = (() => {
  try {
    return { ...fresh(), ...JSON.parse(fs.readFileSync(FILE, 'utf8')) };
  } catch {
    return fresh();
  }
})();

function persist() {
  fs.writeFileSync(FILE + '.tmp', JSON.stringify(hunt));
  fs.renameSync(FILE + '.tmp', FILE);
}

const mintOf = (rel) => (rel?.data?.id || '').replace(/^solana_/, '');

// Pools de memecoins con liquidez suficiente, de las listas de tendencia.
// La lista de tendencias se reutiliza 10 minutos (la usan Hunter y Chartist).
let trendingCache = { at: 0, pools: [] };

export async function trendingPools(get = geckoGet) {
  if (get === geckoGet && Date.now() - trendingCache.at < 10 * 60_000 && trendingCache.pools.length) return trendingCache.pools;
  const urls = [
    `${GT}/networks/solana/trending_pools?duration=1h&page=1`,
    `${GT}/networks/solana/trending_pools?duration=6h&page=1`,
    `${GT}/networks/solana/trending_pools?duration=24h&page=1`,
    `${GT}/networks/solana/pools?sort=h24_volume_usd_desc&page=1`,
  ];
  const pools = new Map();
  for (const u of urls) {
    const res = await get(u);
    for (const p of res?.data || []) {
      const a = p.attributes || {};
      const base = mintOf(p.relationships?.base_token);
      const quote = mintOf(p.relationships?.quote_token);
      if (!a.address || !base || QUOTE_MINTS.has(base) || !QUOTE_MINTS.has(quote)) continue;
      if (Number(a.reserve_in_usd || 0) < cfg.minLiquidityUsd) continue;
      pools.set(a.address, { address: a.address, mint: base, name: a.name, change24h: Number(a.price_change_percentage?.h24 || 0) });
    }
  }
  const list = [...pools.values()];
  if (get === geckoGet && list.length) trendingCache = { at: Date.now(), pools: list };
  return list;
}

// Suma una operación al historial de la wallet.
export function ingestTrade(pool, t, now = Date.now()) {
  const a = t.attributes || t;
  const wallet = a.tx_from_address;
  if (!wallet || !a.kind) return false;
  const ts = Date.parse(a.block_timestamp) || now;
  const usd = Number(a.volume_in_usd || 0);
  const w = (hunt.wallets[wallet] ||= { tokens: {}, trades: 0, firstSeen: ts, lastSeen: ts });
  const tk = (w.tokens[pool.mint] ||= { buyUsd: 0, buyTok: 0, sellUsd: 0, sellTok: 0, firstBuy: null, lastSell: null });
  if (a.kind === 'buy' && a.to_token_address === pool.mint) {
    tk.buyUsd += usd;
    tk.buyTok += Number(a.to_token_amount || 0);
    tk.firstBuy ??= ts;
  } else if (a.kind === 'sell' && a.from_token_address === pool.mint) {
    tk.sellUsd += usd;
    tk.sellTok += Number(a.from_token_amount || 0);
    tk.lastSell = Math.max(tk.lastSell || 0, ts);
  } else {
    return false;
  }
  w.trades++;
  w.firstSeen = Math.min(w.firstSeen, ts);
  w.lastSeen = Math.max(w.lastSeen, ts);
  return true;
}

// Resultados de una wallet: solo cuenta tokens donde vimos la compra y la venta.
export function walletStats(w) {
  let pnl = 0;
  let closed = 0;
  let wins = 0;
  let quickFlips = 0;
  for (const tk of Object.values(w.tokens)) {
    if (!tk.buyTok || !tk.sellTok) continue;
    const soldFrac = Math.min(1, tk.sellTok / tk.buyTok);
    const p = tk.sellUsd - tk.buyUsd * soldFrac;
    pnl += p;
    closed++;
    if (p > 0) wins++;
    if (tk.firstBuy && tk.lastSell && tk.lastSell - tk.firstBuy < QUICK_FLIP_MS) quickFlips++;
  }
  const days = Math.max(1, (w.lastSeen - w.firstSeen) / DAY);
  return {
    pnl,
    closed,
    wins,
    winRate: closed ? (wins / closed) * 100 : 0,
    tradesPerDay: w.trades / days,
    quickFlipPct: closed ? (quickFlips / closed) * 100 : 0,
  };
}

// ¿Es una smart wallet copiable? Gana, acierta, y no es un bot de alta frecuencia.
export function qualifies(s) {
  return (
    s.closed >= cfg.hunterMinTokens &&
    s.winRate >= cfg.hunterMinWinRate &&
    s.pnl >= cfg.hunterMinPnlUsd &&
    s.tradesPerDay <= 150 &&
    s.quickFlipPct < 50
  );
}

// Las mejores wallets "del momento": califican y han operado en las últimas 24 h.
export function topWallets(n, exclude = () => false, now = Date.now()) {
  return Object.entries(hunt.wallets)
    .filter(([, w]) => now - w.lastSeen < DAY)
    .map(([wallet, w]) => ({ wallet, ...walletStats(w) }))
    .filter((c) => qualifies(c) && !exclude(c.wallet))
    .sort((a, b) => b.pnl * b.winRate - a.pnl * a.winRate)
    .slice(0, n);
}

export function candidates(tracked = new Set()) {
  return Object.entries(hunt.wallets)
    .map(([wallet, w]) => ({ wallet, ...walletStats(w) }))
    .filter((c) => qualifies(c) && !tracked.has(c.wallet))
    .sort((a, b) => b.pnl * b.winRate - a.pnl * a.winRate);
}

function prune(now = Date.now()) {
  for (const [addr, w] of Object.entries(hunt.wallets)) {
    const tokens = Object.keys(w.tokens).length;
    if ((tokens < 2 && now - w.lastSeen > DAY) || now - w.lastSeen > 7 * DAY) delete hunt.wallets[addr];
  }
  for (const [pool, c] of Object.entries(hunt.poolCursor)) if (now - c > 3 * DAY) delete hunt.poolCursor[pool];
}

export async function scanOnce({ log, get = geckoGet }) {
  const pools = await trendingPools(get);
  let trades = 0;
  for (const pool of pools.slice(0, 30)) {
    try {
      const res = await get(`${GT}/networks/solana/pools/${pool.address}/trades?trade_volume_in_usd_greater_than=50`);
      const cursor = hunt.poolCursor[pool.address] || 0;
      let newest = cursor;
      for (const t of res?.data || []) {
        const ts = Date.parse(t.attributes?.block_timestamp) || 0;
        if (ts <= cursor) continue;
        if (ingestTrade(pool, t)) trades++;
        newest = Math.max(newest, ts);
      }
      hunt.poolCursor[pool.address] = newest;
      hunt.poolsAnalyzed++;
    } catch (e) {
      hunt.lastError = `${pool.name}: ${e.message}`;
    }
  }
  hunt.tradesSeen += trades;
  hunt.scans++;
  hunt.lastScan = Date.now();
  prune();
  persist();
  log('hunter', `revisó ${Math.min(pools.length, 30)} tokens en tendencia · ${trades} operaciones nuevas · ${Object.keys(hunt.wallets).length} wallets en estudio`);
}

// Añade las mejores candidatas a la lista vigilada, sin pasar del máximo.
export function pickNew(tracked) {
  const room = cfg.hunterMaxWallets - tracked.size;
  if (room <= 0) return [];
  return candidates(tracked).slice(0, room);
}

export function recordAdded(list) {
  for (const c of list) {
    hunt.added[c.wallet] = { at: Date.now(), pnl: Math.round(c.pnl), winRate: Math.round(c.winRate), closed: c.closed };
  }
  persist();
}
