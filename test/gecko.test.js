import { test } from 'node:test';
import assert from 'node:assert/strict';
import { geckoGet, geckoStats } from '../src/gecko.js';

test('GeckoTerminal: ante un 429 espera y reintenta en vez de fallar', async () => {
  const real = globalThis.fetch;
  const realTimeout = globalThis.setTimeout;
  globalThis.setTimeout = (fn) => realTimeout(fn, 0); // sin esperas reales en el test
  let n = 0;
  globalThis.fetch = async () => (n++ === 0 ? new Response('slow', { status: 429 }) : new Response('{"ok":1}'));
  try {
    assert.deepEqual(await geckoGet('https://x/y'), { ok: 1 });
    assert.equal(geckoStats.rateLimited, 1);
    assert.equal(n, 2);
  } finally {
    globalThis.fetch = real;
    globalThis.setTimeout = realTimeout;
  }
});
