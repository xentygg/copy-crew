// SCOUT — vigila las smart wallets y avisa cuando varias compran el mismo token.
import { cfg, QUOTE_MINTS, SOL_MINT } from '../config.js';
import { state, save, log } from '../state.js';

let tracked = new Set();
let direct = new Set(); // Top 10: se copian al instante, sin confirmación ni filtros
const pending = new Map(); // mint -> Map(wallet -> buy)
const recentSells = new Map(); // `${wallet}:${mint}` -> timestamp
const decided = new Map(); // mint -> timestamp (no reevaluar el mismo token durante un rato)
const DECIDED_TTL = 30 * 60_000;

export function setTrackedWallets(list) {
  tracked = new Set(list);
}

export function setDirectWallets(list) {
  direct = new Set(list);
}

// Convierte una transacción "enhanced" de Helius en compras/ventas de las wallets vigiladas.
export function parseSwaps(tx) {
  if (!tx || tx.transactionError) return [];
  const byWallet = new Map(); // wallet -> { sol: lamports, tokens: Map(mint -> {ui, decimals}) }
  const get = (w) => {
    if (!byWallet.has(w)) byWallet.set(w, { sol: 0, tokens: new Map() });
    return byWallet.get(w);
  };

  for (const acc of tx.accountData || []) {
    if (tracked.has(acc.account) && acc.nativeBalanceChange) get(acc.account).sol += Number(acc.nativeBalanceChange);
    for (const ch of acc.tokenBalanceChanges || []) {
      if (!tracked.has(ch.userAccount)) continue;
      const decimals = Number(ch.rawTokenAmount?.decimals ?? 0);
      const raw = Number(ch.rawTokenAmount?.tokenAmount ?? 0);
      const e = get(ch.userAccount);
      if (ch.mint === SOL_MINT) {
        e.sol += raw; // wSOL cuenta como SOL
        continue;
      }
      const t = e.tokens.get(ch.mint) || { ui: 0, decimals };
      t.ui += raw / 10 ** decimals;
      e.tokens.set(ch.mint, t);
    }
  }

  const out = [];
  for (const [wallet, e] of byWallet) {
    const moved = [...e.tokens].filter(([mint, t]) => !QUOTE_MINTS.has(mint) && t.ui !== 0);
    if (moved.length !== 1) continue; // ignorar transacciones raras o multi-token
    const [mint, t] = moved[0];
    const sol = e.sol / 1e9;
    const base = { wallet, mint, tokens: Math.abs(t.ui), decimals: t.decimals, sig: tx.signature, t: (tx.timestamp || Date.now() / 1000) * 1000 };
    if (t.ui > 0 && sol < 0) out.push({ ...base, side: 'buy', sol: -sol });
    else if (t.ui < 0 && sol > 0) out.push({ ...base, side: 'sell', sol });
  }
  return out;
}

export function walletSoldSince(wallet, mint, since) {
  const t = recentSells.get(`${wallet}:${mint}`);
  return t !== undefined && t >= since;
}

export function markDecided(mint) {
  decided.set(mint, Date.now());
}

// onSignal(mint, buys) se llama cuando se alcanza la confirmación.
// onWalletSell(swap) se llama con cada venta (para que Guard siga a la wallet).
export function ingest(tx, { onSignal, onWalletSell, onDirect }) {
  for (const s of parseSwaps(tx)) {
    if (s.side === 'sell') {
      recentSells.set(`${s.wallet}:${s.mint}`, s.t);
      onWalletSell(s);
      continue;
    }
    if (s.sol < cfg.minWalletBuySol) continue;
    state.counters.seen++;
    save();

    if (direct.has(s.wallet)) {
      log('top10', `${short(s.wallet)} (Top ${cfg.topN}) compró ${s.sol.toFixed(2)} SOL de ${short(s.mint)} → copia directa`);
      onDirect?.(s.mint, s);
      continue;
    }
    if (!cfg.stratTeam) continue;

    const d = decided.get(s.mint);
    if (d && Date.now() - d < DECIDED_TTL) continue;

    const buys = pending.get(s.mint) || new Map();
    if (!buys.has(s.wallet)) buys.set(s.wallet, s);
    for (const [w, b] of buys) if (Date.now() - b.t > cfg.confirmWindowMs) buys.delete(w);
    pending.set(s.mint, buys);

    log('scout', `${short(s.wallet)} compró ${s.sol.toFixed(2)} SOL de ${short(s.mint)} (${buys.size}/${cfg.confirmWallets})`);
    if (buys.size >= cfg.confirmWallets) {
      pending.delete(s.mint);
      markDecided(s.mint);
      state.counters.signals++;
      save();
      onSignal(s.mint, [...buys.values()]);
    }
  }
}

// Limpieza periódica de memoria.
setInterval(() => {
  const now = Date.now();
  for (const [mint, buys] of pending) {
    for (const [w, b] of buys) if (now - b.t > cfg.confirmWindowMs) buys.delete(w);
    if (!buys.size) pending.delete(mint);
  }
  for (const [k, t] of recentSells) if (now - t > 6 * 3600_000) recentSells.delete(k);
  for (const [k, t] of decided) if (now - t > DECIDED_TTL) decided.delete(k);
}, 60_000).unref();

export const short = (a) => (a ? `${a.slice(0, 4)}…${a.slice(-4)}` : '?');
