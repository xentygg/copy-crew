import { test } from 'node:test';
import assert from 'node:assert/strict';
import { cfg } from '../src/config.js';
import { toCandles } from '../src/binance/market.js';
import { bn, backtest, proven, checkExit, scanOnce } from '../src/binance/strategy.js';

const M15 = 15 * 60_000;
// Filas de Binance: [openTime, open, high, low, close, volume, closeTime]
function rows(list, now = Date.now()) {
  let t = now - M15 * (list.length + 1);
  const out = list.map(([o, h, l, c, v]) => { t += M15; return [t, String(o), String(h), String(l), String(c), String(v), t + M15 - 1]; });
  out.push([t + M15, '1', '1', '1', '1', '1', t + 2 * M15 - 1]); // vela en formación
  return out;
}
const flat = (n, p = 100) => Array.from({ length: n }, () => [p, p * 1.002, p * 0.998, p, 100]);
const breakout = [100, 101.5, 99.9, 101.4, 600]; // ruptura con volumen

test('velas de Binance: orden, sin duplicados y sin la vela en formación', () => {
  const now = Date.now();
  const r = rows(flat(30), now);
  const c = toCandles([...r, r[3]], now);
  assert.equal(c.c.length, 30);
  assert.ok(c.t.every((t, i) => i === 0 || t > c.t[i - 1]));
});

test('comprueba patrones con el historial y solo marca como operables los que superan el mínimo', () => {
  const now = Date.now();
  // 40 rupturas: 30 alcanzan +2 % antes de −1 %, 10 tocan el stop
  const list = [];
  for (let k = 0; k < 40; k++) {
    list.push(...flat(20), breakout);
    const win = k % 4 !== 0;
    list.push(win ? [101.4, 103.6, 101.2, 103.4, 100] : [101.4, 101.5, 100.1, 100.2, 100]);
    list.push(...flat(16, win ? 103.4 : 100.2));
  }
  const c = toCandles(rows(list, now), now);
  const stats = backtest('TESTUSDT', c);
  assert.ok(stats.ruptura.n >= 35, `casos ${stats.ruptura.n}`);
  assert.ok(proven('TESTUSDT', 'ruptura'));
  cfg.patternMinWinRate = 90;
  assert.equal(proven('TESTUSDT', 'ruptura'), false);
  cfg.patternMinWinRate = 60;
});

test('salidas: objetivo, stop (lo peor si ambos en la misma vela) y tiempo máximo', () => {
  const now = Date.now();
  const pos = { entryCandleEnd: now - 5 * M15, openedAt: now - 5 * M15, tpPrice: 102, slPrice: 99, tpPct: 2, slPct: 1, horizon: 16 };
  const mk = (h, l) => toCandles(rows([...flat(5), [100, h, l, 100, 1], ...flat(2)], now), now);
  assert.match(checkExit(pos, mk(102.5, 99.5), now).reason, /objetivo/);
  assert.match(checkExit(pos, mk(102.5, 98.5), now).reason, /stop/);
  assert.equal(checkExit(pos, mk(101, 99.5), now), null);
  assert.match(checkExit({ ...pos, openedAt: now - 17 * M15 }, mk(101, 99.5), now).reason, /tiempo/);
});

test('operativa simulada: compra con un patrón comprobado y cierra en el objetivo', async () => {
  const real = globalThis.fetch;
  cfg.binanceSymbols = ['TESTUSDT'];
  bn.positions = [];
  bn.closed = [];
  bn.cashUsd = 100;
  bn.stats.TESTUSDT = { ruptura: { n: 40, wins: 30, sumRet: 40 } };
  let phase = 'entry';
  globalThis.fetch = async () => {
    const now = Date.now();
    const list = phase === 'entry' ? [...flat(30), breakout] : [...flat(30), breakout, [101.4, 104, 101.3, 103.8, 100]];
    return new Response(JSON.stringify(rows(list, now)));
  };
  try {
    await scanOnce();
    assert.equal(bn.positions.length, 1);
    assert.equal(bn.cashUsd, 80);
    // la vela siguiente a la entrada alcanza +2 %
    bn.positions[0].entryCandleEnd -= M15;
    phase = 'exit';
    await scanOnce();
    assert.equal(bn.positions.length, 0);
    assert.equal(bn.closed.length, 1);
    const t = bn.closed[0];
    assert.match(t.exitReason, /objetivo/);
    assert.ok(t.pnlUsd > 0.3 && t.pnlUsd < 0.4, `ganancia ${t.pnlUsd}`); // ~+2 % de $20 menos comisiones
  } finally {
    globalThis.fetch = real;
  }
});
