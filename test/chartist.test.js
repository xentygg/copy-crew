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

test('modo comprobados: aprende sin duplicar y solo opera patrones probados', () => {
  cfg.patternRequireProof = true;
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
  cfg.patternRequireProof = false;
});

test('modo clásico: opera el patrón aunque no tenga historial', () => {
  book.stats = {};
  const now = Date.now();
  const live = toCandles(series(now), now);
  assert.ok(liveSignals(live, now).includes('ruptura'));
  assert.equal(patternStatus('ruptura').status, 'clasico');
});

// Velas a medida: [open, high, low, close, volume]
function custom(rows, now = Date.now()) {
  let t = Math.floor(now / 1000) - 300 * (rows.length + 1);
  const list = rows.map(([o, h, l, c, v]) => [(t += 300), o, h, l, c, v]);
  list.push([(t += 300), 1, 1, 1, 1, 1]);
  return toCandles(list.reverse(), now);
}
const flat = (n, p = 1) => Array.from({ length: n }, () => [p, p * 1.01, p * 0.99, p, 100]);

test('bandera alcista', () => {
  const rows = [
    ...flat(16),
    [1, 1.06, 1, 1.05, 300], [1.05, 1.11, 1.04, 1.1, 300], [1.1, 1.16, 1.09, 1.15, 300], [1.15, 1.21, 1.14, 1.2, 300], [1.2, 1.26, 1.19, 1.25, 300], // mástil +25 %
    [1.25, 1.26, 1.2, 1.22, 80], [1.22, 1.24, 1.19, 1.21, 70], [1.21, 1.23, 1.18, 1.2, 60], // bandera con poco volumen
    [1.2, 1.3, 1.2, 1.29, 200], // ruptura
  ];
  const c = custom(rows);
  assert.ok(detect(c, c.c.length - 1).includes('bandera'));
});

test('doble suelo', () => {
  const rows = [
    ...flat(6),
    [1, 1, 0.9, 0.91, 100], [0.91, 0.93, 0.9, 0.92, 100], // primer suelo ~0.90
    [0.92, 1.0, 0.92, 0.99, 100], [0.99, 1.0, 0.95, 0.96, 100], [0.96, 0.97, 0.94, 0.95, 100], // rebote (cuello 1.00)
    [0.95, 0.96, 0.905, 0.91, 100], [0.91, 0.94, 0.905, 0.93, 100], // segundo suelo ~0.905
    [0.93, 0.97, 0.92, 0.96, 100], [0.96, 0.99, 0.95, 0.98, 100], [0.98, 0.995, 0.96, 0.97, 100],
    [0.97, 0.99, 0.96, 0.98, 100], [0.98, 0.99, 0.97, 0.985, 100], [0.985, 0.99, 0.97, 0.98, 100], [0.98, 0.99, 0.97, 0.98, 100],
    [0.98, 1.05, 0.98, 1.04, 150], // rompe el cuello
  ];
  const c = custom(rows);
  assert.ok(detect(c, c.c.length - 1).includes('doble_suelo'));
});

test('cruce de medias', () => {
  const down = Array.from({ length: 25 }, (_, k) => { const p = 1.3 - k * 0.012; return [p, p * 1.005, p * 0.99, p * 0.995, 100]; });
  const up = Array.from({ length: 12 }, (_, k) => { const p = 1.0 + k * 0.012; return [p, p * 1.015, p * 0.998, p * 1.01, 100]; });
  const c = custom([...down, ...up]);
  const crosses = c.c.map((_, i) => (i >= 20 ? detect(c, i).includes('cruce_ema') : false));
  assert.equal(crosses.filter(Boolean).length, 1); // cruza una sola vez
});
