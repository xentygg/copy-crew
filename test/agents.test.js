import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parseSwaps, setTrackedWallets } from '../src/agents/scout.js';
import { holderStats } from '../src/agents/filter.js';
import { exitReason, makePlan } from '../src/agents/guard.js';
import { sizeTrade } from '../src/agents/sniper.js';

const W = 'WaLLet1111111111111111111111111111111111111';
const M = 'MeMe11111111111111111111111111111111111111pump';
const SOL = 'So11111111111111111111111111111111111111112';

test('scout detecta compra y venta', () => {
  setTrackedWallets([W]);
  const buy = {
    signature: 's1', timestamp: 1700000000,
    accountData: [
      { account: W, nativeBalanceChange: -2_005_000_000, tokenBalanceChanges: [] },
      { account: 'ata', nativeBalanceChange: 0, tokenBalanceChanges: [{ userAccount: W, mint: M, rawTokenAmount: { tokenAmount: '5000000000', decimals: 6 } }] },
    ],
  };
  const [b] = parseSwaps(buy);
  assert.equal(b.side, 'buy'); assert.equal(b.mint, M); assert.equal(b.tokens, 5000); assert.ok(Math.abs(b.sol - 2.005) < 1e-9);

  const sell = {
    signature: 's2', timestamp: 1700000100,
    accountData: [
      { account: W, nativeBalanceChange: 0, tokenBalanceChanges: [] },
      { account: 'wsol', tokenBalanceChanges: [{ userAccount: W, mint: SOL, rawTokenAmount: { tokenAmount: '3000000000', decimals: 9 } }] },
      { account: 'ata', tokenBalanceChanges: [{ userAccount: W, mint: M, rawTokenAmount: { tokenAmount: '-5000000000', decimals: 6 } }] },
    ],
  };
  const [s] = parseSwaps(sell);
  assert.equal(s.side, 'sell'); assert.equal(s.sol, 3);
  assert.deepEqual(parseSwaps({ ...buy, transactionError: 'x' }), []);
});

test('filter excluye el pool del top 10', () => {
  const report = {
    creator: 'DEV', creatorBalance: 20_000_000_000_000, // 2% en unidades crudas (6 dec, supply 1e9)
    markets: [{ pubkey: 'POOL', liquidityAAccount: 'POOLA', lp: { lpLockedPct: 100, quoteUSD: 30000, baseUSD: 30000 } }],
    topHolders: [{ address: 'POOLA', owner: 'POOL', pct: 40 }, { address: 'h1', owner: 'x', pct: 5 }, { address: 'h2', owner: 'DEV', pct: 2 }],
  };
  const h = holderStats(report, 1_000_000_000_000_000n, 6);
  assert.equal(h.top10, 7); assert.ok(Math.abs(h.devPct - 2) < 1e-9); assert.equal(h.lpPct, 100);
});

test('guard: stop, take profit, trailing, tiempo', () => {
  const pos = { plan: makePlan(), openedAt: Date.now(), peakPnlPct: 0 };
  assert.match(exitReason(pos, -25), /stop/);
  assert.match(exitReason(pos, 150), /take profit/);
  assert.equal(exitReason(pos, 10), null);
  assert.match(exitReason({ ...pos, peakPnlPct: 60 }, 35), /trailing/);
  assert.match(exitReason({ ...pos, openedAt: 0 }, 0), /tiempo/);
});

test('sniper respeta límites de tamaño', () => {
  const solUsd = 200;
  // 10% de 16 SOL = 1.6 SOL, pero el máximo es $15 = 0.075 SOL
  assert.equal(sizeTrade([{ sol: 16 }], solUsd, { cash: 0.5, investedSol: 0 }), 0.075);
  // 10% de 0.3 SOL = 0.03 SOL = $6
  assert.ok(Math.abs(sizeTrade([{ sol: 0.3 }], solUsd, { cash: 0.5, investedSol: 0 }) - 0.03) < 1e-12);
  // límite de gasto casi alcanzado ($100 = 0.5 SOL, ya hay 0.49 invertidos)
  assert.equal(sizeTrade([{ sol: 16 }], solUsd, { cash: 0.5, investedSol: 0.49 }), 0);
  // sin saldo
  assert.equal(sizeTrade([{ sol: 16 }], solUsd, { cash: 0.04, investedSol: 0 }), 0);
});
