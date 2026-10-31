// ANALYST — comprueba que las smart wallets siguen dentro y que no llegamos tarde.
import { cfg, SOL_MINT } from '../config.js';
import { getTokenBalance } from '../solana.js';
import { quote } from '../jupiter.js';
import { walletSoldSince } from './scout.js';

export const REASONS = {
  sold: () => 'la wallet vendió temprano',
  late: () => `precio ya +${cfg.maxEntryPremiumPct}% (llegamos tarde)`,
  noroute: () => 'sin ruta de swap',
  nodata: () => 'sin datos: saldo de la smart wallet',
};

export async function runAnalyst(mint, buys, amountLamports, decimals) {
  // 1) ¿Siguen dentro?
  for (const b of buys) {
    if (walletSoldSince(b.wallet, mint, b.t)) return { ok: false, reason: 'sold', detail: b.wallet };
    try {
      const bal = await getTokenBalance(b.wallet, mint);
      if (bal.ui < b.tokens * 0.5) return { ok: false, reason: 'sold', detail: `${b.wallet} conserva ${bal.ui.toFixed(0)}/${b.tokens.toFixed(0)}` };
    } catch (e) {
      return { ok: false, reason: 'nodata', detail: e.message };
    }
  }

  // 2) ¿Precio actual vs. precio al que entró la última smart wallet?
  let q;
  try {
    q = await quote(SOL_MINT, mint, amountLamports);
  } catch (e) {
    return { ok: false, reason: 'noroute', detail: e.message };
  }
  const latest = buys.reduce((a, b) => (b.t > a.t ? b : a));
  const walletPrice = latest.sol / latest.tokens; // SOL por token
  const ourPrice = Number(amountLamports) / 1e9 / (Number(q.outAmount) / 10 ** decimals);
  const premiumPct = (ourPrice / walletPrice - 1) * 100;
  if (premiumPct > cfg.maxEntryPremiumPct) return { ok: false, reason: 'late', detail: `+${premiumPct.toFixed(0)}%` };
  return { ok: true, quote: q, premiumPct };
}
