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
    partialTpPct: cfg.partialTpPct,
    partialTpFraction: cfg.partialTpFraction,
  };
}

// Plan de la estrategia de patrones: el mismo con el que Chartist mide si un patrón funciona.
export function patternPlan() {
  return {
    stopLossPct: cfg.patternSlPct,
    takeProfitPct: cfg.patternTpPct,
    trailActivatePct: 1e9, // sin trailing (no usar Infinity: no se puede guardar en JSON)
    trailPct: 0,
    maxHoldMs: cfg.patternHoldCandles * 5 * 60_000,
    partialTpPct: 0,
    partialTpFraction: 0,
  };
}

// Decide si hay que salir. Devuelve el motivo o null.
export function exitReason(pos, pnlPct, now = Date.now()) {
  const p = pos.plan;
  if (pos.forceExit) return pos.forceExit;
  if (pnlPct <= -p.stopLossPct) return `stop ${-p.stopLossPct}%`;
  // Tras la venta parcial, la operación completa nunca se deja volver a pérdidas
  // (+3% de margen para cubrir la comisión de la última venta).
  if (pos.partialTaken && pnlPct <= 3) return 'stop de seguridad tras venta parcial';
  if (pnlPct >= p.takeProfitPct) return `take profit +${p.takeProfitPct}%`;
  if (pos.peakPnlPct >= p.trailActivatePct && pnlPct <= pos.peakPnlPct - p.trailPct) {
    return `trailing (máx +${pos.peakPnlPct.toFixed(0)}%)`;
  }
  if (now - pos.openedAt > p.maxHoldMs) return 'tiempo máximo';
  return null;
}

// ¿Toca vender una parte para asegurar ganancia?
export function wantsPartial(pos, pnlPct) {
  const p = pos.plan;
  return Boolean(p.partialTpPct) && !pos.partialTaken && pnlPct >= p.partialTpPct && pnlPct < p.takeProfitPct;
}

// Valora la posición con una cotización real de venta (incluye slippage).
export async function valuePosition(pos) {
  const q = await quote(pos.mint, SOL_MINT, BigInt(pos.tokensRaw));
  // La renta de la cuenta de token (~0.002 SOL) se recupera al cerrar, así que cuenta como valor.
  const valueSol = Number(q.outAmount) / 1e9 + (pos.rentSol || 0);
  // Lo ya cobrado en ventas parciales también cuenta.
  const pnlPct = ((valueSol + (pos.realizedSol || 0)) / pos.costSol - 1) * 100;
  return { valueSol, pnlPct };
}
