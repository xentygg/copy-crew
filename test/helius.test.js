import { test } from 'node:test';
import assert from 'node:assert/strict';
import { cfg } from '../src/config.js';
import { ensureWebhook } from '../src/helius.js';

test('al mudarse de servidor reutiliza el webhook anterior en vez de crear otro', async () => {
  const real = globalThis.fetch;
  const calls = [];
  cfg.publicUrl = 'http://5.6.7.8:3000';
  globalThis.fetch = async (url, opt = {}) => {
    calls.push([opt.method || 'GET', String(url).split('?')[0], opt.body && JSON.parse(opt.body).webhookURL]);
    if (!opt.method || opt.method === 'GET') return new Response(JSON.stringify([{ webhookID: 'old', webhookURL: 'http://1.2.3.4:3000/webhook' }]));
    return new Response('{}');
  };
  try {
    assert.equal(await ensureWebhook(['W']), 'old');
    assert.deepEqual(calls[1], ['PUT', 'https://api.helius.xyz/v0/webhooks/old', 'http://5.6.7.8:3000/webhook']);
  } finally {
    globalThis.fetch = real;
  }
});
