import { test } from 'node:test';
import assert from 'node:assert/strict';
import { cfg } from '../src/config.js';
import { book, toCandles, detect, outcome, learn, liveSignals, patternStatus } from '../src/agents/chartist.js';

const MIN5 = 300;
// Construye velas: lateral 30 velas y luego una vela de ruptura con mucho volumen.
function series(now, { breakout = true, after = [] } = {}) {
  const rows = [];
  let t = Math.floor(now / 1000) - MIN5 * (32 + after.length);
  for (let i = 0; i < 30; i++) rows.push([t += MIN5, 1, 1.02, 0.98, 1 + (i % 2) * 0.01, 100]);
  if (breakout) rows.push([t += MIN5, 1.01, 1.12, 1.0, 1.1, 600]);
  for (const [h, l, c] of after) rows.push([t += MIN5, 1.1, h, l, c, 100]);
  rows.push([t += MIN5, 1, 1, 1, 1, 1]); // vela que aún se forma: debe ignorarse
  return rows.reverse(); // GeckoTerminal: más reciente primero
}

test('detecta una ruptura con volumen y descarta la vela en formación', () => {
  const now = Date.now();
  const c = toCandles(series(now), now);
  assert.equal(c.c.length, 31);
  assert.ok(detect(c, 30).includes('ruptura'));
  assert.ok(!detect(c, 29).includes('ruptura'));
});

test('resultado: gana si toca +TP antes que −SL', () => {
  const now = Date.now();
  const win = toCandles(series(now, { after: [[1.15, 1.08, 1.14], [1.3, 1.12, 1.28]] }), now);
  assert.equal(outcome(win, 30, { tpPct: 15, slPct: 8, horizon: 12 }).win, true);
  const loss = toCandles(series(now, { after: [[1.11, 0.99, 1.0]] }), now);
  assert.equal(outcome(loss, 30, { tpPct: 15, slPct: 8, horizon: 12 }).win, false);
});

test('aprende sin duplicar y solo opera patrones probados', () => {
  book.stats = {};
  book.cursor = {};
  const now = Date.now();
  const after = Array.from({ length: 13 }, (_, k) => [1.3 + k * 0.01, 1.1, 1.28]);
  const c = toCandles(series(now, { after }), now);
  const n1 = learn('POOL', c);
  assert.ok(n1 >= 1);
  assert.equal(learn('POOL', c), 0); // ya visto
  assert.equal(patternStatus('ruptura').status, 'aprendiendo');
  book.stats.ruptura = { n: 40, wins: 30, sumRet: 400 };
  assert.equal(patternStatus('ruptura').status, 'activo');
  book.stats.ruptura = { n: 40, wins: 10, sumRet: -100 };
  assert.equal(patternStatus('ruptura').status, 'descartado');

  // señal en vivo: solo en la última vela cerrada y solo si el patrón está activo
  book.stats.ruptura = { n: 40, wins: 30, sumRet: 400 };
  const live = toCandles(series(now), now);
  assert.deepEqual(liveSignals(live, now).includes('ruptura'), true);
  book.stats.ruptura = { n: 5, wins: 5, sumRet: 50 };
  assert.deepEqual(liveSignals(live, now).includes('ruptura'), false);
  cfg.patternMinWinRate = 70;
  book.stats.ruptura = { n: 40, wins: 26, sumRet: 100 }; // 65%
  assert.equal(patternStatus('ruptura').status, 'descartado');
  cfg.patternMinWinRate = 60;
  book.stats = {};
});
