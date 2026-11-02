import { test } from 'node:test';
import assert from 'node:assert/strict';
import { cfg } from '../src/config.js';
import { state } from '../src/state.js';
import { hunt } from '../src/agents/hunter.js';
import { computeTop, top } from '../src/wallets.js';
import { handleDirect, handlePattern } from '../src/crew.js';
import { connection } from '../src/solana.js';

const SOL = 'So11111111111111111111111111111111111111112';
const MINT = 'DezXAZ8z7PnrnRJjz3wXBoRgixCa6xjnB7YaB1pPB263';

test('Top 10: elige las mejores wallets activas y excluye las vetadas', () => {
  const now = Date.now();
  const w = (pnl, last = now) => ({ trades: 8, firstSeen: now - 3600_000, lastSeen: last, tokens: Object.fromEntries([1, 2, 3, 4].map((k) => [`M${k}`, { buyUsd: 100, buyTok: 10, sellUsd: 100 + pnl / 4, sellTok: 10, firstBuy: now - 3600_000, lastSell: now - 1800_000 }])) });
  hunt.wallets = { GOOD1: w(2000), GOOD2: w(800), OLD: w(5000, now - 3 * 86400_000), SMALL: w(100) };
  state.closed = [1, 2, 3].map(() => ({ sources: [{ wallet: 'GOOD2' }], pnlUsd: -1 })); // GOOD2 vetada
  computeTop();
  const ids = top.map((t) => t.wallet);
  assert.equal(ids[0], 'GOOD1'); // la mejor del Hunter va primero
  for (const bad of ['GOOD2', 'OLD', 'SMALL']) assert.ok(!ids.includes(bad)); // vetada, inactiva, no llega a $300
  assert.equal(ids.length, cfg.topN); // el resto se completa con la lista de reserva
  assert.equal(top[1].source, 'lista');
  state.closed = [];
  hunt.wallets = {};
});

// Mercado simulado: pool, RugCheck, mint y cotizaciones de compra y venta configurables.
const market = { liquidity: 80000, sellStatus: 200, sellBackLamports: null, mintAuthority: null, walletHolds: 66 };
async function withMarket(fn) {
  const real = globalThis.fetch;
  globalThis.fetch = async (url) => {
    url = String(url);
    const ok = (j) => new Response(JSON.stringify(j));
    if (url.includes('price/v3')) return ok({ [SOL]: { usdPrice: 100 } });
    if (url.includes('dexscreener')) return ok([{ liquidity: { usd: market.liquidity }, baseToken: { address: MINT, symbol: 'MEME' }, dexId: 'pumpswap' }]);
    if (url.includes('rugcheck')) return ok({ creator: 'DEV', creatorBalance: 0, markets: [{ lp: { lpLockedPct: 100, quoteUSD: 1, baseUSD: 1 } }], topHolders: [{ address: 'a', owner: 'b', pct: 5 }] });
    if (url.includes('/quote')) {
      const u = new URL(url);
      const amount = u.searchParams.get('amount');
      if (u.searchParams.get('inputMint') === SOL) return ok({ inAmount: amount, outAmount: '5000000' });
      if (market.sellStatus !== 200) return new Response('{"error":"TOKEN_NOT_TRADABLE"}', { status: market.sellStatus });
      return ok({ inAmount: amount, outAmount: String(market.sellBackLamports) });
    }
    throw new Error('inesperado ' + url);
  };
  connection.getParsedTokenAccountsByOwner = async () => ({ value: [{ pubkey: 'x', account: { owner: 'tok', data: { parsed: { info: { tokenAmount: { amount: String(market.walletHolds * 1e6), uiAmount: market.walletHolds, decimals: 6 } } } } } }] });
  connection.getParsedAccountInfo = async () => ({ value: { data: { parsed: { info: { decimals: 6, supply: '1000000000000', mintAuthority: market.mintAuthority, freezeAuthority: null } } } } });
  try {
    await fn();
  } finally {
    globalThis.fetch = real;
  }
}

const WALLET = '7xKXtg2CW87d97TXJSDpbD5jBkheTqA83TZRuJosgAsU';
const buyFrom = (w = WALLET, tokens = 66.67) => handleDirect(MINT, { wallet: w, sol: 2, tokens, sig: 's', t: Date.now() });

test('Top 10 copia si el token es seguro y la wallet sigue dentro a buen precio', async () => {
  state.mode = 'watch';
  state.paperCashSol = 1;
  state.positions = [];
  Object.assign(market, { liquidity: 80000, sellStatus: 200, sellBackLamports: 140_000_000, mintAuthority: null });
  await withMarket(() => buyFrom());
  assert.equal(state.positions.length, 1);
  const p = state.positions[0];
  assert.equal(p.strategy, 'top10');
  assert.equal(p.symbol, 'MEME');
  assert.ok(Math.abs(p.costSol - 0.15 - 0.0006) < 1e-9); // $15 máx (3 posiciones) a $100/SOL + comisión simulada
  state.positions = [];
});

test('Top 10 rechaza pool pequeño, token que no se puede vender e impuesto oculto', async () => {
  state.paperCashSol = 1;
  state.positions = [];
  Object.assign(market, { liquidity: 1000, sellStatus: 200, sellBackLamports: 140_000_000 });
  await withMarket(() => buyFrom());
  assert.equal(state.positions.length, 0, 'pool de $1000');

  Object.assign(market, { liquidity: 80000, sellStatus: 400 });
  await withMarket(() => buyFrom());
  assert.equal(state.positions.length, 0, 'no se puede vender');

  Object.assign(market, { sellStatus: 200, sellBackLamports: 100_000_000 }); // compra 0.15 y al vender recibe 0.10: −33 %
  await withMarket(() => buyFrom());
  assert.equal(state.positions.length, 0, 'impuesto oculto');
  assert.ok(state.killReasons['filter:honeypot'] >= 1);
  assert.ok(state.killReasons['filter:tax'] >= 1);
});

test('Top 10: Analyst rechaza si la wallet ya vendió o si llegamos tarde', async () => {
  state.paperCashSol = 1;
  state.positions = [];
  Object.assign(market, { liquidity: 80000, sellStatus: 200, sellBackLamports: 140_000_000, mintAuthority: null, walletHolds: 10 });
  await withMarket(() => buyFrom()); // compró 66 y solo le quedan 10
  assert.equal(state.positions.length, 0, 'la wallet ya vendió');
  market.walletHolds = 1000;
  await withMarket(() => buyFrom(WALLET, 200)); // la wallet pagó 0.01 SOL/token y ahora cuesta 0.03: +200 %
  assert.equal(state.positions.length, 0, 'llegamos tarde');
  assert.ok(state.killReasons['analyst:sold'] >= 1);
  assert.ok(state.killReasons['analyst:late'] >= 1);
});

test('Patrones: compra con plan propio (+15% / −8%) y rechaza mint sin revocar', async () => {
  state.paperCashSol = 1;
  state.positions = [];
  Object.assign(market, { liquidity: 80000, sellStatus: 200, sellBackLamports: 140_000_000, mintAuthority: 'X' });
  await withMarket(() => handlePattern({ mint: MINT, name: 'MEME / SOL', address: 'P' }, ['ruptura']));
  assert.equal(state.positions.length, 0);
  market.mintAuthority = null;
  await withMarket(() => handlePattern({ mint: MINT, name: 'MEME / SOL', address: 'P' }, ['ruptura']));
  assert.equal(state.positions.length, 1);
  const p = state.positions[0];
  assert.equal(p.strategy, 'patrones');
  assert.equal(p.plan.takeProfitPct, cfg.patternTpPct);
  assert.equal(p.plan.stopLossPct, cfg.patternSlPct);
  assert.match(p.pattern, /Ruptura/);
  state.positions = [];
});

test('Top 10 sin protección: copia al instante aunque el pool sea pequeño', async () => {
  state.paperCashSol = 1;
  state.positions = [];
  Object.assign(market, { liquidity: 1000, sellStatus: 400, walletHolds: 0 });
  cfg.top10Safety = false;
  try {
    await withMarket(() => buyFrom());
    assert.equal(state.positions.length, 1);
    assert.equal(state.positions[0].plan.stopLossPct, cfg.stopLossPct); // Guard sigue poniendo su stop
  } finally {
    cfg.top10Safety = true;
    state.positions = [];
  }
});
