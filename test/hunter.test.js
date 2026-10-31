import { test } from 'node:test';
import assert from 'node:assert/strict';
import { hunt, ingestTrade, walletStats, qualifies, candidates, scanOnce, pickNew } from '../src/agents/hunter.js';

const SOL = 'So11111111111111111111111111111111111111112';
const W = 'Hunt1111111111111111111111111111111111111111';
const BOT = 'Bot11111111111111111111111111111111111111111';
const trade = (mint, kind, usd, tok, at) => ({
  attributes: {
    tx_from_address: W, kind, volume_in_usd: String(usd), block_timestamp: new Date(at).toISOString(),
    ...(kind === 'buy' ? { from_token_address: SOL, to_token_address: mint, to_token_amount: String(tok) } : { from_token_address: mint, to_token_address: SOL, from_token_amount: String(tok) }),
  },
});

test('calcula ganancia, acierto y descarta bots de alta frecuencia', () => {
  for (const k of Object.keys(hunt.wallets)) delete hunt.wallets[k];
  const t0 = Date.now() - 3600_000;
  // 3 tokens: +200, +100, -50  => +250, 67% acierto
  ingestTrade({ mint: 'M1' }, trade('M1', 'buy', 100, 1000, t0));
  ingestTrade({ mint: 'M1' }, trade('M1', 'sell', 300, 1000, t0 + 600_000));
  ingestTrade({ mint: 'M2' }, trade('M2', 'buy', 200, 500, t0));
  ingestTrade({ mint: 'M2' }, trade('M2', 'sell', 150, 250, t0 + 900_000)); // vendió la mitad: coste 100 → +50
  ingestTrade({ mint: 'M2' }, trade('M2', 'sell', 150, 250, t0 + 950_000)); // otra mitad: total +100
  ingestTrade({ mint: 'M3' }, trade('M3', 'buy', 100, 100, t0));
  ingestTrade({ mint: 'M3' }, trade('M3', 'sell', 50, 100, t0 + 300_000));
  const s = walletStats(hunt.wallets[W]);
  assert.equal(s.closed, 3); assert.equal(s.wins, 2); assert.equal(Math.round(s.pnl), 250);
  assert.equal(qualifies(s), false); // < $300
  ingestTrade({ mint: 'M4' }, trade('M4', 'buy', 100, 10, t0));
  ingestTrade({ mint: 'M4' }, trade('M4', 'sell', 200, 10, t0 + 120_000));
  assert.equal(qualifies(walletStats(hunt.wallets[W])), true);
  assert.deepEqual(candidates(new Set([W])), []); // ya vigilada → no es candidata
  assert.equal(candidates()[0].wallet, W);

  // Bot que compra y vende en segundos: no califica aunque gane
  for (let i = 0; i < 4; i++) {
    const m = 'F' + i;
    ingestTrade({ mint: m }, { attributes: { ...trade(m, 'buy', 100, 10, t0).attributes, tx_from_address: BOT } });
    ingestTrade({ mint: m }, { attributes: { ...trade(m, 'sell', 400, 10, t0 + 5000).attributes, tx_from_address: BOT } });
  }
  assert.equal(qualifies(walletStats(hunt.wallets[BOT])), false);
});

test('escaneo con respuestas de GeckoTerminal', async () => {
  for (const k of Object.keys(hunt.wallets)) delete hunt.wallets[k];
  hunt.poolCursor = {};
  const now = Date.now();
  const pool = (addr, mint, reserve) => ({ attributes: { address: addr, name: mint + ' / SOL', reserve_in_usd: String(reserve), price_change_percentage: { h24: '150' } }, relationships: { base_token: { data: { id: 'solana_' + mint } }, quote_token: { data: { id: 'solana_' + SOL } } } });
  const calls = [];
  const get = async (u) => {
    calls.push(u);
    if (u.includes('/trades')) {
      const mint = u.includes('PA') ? 'MA' : 'MB';
      return { data: [trade(mint, 'buy', 500, 100, now - 600_000), trade(mint, 'sell', 900, 100, now - 60_000)] };
    }
    return { data: [pool('PA', 'MA', 90000), pool('PB', 'MB', 50000), pool('PC', 'MC', 1000), pool('PD', SOL, 90000)] };
  };
  const logs = [];
  const realSetTimeout = globalThis.setTimeout;
  globalThis.setTimeout = (fn) => realSetTimeout(fn, 0); // sin esperas en el test
  try {
    await scanOnce({ log: (a, m) => logs.push(m), get });
    await scanOnce({ log: (a, m) => logs.push(m), get }); // segunda vez: no duplica operaciones
  } finally {
    globalThis.setTimeout = realSetTimeout;
  }
  assert.equal(calls.filter((u) => u.includes('/trades')).length, 4); // solo PA y PB (PC sin liquidez, PD no es memecoin), 2 escaneos
  const s = walletStats(hunt.wallets[W]);
  assert.equal(s.closed, 2); assert.equal(Math.round(s.pnl), 800);
  assert.match(logs[1], /0 operaciones nuevas/);
  assert.equal(pickNew(new Set()).length, 0); // solo 2 tokens: aún no califica (mínimo 3)
});
