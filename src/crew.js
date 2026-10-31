// El equipo: conecta los 5 agentes. Una operación solo ocurre si los cinco la aprueban.
import { cfg } from './config.js';
import { state, save, log, kill, resetForMode } from './state.js';
import { short } from './agents/scout.js';
import { runFilter, REASONS as FILTER_REASONS } from './agents/filter.js';
import { runAnalyst, REASONS as ANALYST_REASONS } from './agents/analyst.js';
import { makePlan, exitReason, valuePosition } from './agents/guard.js';
import { sizeTrade, buy, sell, cashSol, isPaper } from './agents/sniper.js';
import { solPriceUsd } from './jupiter.js';
import { sleep } from './http.js';

const inFlight = new Set();

export const reasonLabel = (key) => {
  const [agent, r] = key.split(':');
  const table = agent === 'filter' ? FILTER_REASONS : ANALYST_REASONS;
  return table[r] ? table[r]() : r;
};

function investedSol() {
  return state.positions.reduce((s, p) => s + p.costSol, 0);
}

export async function handleSignal(mint, buys) {
  if (inFlight.has(mint) || state.positions.some((p) => p.mint === mint)) return;
  inFlight.add(mint);
  try {
    if (state.paused) return skip(mint, `en pausa (${state.pauseReason || 'manual'})`);
    if (state.positions.length >= cfg.maxOpenPositions) return skip(mint, 'máximo de posiciones abiertas');

    // FILTER
    const f = await runFilter(mint);
    if (!f.ok) {
      kill('filter', f.reason);
      return log('filter', `✗ ${f.ctx?.symbol || short(mint)}: ${FILTER_REASONS[f.reason]()} ${f.detail || ''}`);
    }
    log('filter', `✓ ${f.ctx.symbol} pasa las reglas (liq $${Math.round(f.ctx.liquidityUsd)}, top10 ${f.ctx.top10.toFixed(0)}%)`);

    // Tamaño (necesario para que Analyst cotice el precio real de entrada)
    const solUsd = await solPriceUsd();
    const amountSol = sizeTrade(buys, solUsd, { cash: await cashSol(), investedSol: investedSol() });
    if (!amountSol) return skip(mint, 'sin saldo suficiente o límite de gasto alcanzado');

    // ANALYST
    const a = await runAnalyst(mint, buys, BigInt(Math.floor(amountSol * 1e9)), f.ctx.decimals);
    if (!a.ok) {
      kill('analyst', a.reason);
      return log('analyst', `✗ ${f.ctx.symbol}: ${ANALYST_REASONS[a.reason]()} ${a.detail ? `(${short(a.detail)})` : ''}`);
    }
    log('analyst', `✓ ${f.ctx.symbol}: wallets siguen dentro, entrada +${a.premiumPct.toFixed(0)}% sobre ellas`);

    // GUARD — el plan de salida existe antes de que se gaste un solo SOL
    const plan = makePlan();
    state.counters.guardSet++;
    log('guard', `${f.ctx.symbol}: stop −${plan.stopLossPct}%, TP +${plan.takeProfitPct}%, trailing ${plan.trailPct}% tras +${plan.trailActivatePct}%`);

    // SNIPER
    const r = await buy(mint, amountSol, a.quote);
    const pos = {
      id: `${mint}-${Date.now()}`,
      mint,
      symbol: f.ctx.symbol,
      paper: isPaper(),
      openedAt: Date.now(),
      plan,
      tokensRaw: r.tokensRaw,
      costSol: r.costSol,
      rentSol: r.rentSol,
      solUsdAtOpen: solUsd,
      buySig: r.sig,
      sources: buys.map((b) => ({ wallet: b.wallet, sol: b.sol, sig: b.sig, t: b.t })),
      valueSol: r.costSol,
      pnlPct: 0,
      peakPnlPct: 0,
      sellFails: 0,
    };
    state.positions.push(pos);
    state.counters.copied++;
    save();
    log('sniper', `${pos.paper ? '[SIM] ' : ''}copió ${pos.symbol}: ${r.costSol.toFixed(3)} SOL (~$${(r.costSol * solUsd).toFixed(2)}) ${r.sig}`);
  } catch (e) {
    log('error', `${short(mint)}: ${e.message}`);
  } finally {
    inFlight.delete(mint);
  }
}

function skip(mint, why) {
  state.counters.skipped++;
  log('sniper', `– ${short(mint)} ignorado: ${why}`);
}

// Si una de las wallets que copiamos vende, Guard ordena salir.
export function onWalletSell(s) {
  if (!cfg.followWalletSells) return;
  for (const p of state.positions) {
    if (p.mint === s.mint && p.sources.some((src) => src.wallet === s.wallet) && !p.forceExit) {
      p.forceExit = `la wallet ${short(s.wallet)} vendió`;
      log('guard', `${p.symbol}: ${p.forceExit} → salir`);
    }
  }
}

export function forceSell(id, why = 'venta manual') {
  for (const p of state.positions) if (id === 'all' || p.id === id) p.forceExit = why;
  save();
}

async function closePosition(pos, reason) {
  const r = await sell(pos, pos.sellFails);
  const solUsd = await solPriceUsd().catch(() => pos.solUsdAtOpen);
  const pnlSol = r.proceedsSol - pos.costSol;
  const trade = {
    ...pos,
    closedAt: Date.now(),
    exitReason: reason,
    sellSig: r.sig,
    proceedsSol: r.proceedsSol,
    pnlSol,
    pnlUsd: pnlSol * solUsd,
    pnlPct: (r.proceedsSol / pos.costSol - 1) * 100,
  };
  state.positions = state.positions.filter((p) => p.id !== pos.id);
  state.closed.unshift(trade);
  if (state.closed.length > 500) state.closed.length = 500;
  save();
  const sign = trade.pnlUsd >= 0 ? '+' : '−';
  log('sniper', `${pos.paper ? '[SIM] ' : ''}vendió ${pos.symbol} (${reason}): ${sign}$${Math.abs(trade.pnlUsd).toFixed(2)} (${trade.pnlPct.toFixed(0)}%)`);
}

// Bucle de Guard: valora cada posición y ejecuta la salida cuando toca.
export async function guardLoop() {
  for (;;) {
    for (const pos of [...state.positions]) {
      try {
        const v = await valuePosition(pos);
        pos.valueSol = v.valueSol;
        pos.pnlPct = v.pnlPct;
        pos.peakPnlPct = Math.max(pos.peakPnlPct, v.pnlPct);
        pos.quoteFails = 0;
        const why = exitReason(pos, v.pnlPct);
        if (why) {
          pos.forceExit = why; // si la venta falla, se reintenta en la siguiente vuelta
          await closePosition(pos, why);
        }
      } catch (e) {
        pos.quoteFails = (pos.quoteFails || 0) + 1;
        if (pos.forceExit || pos.quoteFails > 3) {
          // Intentar vender igualmente con más slippage.
          pos.sellFails++;
          try {
            await closePosition(pos, pos.forceExit || 'sin cotización');
          } catch (e2) {
            log('error', `no se pudo vender ${pos.symbol} (intento ${pos.sellFails}): ${e2.message}`);
          }
        }
      }
    }
    save();
    await sleep(state.positions.length ? 4000 : 2000);
  }
}

// Registra el capital cada 30 s y aplica el límite de pérdidas.
export async function equityLoop() {
  for (;;) {
    try {
      const solUsd = await solPriceUsd();
      const cash = await cashSol();
      const posValue = state.positions.reduce((s, p) => s + (p.valueSol ?? p.costSol), 0);
      const usd = (cash + posValue) * solUsd;
      if (!state.startEquityUsd || state.startEquityUsd < 1) state.startEquityUsd = usd >= 1 ? usd : null;
      state.equityUsd = usd;
      state.solUsd = solUsd;
      state.equity.push({ t: Date.now(), usd: Math.round(usd * 100) / 100 });
      if (state.equity.length > 2880) state.equity.splice(0, state.equity.length - 2880);
      state.peakEquityUsd = Math.max(state.peakEquityUsd, usd);
      const dd = (1 - usd / state.peakEquityUsd) * 100;
      state.maxDrawdownPct = Math.max(state.maxDrawdownPct, dd);
      if (!state.paused && state.startEquityUsd && usd < state.startEquityUsd * (1 - cfg.lossLimitPct / 100)) {
        state.paused = true;
        state.pauseReason = `límite de pérdida −${cfg.lossLimitPct}%`;
        log('guard', `⛔ capital $${usd.toFixed(2)}: se alcanzó el límite de pérdida. No se compra más.`);
      }
      save();
    } catch (e) {
      console.warn('equity:', e.message);
    }
    await sleep(30_000);
  }
}

export async function switchMode(mode) {
  if (mode === state.mode) return;
  if (state.positions.some((p) => !p.paper)) throw new Error('hay posiciones reales abiertas; véndelas antes de cambiar de modo');
  resetForMode(mode);
  await initMode();
  log('crew', mode === 'live' ? '🔴 MODO REAL activado' : 'Modo observación (simulado) activado');
}

export async function initMode() {
  if (state.mode !== 'live' && state.paperCashSol === null) {
    state.paperCashSol = cfg.spendCapUsd / (await solPriceUsd());
    save();
  }
}
