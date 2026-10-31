// GUARD — fija el stop ANTES de comprar y vigila cada posición abierta.
import { cfg, SOL_MINT } from '../config.js';
import { quote } from '../jupiter.js';

export function makePlan() {
  return {
    stopLossPct: cfg.stopLossPct,
    takeProfitPct: cfg.takeProfitPct,
    trailActivatePct: cfg.trailActivatePct,
    trailPct: cfg.trailPct,
    maxHoldMs: cfg.maxHoldMs,
  };
}

// Decide si hay que salir. Devuelve el motivo o null.
export function exitReason(pos, pnlPct, now = Date.now()) {
  const p = pos.plan;
  if (pos.forceExit) return pos.forceExit;
  if (pnlPct <= -p.stopLossPct) return `stop ${-p.stopLossPct}%`;
  if (pnlPct >= p.takeProfitPct) return `take profit +${p.takeProfitPct}%`;
  if (pos.peakPnlPct >= p.trailActivatePct && pnlPct <= pos.peakPnlPct - p.trailPct) {
    return `trailing (máx +${pos.peakPnlPct.toFixed(0)}%)`;
  }
  if (now - pos.openedAt > p.maxHoldMs) return 'tiempo máximo';
  return null;
}

// Valora la posición con una cotización real de venta (incluye slippage).
export async function valuePosition(pos) {
  const q = await quote(pos.mint, SOL_MINT, BigInt(pos.tokensRaw));
  // La renta de la cuenta de token (~0.002 SOL) se recupera al cerrar, así que cuenta como valor.
  const valueSol = Number(q.outAmount) / 1e9 + (pos.rentSol || 0);
  const pnlPct = (valueSol / pos.costSol - 1) * 100;
  return { valueSol, pnlPct };
}
