// El equipo: conecta los 5 agentes. Una operación solo ocurre si los cinco la aprueban.
import { cfg } from './config.js';
import { state, save, log, kill, resetForMode } from './state.js';
import { short } from './agents/scout.js';
import { runFilter, sellCheck, dexInfo, REASONS as FILTER_REASONS } from './agents/filter.js';
import { runAnalyst, REASONS as ANALYST_REASONS } from './agents/analyst.js';
import { makePlan, patternPlan, exitReason, valuePosition, wantsPartial } from './agents/guard.js';
import { sizeTrade, sizeFixed, buy, sell, sellPart, cashSol, isPaper } from './agents/sniper.js';
import { PATTERNS } from './agents/chartist.js';
import { solPriceUsd } from './jupiter.js';
import { sleep } from './http.js';

const inFlight = new Set();

export const reasonLabel = (key) => {
  const [agent, r] = key.split(':');
  const table = agent === 'filter' ? FILTER_REASONS : ANALYST_REASONS;
  return table[r] ? table[r]() : r;
};

// Historial de tus copias por smart wallet. Una wallet con 3+ copias, pérdidas y poco acierto queda vetada.
export function walletRecord(wallet) {
  const r = { trades: 0, wins: 0, pnlUsd: 0 };
  for (const t of state.closed) {
    if (!t.sources?.some((s) => s.wallet === wallet)) continue;
    r.trades++;
    if (t.pnlUsd > 0) r.wins++;
    r.pnlUsd += t.pnlUsd / t.sources.length;
  }
  return r;
}

export function isVetoed(wallet) {
  if (!cfg.walletVeto) return false;
  const r = walletRecord(wallet);
  return r.trades >= 3 && r.pnlUsd < 0 && r.wins / r.trades < 0.34;
}

function investedSol() {
  return state.positions.reduce((s, p) => s + p.costSol, 0);
}

export async function handleSignal(mint, buys) {
  if (inFlight.has(mint) || state.positions.some((p) => p.mint === mint)) return;
  inFlight.add(mint);
  try {
    if (state.paused) return skip(mint, `en pausa (${state.pauseReason || 'manual'})`);
    if (state.positions.length >= cfg.maxOpenPositions) return skip(mint, 'máximo de posiciones abiertas');
    const good = buys.filter((b) => !isVetoed(b.wallet));
    if (!good.length) return skip(mint, `wallet vetada por mal historial (${buys.map((b) => short(b.wallet)).join(', ')})`);
    buys = good;

    // FILTER
    const f = await runFilter(mint);
    if (!f.ok) {
      kill('filter', f.reason, f.detail);
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
      kill('analyst', a.reason, a.detail);
      return log('analyst', `✗ ${f.ctx.symbol}: ${ANALYST_REASONS[a.reason]()} ${a.detail ? `(${short(a.detail)})` : ''}`);
    }
    log('analyst', `✓ ${f.ctx.symbol}: wallets siguen dentro, entrada +${a.premiumPct.toFixed(0)}% sobre ellas`);

    // GUARD — el plan de salida existe antes de que se gaste un solo SOL
    const plan = makePlan();
    state.counters.guardSet++;
    log('guard', `${f.ctx.symbol}: stop −${plan.stopLossPct}%, vende ${Math.round(plan.partialTpFraction * 100)}% en +${plan.partialTpPct}%, TP +${plan.takeProfitPct}%, trailing ${plan.trailPct}% tras +${plan.trailActivatePct}%`);

    // SNIPER
    await openPosition({ strategy: 'equipo', mint, symbol: f.ctx.symbol, amountSol, preQuote: a.quote, plan, solUsd, buys });
  } catch (e) {
    log('error', `${short(mint)}: ${e.message}`);
  } finally {
    inFlight.delete(mint);
  }
}

const sourcesOf = (buys) => buys.map((b) => ({ wallet: b.wallet, sol: b.sol, tokens: b.tokens, soldTokens: 0, sig: b.sig, t: b.t }));

async function openPosition({ strategy, mint, symbol, amountSol, preQuote, plan, solUsd, buys = [], pattern }) {
  const r = await buy(mint, amountSol, preQuote);
  const pos = {
    id: `${mint}-${Date.now()}`,
    strategy,
    pattern,
    mint,
    symbol,
    paper: isPaper(),
    openedAt: Date.now(),
    plan,
    tokensRaw: r.tokensRaw,
    costSol: r.costSol,
    rentSol: r.rentSol,
    solUsdAtOpen: solUsd,
    buySig: r.sig,
    sources: sourcesOf(buys),
    valueSol: r.costSol,
    pnlPct: 0,
    peakPnlPct: 0,
    sellFails: 0,
  };
  state.positions.push(pos);
  state.counters.copied++;
  save();
  const why = strategy === 'patrones' ? `patrón ${pattern}` : strategy === 'top10' ? 'Top 10' : 'equipo 5/5';
  log('sniper', `${pos.paper ? '[SIM] ' : ''}compró ${symbol} (${why}): ${r.costSol.toFixed(3)} SOL (~$${(r.costSol * solUsd).toFixed(2)}) ${r.sig}`);
  return pos;
}

function canOpen(mint) {
  if (inFlight.has(mint) || state.positions.some((p) => p.mint === mint)) return 'ya en curso';
  if (state.paused) return `en pausa (${state.pauseReason || 'manual'})`;
  if (state.positions.length >= cfg.maxOpenPositions) return 'máximo de posiciones abiertas';
  return null;
}

// Filter de seguridad + prueba anti-trampa. Devuelve true si el token es seguro.
async function safetyCheck(mint, amountSol, { momentum, label }) {
  const f = await runFilter(mint, { momentum });
  if (!f.ok) {
    kill('filter', f.reason, f.detail);
    log('filter', `✗ ${label} ${f.ctx?.symbol || short(mint)}: ${FILTER_REASONS[f.reason]()} ${f.detail || ''}`);
    return null;
  }
  const s = await sellCheck(mint, BigInt(Math.floor(amountSol * 1e9)));
  if (!s.ok) {
    kill('filter', s.reason, s.detail);
    log('filter', `✗ ${label} ${f.ctx.symbol}: ${FILTER_REASONS[s.reason]()} ${s.detail || ''}`);
    return null;
  }
  log('filter', `✓ ${label} ${f.ctx.symbol}: seguro (liq $${Math.round(f.ctx.liquidityUsd)}, top10 ${f.ctx.top10.toFixed(0)}%${s.unknown ? '' : `, ida y vuelta −${s.lossPct.toFixed(1)}%`})`);
  return f.ctx;
}

// TOP 10 — sigue a la wallet sin exigir confirmación ni impulso. Con "protección" (por defecto) pasa antes
// Filter de seguridad, prueba anti-trampa y Analyst; sin ella copia al instante. Guard siempre pone su plan de salida.
export async function handleDirect(mint, b) {
  if (!cfg.stratTop10) return;
  const no = canOpen(mint);
  if (no) return no === 'ya en curso' ? undefined : skip(mint, no);
  inFlight.add(mint);
  try {
    const solUsd = await solPriceUsd();
    const amountSol = sizeTrade([b], solUsd, { cash: await cashSol(), investedSol: investedSol() });
    if (!amountSol) return skip(mint, 'sin saldo suficiente o límite de gasto alcanzado');
    let symbol = short(mint);
    let preQuote;
    if (cfg.top10Safety) {
      const ctx = await safetyCheck(mint, amountSol, { momentum: false, label: 'Top 10' });
      if (!ctx) return;
      symbol = ctx.symbol || symbol;
      const a = await runAnalyst(mint, [b], BigInt(Math.floor(amountSol * 1e9)), ctx.decimals);
      if (!a.ok) {
        kill('analyst', a.reason, a.detail);
        return log('analyst', `✗ Top 10 ${symbol}: ${ANALYST_REASONS[a.reason]()} ${a.detail ? `(${short(a.detail)})` : ''}`);
      }
      log('analyst', `✓ Top 10 ${symbol}: la wallet sigue dentro, entrada +${a.premiumPct.toFixed(0)}% sobre ella`);
      preQuote = a.quote;
    } else {
      // Sin protección: copia al instante. Solo se busca el nombre del token (si tarda o falla, se usa la dirección).
      try {
        symbol = (await dexInfo(mint)).symbol || symbol;
      } catch {}
    }
    const plan = makePlan();
    state.counters.guardSet++;
    await openPosition({ strategy: 'top10', mint, symbol, amountSol, preQuote, plan, solUsd, buys: [b] });
  } catch (e) {
    log('error', `Top 10 ${short(mint)}: ${e.message}`);
  } finally {
    inFlight.delete(mint);
  }
}

// PATRONES — Chartist vio un patrón con historial probado. Comprobación mínima: mint y freeze revocados.
export async function handlePattern(pool, patterns) {
  if (!cfg.stratPatterns) return;
  const mint = pool.mint;
  const no = canOpen(mint);
  if (no) return no === 'ya en curso' ? undefined : skip(mint, no);
  inFlight.add(mint);
  try {
    const solUsd = await solPriceUsd();
    const amountSol = sizeFixed(solUsd, { cash: await cashSol(), investedSol: investedSol() });
    if (!amountSol) return skip(mint, 'sin saldo suficiente o límite de gasto alcanzado');
    if (!(await safetyCheck(mint, amountSol, { momentum: false, label: 'Patrón' }))) return;
    const pattern = patterns.map((p) => PATTERNS[p] || p).join(' + ');
    const plan = patternPlan();
    state.counters.guardSet++;
    await openPosition({ strategy: 'patrones', mint, symbol: (pool.name || short(mint)).split(' / ')[0], amountSol, plan, solUsd, pattern });
  } catch (e) {
    log('error', `patrones ${pool.name}: ${e.message}`);
  } finally {
    inFlight.delete(mint);
  }
}

function skip(mint, why) {
  state.counters.skipped++;
  log('sniper', `– ${short(mint)} ignorado: ${why}`);
}

// Si una de las wallets que copiamos vende, Guard ordena salir.
// Si una de las wallets copiadas vende al menos FOLLOW_SELL_MIN_PCT de lo que compró, Guard ordena salir.
// Las ventas pequeñas (tomar algo de ganancia) no hacen salir.
export function onWalletSell(s) {
  if (!cfg.followWalletSells) return;
  for (const p of state.positions) {
    const src = p.sources.find((x) => x.wallet === s.wallet);
    if (p.mint !== s.mint || !src || p.forceExit) continue;
    src.soldTokens = (src.soldTokens || 0) + s.tokens;
    const soldPct = src.tokens ? (src.soldTokens / src.tokens) * 100 : 100;
    if (soldPct >= cfg.followSellMinPct) {
      p.forceExit = `la wallet ${short(s.wallet)} vendió ${Math.min(100, Math.round(soldPct))}%`;
      log('guard', `${p.symbol}: ${p.forceExit} → salir`);
    } else {
      log('guard', `${p.symbol}: la wallet ${short(s.wallet)} vendió solo ${Math.round(soldPct)}% → se mantiene`);
    }
    save();
  }
}

export function forceSell(id, why = 'venta manual') {
  for (const p of state.positions) if (id === 'all' || p.id === id) p.forceExit = why;
  save();
}

async function closePosition(pos, reason) {
  const r = await sell(pos, pos.sellFails);
  const solUsd = await solPriceUsd().catch(() => pos.solUsdAtOpen);
  const proceedsSol = r.proceedsSol + (pos.realizedSol || 0); // incluye lo cobrado en la venta parcial
  const pnlSol = proceedsSol - pos.costSol;
  const trade = {
    ...pos,
    closedAt: Date.now(),
    exitReason: reason,
    sellSig: r.sig,
    proceedsSol,
    pnlSol,
    pnlUsd: pnlSol * solUsd,
    pnlPct: (proceedsSol / pos.costSol - 1) * 100,
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
        if (wantsPartial(pos, v.pnlPct)) {
          const r = await sellPart(pos, pos.plan.partialTpFraction);
          pos.realizedSol = (pos.realizedSol || 0) + r.proceedsSol;
          pos.tokensRaw = r.tokensLeft;
          pos.partialTaken = true;
          save();
          log('sniper', `${pos.paper ? '[SIM] ' : ''}${pos.symbol}: vendió ${Math.round(pos.plan.partialTpFraction * 100)}% en +${v.pnlPct.toFixed(0)}% (asegura ${r.proceedsSol.toFixed(3)} SOL) · el resto tiene stop de seguridad`);
          continue;
        }
        const why = exitReason(pos, v.pnlPct);
        if (why) {
          pos.forceExit = why; // si la venta falla, se reintenta en la siguiente vuelta
          await closePosition(pos, why);
        }
      } catch (e) {
        // Un fallo pasajero de Jupiter (saturado, red) no es motivo para vender.
        // Solo cuenta cuando Jupiter dice de verdad que no hay ruta; ~2 min seguidos → vender igualmente.
        if (!e.transient) pos.quoteFails = (pos.quoteFails || 0) + 1;
        if (pos.forceExit || pos.quoteFails > 12) {
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
    await sleep(3000); // el ritmo real lo marca el regulador de peticiones a Jupiter
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
