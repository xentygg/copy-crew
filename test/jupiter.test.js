import { test } from 'node:test';
import assert from 'node:assert/strict';

process.env.JUPITER_INTERVAL_MS = '50';
const { quote, jupStats } = await import('../src/jupiter.js');
const SOL = 'So11111111111111111111111111111111111111112';

test('espacia las peticiones, reintenta un 429 y distingue "sin ruta" de "saturado"', async () => {
  const real = globalThis.fetch;
  const times = [];
  let mode = 'ok';
  let n429 = 0;
  globalThis.fetch = async () => {
    times.push(Date.now());
    if (mode === '429-once' && n429++ === 0) return new Response('slow down', { status: 429 });
    if (mode === '429-always') return new Response('slow down', { status: 429 });
    if (mode === 'noroute') return new Response('{"error":"COULD_NOT_FIND_ANY_ROUTE"}', { status: 400 });
    return new Response('{"outAmount":"123","inAmount":"1"}', { status: 200 });
  };
  try {
    await Promise.all([quote(SOL, 'X', 1n), quote(SOL, 'X', 1n), quote(SOL, 'X', 1n)]);
    for (let i = 1; i < times.length; i++) assert.ok(times[i] - times[i - 1] >= 45, 'peticiones separadas');

    mode = '429-once';
    const q = await quote(SOL, 'X', 1n);
    assert.equal(q.outAmount, '123');
    assert.equal(jupStats.rateLimited, 1);

    mode = 'noroute';
    await assert.rejects(quote(SOL, 'X', 1n), (e) => e.transient === false);
  } finally {
    globalThis.fetch = real;
  }
});
