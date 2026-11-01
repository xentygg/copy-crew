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
  assert.deepEqual(top.map((t) => t.wallet), ['GOOD1']); // OLD inactiva, SMALL no llega a $300, GOOD2 vetada
  state.closed = [];
  hunt.wallets = {};
});

async function withMarket(fn) {
  const real = globalThis.fetch;
  globalThis.fetch = async (url) => {
    url = String(url);
    const ok = (j) => new Response(JSON.stringify(j));
    if (url.includes('price/v3')) return ok({ [SOL]: { usdPrice: 100 } });
    if (url.includes('dexscreener')) return ok([{ liquidity: { usd: 1000 }, baseToken: { address: MINT, symbol: 'MEME' } }]);
    if (url.includes('/quote')) return ok({ inAmount: '1', outAmount: '5000000' });
    throw new Error('inesperado ' + url);
  };
  try {
    await fn();
  } finally {
    globalThis.fetch = real;
  }
}

test('Top 10 copia al instante, sin Filter (aunque el pool sea pequeño)', async () => {
  state.mode = 'watch';
  state.paperCashSol = 1;
  state.positions = [];
  await withMarket(() => handleDirect(MINT, { wallet: 'GOOD1', sol: 2, tokens: 1000, sig: 's', t: Date.now() }));
  assert.equal(state.positions.length, 1);
  const p = state.positions[0];
  assert.equal(p.strategy, 'top10');
  assert.equal(p.symbol, 'MEME');
  assert.ok(Math.abs(p.costSol - 0.15 - 0.0006) < 1e-9); // $15 máx (3 posiciones) a $100/SOL + comisión simulada
  state.positions = [];
});

test('Patrones: compra con plan propio (+15% / −8%) y rechaza mint sin revocar', async () => {
  state.paperCashSol = 1;
  state.positions = [];
  connection.getParsedAccountInfo = async () => ({ value: { data: { parsed: { info: { decimals: 6, supply: '1', mintAuthority: 'X', freezeAuthority: null } } } } });
  await withMarket(() => handlePattern({ mint: MINT, name: 'MEME / SOL', address: 'P' }, ['ruptura']));
  assert.equal(state.positions.length, 0);
  connection.getParsedAccountInfo = async () => ({ value: { data: { parsed: { info: { decimals: 6, supply: '1', mintAuthority: null, freezeAuthority: null } } } } });
  await withMarket(() => handlePattern({ mint: MINT, name: 'MEME / SOL', address: 'P' }, ['ruptura']));
  assert.equal(state.positions.length, 1);
  const p = state.positions[0];
  assert.equal(p.strategy, 'patrones');
  assert.equal(p.plan.takeProfitPct, cfg.patternTpPct);
  assert.equal(p.plan.stopLossPct, cfg.patternSlPct);
  assert.match(p.pattern, /Ruptura/);
  state.positions = [];
});
