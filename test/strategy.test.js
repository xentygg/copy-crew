import { test } from 'node:test';
import assert from 'node:assert/strict';
import { cfg } from '../src/config.js';
import { state } from '../src/state.js';
import { exitReason, wantsPartial, makePlan } from '../src/agents/guard.js';
import { onWalletSell, isVetoed } from '../src/crew.js';
import { runFilter } from '../src/agents/filter.js';
import { connection } from '../src/solana.js';

test('venta parcial en +25% y stop de seguridad después', () => {
  const pos = { plan: makePlan(), openedAt: Date.now(), peakPnlPct: 30 };
  assert.equal(wantsPartial(pos, 10), false);
  assert.equal(wantsPartial(pos, 27), true);
  assert.equal(wantsPartial(pos, 150), false); // ahí manda el take profit completo
  pos.partialTaken = true;
  assert.equal(wantsPartial(pos, 27), false); // solo una vez
  assert.equal(exitReason(pos, 15), null);
  assert.match(exitReason(pos, 2), /seguridad/);
});

test('solo sale si la wallet vende al menos la mitad', () => {
  const W = 'Src11111111111111111111111111111111111111111';
  state.positions = [{ id: 'p', mint: 'M', symbol: 'T', sources: [{ wallet: W, tokens: 1000, soldTokens: 0 }] }];
  onWalletSell({ wallet: W, mint: 'M', tokens: 200 });
  assert.equal(state.positions[0].forceExit, undefined); // 20%: se mantiene
  onWalletSell({ wallet: W, mint: 'M', tokens: 350 });
  assert.match(state.positions[0].forceExit, /vendió 55%/);
  state.positions = [];
});

test('veta wallets con 3+ copias en pérdidas', () => {
  const W = 'Bad11111111111111111111111111111111111111111';
  const t = (pnl) => ({ sources: [{ wallet: W }], pnlUsd: pnl });
  state.closed = [t(-1), t(-2)];
  assert.equal(isVetoed(W), false); // solo 2
  state.closed.push(t(-0.5));
  assert.equal(isVetoed(W), true);
  state.closed.push(t(5)); // ahora gana en total
  assert.equal(isVetoed(W), false);
  state.closed = [];
});

test('filtro de impulso y modo estricto', async () => {
  const real = globalThis.fetch;
  const MINT = 'So11111111111111111111111111111111111111112';
  let pair = { liquidity: { usd: 40000 }, baseToken: { address: MINT, symbol: 'T' }, dexId: 'pumpswap', priceChange: { h1: -5 }, txns: { m5: { buys: 10, sells: 5 } } };
  globalThis.fetch = async () => new Response(JSON.stringify([pair]));
  connection.getParsedAccountInfo = async () => ({ value: { data: { parsed: { info: { decimals: 6, supply: '1000', mintAuthority: null, freezeAuthority: null } } } } });
  try {
    assert.equal((await runFilter(MINT)).reason, 'momentum'); // baja en 1h
    pair.priceChange.h1 = 12; pair.txns.m5 = { buys: 3, sells: 9 };
    assert.equal((await runFilter(MINT)).reason, 'momentum'); // más ventas que compras
    pair.txns.m5 = { buys: 9, sells: 3 };
    cfg.quality = 'strict';
    assert.equal((await runFilter(MINT)).reason, 'liquidity'); // $40k < $50k en modo estricto
  } finally {
    globalThis.fetch = real;
    cfg.quality = 'normal';
  }
});

test('con "vender cuando la wallet vende = No", Guard ignora las ventas de la wallet', () => {
  const W = 'Src22222222222222222222222222222222222222222';
  state.positions = [{ id: 'p', mint: 'M', symbol: 'T', sources: [{ wallet: W, tokens: 1000, soldTokens: 0 }] }];
  cfg.followWalletSells = false;
  try {
    onWalletSell({ wallet: W, mint: 'M', tokens: 1000 });
    assert.equal(state.positions[0].forceExit, undefined);
  } finally {
    cfg.followWalletSells = true;
    state.positions = [];
  }
});
