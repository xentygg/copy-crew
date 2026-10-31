// FILTER — mata la señal si se rompe una sola regla dura.
import { cfg } from '../config.js';
import { fetchJson } from '../http.js';
import { PublicKey } from '@solana/web3.js';
import { getMintInfo, connection } from '../solana.js';

export const REASONS = {
  liquidity: () => `pool bajo $${(cfg.minLiquidityUsd / 1000).toFixed(0)}k`,
  mint: () => 'mint no revocado',
  freeze: () => 'freeze no revocado',
  top10: () => `top 10 tenedores > ${cfg.maxTop10Pct}%`,
  dev: () => `wallet del dev > ${cfg.maxDevPct}%`,
  lp: () => 'LP no quemado',
  nodata: () => 'sin datos (fallo de API)',
  nodata_dex: () => 'sin datos: DexScreener',
  nodata_rpc: () => 'sin datos: Solana (Helius)',
  nodata_holders: () => 'sin datos: RugCheck y tenedores',
};

// Cuentas que pertenecen a pools de liquidez (no cuentan como "tenedores").
const POOL_AUTHORITIES = new Set([
  '5Q544fKrFoe6tsEbD7S8EmxGTJYAKtTVhAW5Q5pge4j1', // Raydium AMM v4
  'GpMZbSM2GgvTKHJirzeGfMFoaZ8UR2X7F4v8vHTvxFbL', // Raydium CPMM
  'WLHv2UAZm6z4KyaaELi5pjdbJh6RESMva1Rnn8pJVVh', // Raydium Launchpad
]);

export async function dexInfo(mint) {
  const pairs = await fetchJson(`https://api.dexscreener.com/tokens/v1/solana/${mint}`);
  const list = Array.isArray(pairs) ? pairs : pairs?.pairs || [];
  let best = null;
  for (const p of list) if (!best || (p.liquidity?.usd || 0) > (best.liquidity?.usd || 0)) best = p;
  return {
    liquidityUsd: best?.liquidity?.usd || 0,
    symbol: best?.baseToken?.address === mint ? best.baseToken.symbol : best?.quoteToken?.symbol || '?',
    priceUsd: Number(best?.priceUsd || 0),
    dexId: best?.dexId || '?',
  };
}

export function holderStats(report, supply, decimals) {
  const poolAccounts = new Set();
  for (const m of report.markets || []) {
    for (const k of ['pubkey', 'liquidityAAccount', 'liquidityBAccount', 'liquidityA', 'liquidityB']) {
      if (typeof m[k] === 'string') poolAccounts.add(m[k]);
    }
  }
  const supplyUi = Number(supply) / 10 ** decimals;
  const pctOf = (h) => {
    if (typeof h.pct === 'number') return h.pct;
    if (h.uiAmount && supplyUi) return (h.uiAmount / supplyUi) * 100;
    return 0;
  };
  const holders = (report.topHolders || []).filter(
    (h) => !poolAccounts.has(h.address) && !poolAccounts.has(h.owner) && !POOL_AUTHORITIES.has(h.owner),
  );
  const top10 = holders.slice(0, 10).reduce((s, h) => s + pctOf(h), 0);

  let devPct = 0;
  if (report.creatorBalance !== undefined && supplyUi > 0) {
    // RugCheck puede dar el saldo en unidades crudas o ya con decimales; >100% significa que era crudo.
    const asUi = (Number(report.creatorBalance) / supplyUi) * 100;
    devPct = asUi <= 100 ? asUi : asUi / 10 ** decimals;
  }
  const creatorHolder = holders.find((h) => h.owner === report.creator || h.address === report.creator);
  if (creatorHolder) devPct = Math.max(devPct, pctOf(creatorHolder));

  // % de LP quemado/bloqueado en el mercado con más liquidez.
  let lpPct = 0;
  let bestLiq = -1;
  for (const m of report.markets || []) {
    const liq = Number(m.lp?.quoteUSD || 0) + Number(m.lp?.baseUSD || 0);
    const locked = Number(m.lp?.lpLockedPct ?? 0);
    if (liq > bestLiq) {
      bestLiq = liq;
      lpPct = locked;
    }
  }
  return { top10, devPct, lpPct };
}

export let lastRugcheckError = null;

// Pools cuyo LP se quema siempre por diseño (pump.fun migra a PumpSwap quemando la liquidez).
const LP_BURNED_BY_DESIGN = new Set(['pumpswap']);

// Alternativa a RugCheck usando solo la blockchain. Los pools y bonding curves son cuentas
// de programa (fuera de la curva ed25519), así que solo cuentan los dueños que son wallets normales.
export async function chainHolderStats(mint, mintInfo, dexId) {
  const largest = await connection.getTokenLargestAccounts(new PublicKey(mint), 'confirmed');
  const accounts = largest.value.slice(0, 20);
  const infos = await connection.getMultipleParsedAccounts(accounts.map((a) => a.address), { commitment: 'confirmed' });
  const supplyUi = Number(mintInfo.supply) / 10 ** mintInfo.decimals;
  const byOwner = new Map();
  accounts.forEach((a, i) => {
    const owner = infos.value[i]?.data?.parsed?.info?.owner;
    if (!owner || !PublicKey.isOnCurve(new PublicKey(owner).toBytes())) return;
    byOwner.set(owner, (byOwner.get(owner) || 0) + Number(a.uiAmount || 0));
  });
  const top = [...byOwner.values()].sort((x, y) => y - x).slice(0, 10);
  const burned = LP_BURNED_BY_DESIGN.has(dexId);
  return {
    top10: supplyUi ? (top.reduce((s, x) => s + x, 0) / supplyUi) * 100 : 100,
    devPct: null, // sin RugCheck no sabemos quién es el creador
    lpPct: burned ? 100 : 0,
    lpUnknown: !burned,
    source: 'blockchain',
  };
}

export async function runFilter(mint) {
  let dex, mintInfo, report;
  try {
    dex = await dexInfo(mint);
  } catch (e) {
    return { ok: false, reason: 'nodata_dex', detail: e.message };
  }
  try {
    mintInfo = await getMintInfo(mint);
  } catch (e) {
    return { ok: false, reason: 'nodata_rpc', detail: e.message };
  }
  const ctx = { symbol: dex.symbol, liquidityUsd: dex.liquidityUsd, decimals: mintInfo.decimals, dexId: dex.dexId };

  // Reglas baratas primero.
  if (dex.liquidityUsd < cfg.minLiquidityUsd) return { ok: false, reason: 'liquidity', ctx, detail: `$${Math.round(dex.liquidityUsd)}` };
  if (mintInfo.mintAuthority) return { ok: false, reason: 'mint', ctx };
  if (mintInfo.freezeAuthority) return { ok: false, reason: 'freeze', ctx };

  let h;
  try {
    report = await fetchJson(`https://api.rugcheck.xyz/v1/tokens/${mint}/report`, { timeoutMs: 15_000 });
    h = holderStats(report, mintInfo.supply, mintInfo.decimals);
    lastRugcheckError = null;
  } catch (e) {
    // RugCheck caído o bloqueado: calcular lo esencial directamente desde la blockchain.
    lastRugcheckError = e.message;
    try {
      h = await chainHolderStats(mint, mintInfo, dex.dexId);
    } catch (e2) {
      return { ok: false, reason: 'nodata_holders', ctx, detail: `rugcheck: ${e.message} · blockchain: ${e2.message}` };
    }
  }
  Object.assign(ctx, h);

  if (h.top10 > cfg.maxTop10Pct) return { ok: false, reason: 'top10', ctx, detail: `${h.top10.toFixed(1)}%` };
  if (h.devPct !== null && h.devPct > cfg.maxDevPct) return { ok: false, reason: 'dev', ctx, detail: `${h.devPct.toFixed(1)}%` };
  if (h.lpPct < cfg.minLpBurnedPct) return { ok: false, reason: 'lp', ctx, detail: h.lpUnknown ? 'sin RugCheck no se puede comprobar' : `${h.lpPct.toFixed(0)}% quemado` };
  return { ok: true, ctx };
}
