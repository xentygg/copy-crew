// SNIPER — compra una porción del tamaño de la smart wallet y vende cuando Guard lo ordena.
import { cfg, SOL_MINT } from '../config.js';
import { state, save } from '../state.js';
import { keypair, getSolBalance, getTokenBalance, sendAndConfirm, closeEmptyTokenAccounts } from '../solana.js';
import { quote, buildSwap } from '../jupiter.js';
import { mutex, sleep } from '../http.js';

const exclusive = mutex(); // una transacción a la vez para medir balances sin mezclar
const ATA_RENT_SOL = 0.00203928;
const PAPER_FEE_SOL = 0.0006; // comisión aproximada por swap en modo simulado

export function isPaper() {
  return state.mode !== 'live';
}

export async function cashSol() {
  if (isPaper()) return state.paperCashSol;
  return Number(await getSolBalance()) / 1e9;
}

// Tamaño de la copia: COPY_PCT % de lo que gastaron las wallets, dentro de los límites.
export function sizeTrade(buys, solUsd, { cash, investedSol }) {
  const avgSol = buys.reduce((s, b) => s + b.sol, 0) / buys.length;
  let sol = avgSol * (cfg.copyPct / 100);
  sol = Math.min(sol, cfg.maxTradeUsd / solUsd);
  sol = Math.min(sol, cfg.spendCapUsd / solUsd - investedSol);
  sol = Math.min(sol, cash - cfg.solReserve - ATA_RENT_SOL - 0.002);
  if (sol < cfg.minTradeUsd / solUsd) return 0;
  return sol;
}

export function buy(mint, amountSol, preQuote) {
  return exclusive(async () => {
    const lamports = BigInt(Math.floor(amountSol * 1e9));
    if (isPaper()) {
      const q = preQuote && preQuote.inAmount === lamports.toString() ? preQuote : await quote(SOL_MINT, mint, lamports);
      state.paperCashSol -= amountSol + PAPER_FEE_SOL;
      save();
      return { sig: 'simulado', tokensRaw: q.outAmount, costSol: amountSol + PAPER_FEE_SOL, rentSol: 0 };
    }

    const before = await getSolBalance();
    const hadAccount = (await getTokenBalance(keypair.publicKey, mint)).accounts.length > 0;
    const q = await quote(SOL_MINT, mint, lamports);
    const tx = await buildSwap(q, keypair.publicKey);
    tx.sign([keypair]);
    const sig = await sendAndConfirm(tx);

    // Leer lo que realmente llegó (puede tardar un instante en reflejarse).
    let bal = { raw: 0n };
    for (let i = 0; i < 5 && bal.raw === 0n; i++) {
      bal = await getTokenBalance(keypair.publicKey, mint);
      if (bal.raw === 0n) await sleep(1500);
    }
    const after = await getSolBalance();
    if (bal.raw === 0n) throw new Error(`compra confirmada (${sig}) pero no se ve el token`);
    return {
      sig,
      tokensRaw: bal.raw.toString(),
      costSol: Number(before - after) / 1e9,
      rentSol: hadAccount ? 0 : ATA_RENT_SOL,
    };
  });
}

export function sell(pos, attempt = 0) {
  return exclusive(async () => {
    const slippage = Math.min(cfg.slippageBps + attempt * 500, 3000);
    if (pos.paper) {
      const q = await quote(pos.mint, SOL_MINT, BigInt(pos.tokensRaw), slippage);
      const proceedsSol = Number(q.outAmount) / 1e9 - PAPER_FEE_SOL;
      state.paperCashSol += proceedsSol;
      save();
      return { sig: 'simulado', proceedsSol };
    }

    const before = await getSolBalance();
    const bal = await getTokenBalance(keypair.publicKey, pos.mint);
    // Sin tokens: un intento anterior ya vendió aunque no llegó a confirmarse a tiempo.
    if (bal.raw === 0n) return { sig: null, proceedsSol: pos.valueSol ?? pos.costSol, estimated: true };
    const q = await quote(pos.mint, SOL_MINT, bal.raw, slippage);
    const tx = await buildSwap(q, keypair.publicKey);
    tx.sign([keypair]);
    const sig = await sendAndConfirm(tx);
    try {
      await closeEmptyTokenAccounts(pos.mint);
    } catch (e) {
      console.warn('no se pudo cerrar la cuenta de token:', e.message);
    }
    const after = await getSolBalance();
    return { sig, proceedsSol: Number(after - before) / 1e9 };
  });
}

// Vende una parte de la posición (venta parcial para asegurar ganancia).
export function sellPart(pos, fraction) {
  return exclusive(async () => {
    if (pos.paper) {
      const part = (BigInt(pos.tokensRaw) * BigInt(Math.round(fraction * 1000))) / 1000n;
      const q = await quote(pos.mint, SOL_MINT, part);
      const proceedsSol = Number(q.outAmount) / 1e9 - PAPER_FEE_SOL;
      state.paperCashSol += proceedsSol;
      save();
      return { sig: 'simulado', proceedsSol, tokensLeft: (BigInt(pos.tokensRaw) - part).toString() };
    }

    const before = await getSolBalance();
    const bal = await getTokenBalance(keypair.publicKey, pos.mint);
    const part = (bal.raw * BigInt(Math.round(fraction * 1000))) / 1000n;
    if (part === 0n) throw new Error('no hay tokens para vender');
    const q = await quote(pos.mint, SOL_MINT, part);
    const tx = await buildSwap(q, keypair.publicKey);
    tx.sign([keypair]);
    const sig = await sendAndConfirm(tx);
    const after = await getSolBalance();
    const left = await getTokenBalance(keypair.publicKey, pos.mint);
    return { sig, proceedsSol: Number(after - before) / 1e9, tokensLeft: left.raw.toString() };
  });
}
