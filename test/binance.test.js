import { test } from 'node:test';
import assert from 'node:assert/strict';
import { cfg } from '../src/config.js';
import { toCandles } from '../src/binance/market.js';
import { bn, prep, signals, walk, backtest, isProven, rotationBacktest, STRATS, scanOnce } from '../src/binance/strategy.js';

const M15 = 15 * 60_000;
const H = 3600_000;
// Filas de Binance: [openTime, open, high, low, close, volume, closeTime]; la última es la vela en formación.
function rows(list, ms = M15, now = Date.now()) {
  let t = Math.floor(now / ms) * ms - ms * (list.length + 1);
  const out = list.map(([o, h, l, c, v = 100]) => { t += ms; return [t, String(o), String(h), String(l), String(c), String(v), t + ms - 1]; });
  out.push([t + ms, '1', '1', '1', '1', '1', t + 2 * ms - 1]);
  return out;
}
const candles = (list, ms = M15, now = Date.now()) => prep(toCandles(rows(list, ms, now), now));
const flat = (n, p = 100) => Array.from({ length: n }, () => [p, p * 1.002, p * 0.998, p]);
const rising = (n, from = 100, step = 0.1) => Array.from({ length: n }, (_, k) => { const p = from + k * step; return [p, p + 0.3, p - 0.3, p + 0.05]; });

test('velas de Binance: orden, sin duplicados y sin la vela en formación', () => {
  const now = Date.now();
  const r = rows(flat(30), M15, now);
  const c = toCandles([...r, r[3]], now);
  assert.equal(c.c.length, 30);
  assert.ok(c.t.every((t, i) => i === 0 || t > c.t[i - 1]));
});

test('señales: caída brusca en tendencia alcista y ruptura de canal', () => {
  const up = rising(220);
  const top = up[up.length - 1][3];
  const dip = candles([...up, [top, top, top - 3, top - 2.8], [top - 2.8, top - 2.7, top - 4, top - 3.9]], H);
  assert.deepEqual(signals('caidas', dip, dip.c.length - 1), ['caidas']);
  const brk = candles([...up, [top, top + 3, top, top + 2.9]], H);
  assert.deepEqual(signals('ruptura', brk, brk.c.length - 1), ['ruptura']);
  const down = candles(Array.from({ length: 230 }, (_, k) => { const p = 200 - k * 0.2; return [p, p + 0.1, p - 0.4, p - 0.3]; }), H);
  assert.deepEqual(signals('caidas', down, down.c.length - 1), []); // sin tendencia alcista no compra caídas
});

test('salidas: objetivo, stop con hueco, rebote a la media, stop dinámico y tiempo', () => {
  const now = Date.now();
  const mk = (after, ms = M15) => candles([...flat(10), ...after], ms, now);
  const entry = (c) => ({ entryPrice: 100, entryT: c.t[9] });
  let c = mk([[100, 102.5, 99.5, 102]]);
  assert.match(walk(c, entry(c), STRATS.patrones.exit, M15).reason, /objetivo/);
  c = mk([[97, 97.5, 96, 96.5]]); // abre por debajo del stop (−1 %): vende a 97, no a 99
  const ex = walk(c, entry(c), STRATS.patrones.exit, M15);
  assert.match(ex.reason, /stop/);
  assert.equal(ex.price, 97);
  c = mk([[99, 99.2, 98.5, 98.8], [98.8, 101, 98.7, 100.9]], H);
  assert.match(walk(c, entry(c), STRATS.caidas.exit, H).reason, /rebote/);
  c = mk([...rising(15, 101, 1), [115, 115.2, 103, 104]], H); // sube y luego cae bajo el mínimo de 10 h
  assert.equal(walk(c, entry(c), STRATS.ruptura.exit, H).reason, 'stop dinámico');
  c = mk(flat(17));
  assert.match(walk(c, entry(c), STRATS.patrones.exit, M15).reason, /tiempo/);
});

test('ruptura se valida por rentabilidad (acierta poco pero gana más), caídas por acierto', () => {
  bn.stats.ruptura = { XUSDT: { ruptura: { n: 30, wins: 10, sumRet: 60, grossWin: 120, grossLoss: 60 } } };
  assert.ok(isProven('ruptura', 'XUSDT', 'ruptura')); // 33 % de acierto pero gana el doble de lo que pierde
  bn.stats.caidas = { XUSDT: { caidas: { n: 30, wins: 10, sumRet: 60, grossWin: 120, grossLoss: 60 } } };
  assert.equal(isProven('caidas', 'XUSDT', 'caidas'), false); // a esta se le exige acierto
  bn.stats.caidas.XUSDT.caidas = { n: 30, wins: 21, sumRet: 15, grossWin: 40, grossLoss: 25 };
  assert.ok(isProven('caidas', 'XUSDT', 'caidas'));
  bn.stats.caidas.XUSDT.caidas.n = 10;
  assert.equal(isProven('caidas', 'XUSDT', 'caidas'), false); // pocos casos
});

test('backtest de caídas con historial sintético', () => {
  const list = [...rising(220)];
  for (let k = 0; k < 25; k++) {
    const p = list[list.length - 1][3];
    list.push([p, p, p - 3, p - 2.8], [p - 2.8, p - 2.7, p - 4, p - 3.9], [p - 3.9, p + 1, p - 4, p + 0.8], ...rising(20, p + 1, 0.1));
  }
  const st = backtest('caidas', 'YUSDT', candles(list, H)).caidas;
  assert.ok(st.n >= 20, `casos ${st.n}`);
  assert.ok(st.wins / st.n > 0.8);
});

test('rotación: elige la que más sube en 7 días y se compara con guardar BTC', () => {
  const now = Date.UTC(2026, 0, 30);
  const n = 24 * 25;
  const mk = (drift) => toCandles(rows(Array.from({ length: n }, (_, k) => { const p = 100 * (1 + drift) ** k; return [p, p, p, p]; }), H, now), now);
  const r = rotationBacktest({ BTCUSDT: mk(0.0001), SOLUSDT: mk(0.0005) });
  assert.ok(r.periods >= 15);
  assert.ok(r.totalRetPct > r.btcHoldPct); // tener SOL (la más fuerte) gana a guardar BTC
});

test('operativa simulada: compra con un patrón comprobado y cierra en el objetivo', async () => {
  const real = globalThis.fetch;
  cfg.binanceSymbols = ['TESTUSDT'];
  Object.assign(bn, { positions: [], closed: [], cashUsd: 100, stats: { patrones: { TESTUSDT: { ruptura: { n: 40, wins: 30, sumRet: 40, grossWin: 60, grossLoss: 20 } } } } });
  const breakout = [100, 101.5, 99.9, 101.4, 600];
  let after = [];
  globalThis.fetch = async (url) => {
    const ms = String(url).includes('interval=1h') ? H : M15;
    return new Response(JSON.stringify(rows(ms === M15 ? [...flat(30), breakout, ...after] : flat(30), ms)));
  };
  try {
    await scanOnce();
    assert.equal(bn.positions.length, 1);
    assert.equal(bn.positions[0].strategy, 'patrones');
    assert.equal(bn.cashUsd, 80);
    after = [[101.4, 104, 101.3, 103.8]]; // la vela siguiente alcanza +2 %
    bn.positions[0].entryT -= M15;
    await scanOnce();
    assert.equal(bn.positions.length, 0);
    const t = bn.closed[0];
    assert.match(t.exitReason, /objetivo/);
    assert.ok(t.pnlUsd > 0.3 && t.pnlUsd < 0.4, `ganancia ${t.pnlUsd}`);
  } finally {
    globalThis.fetch = real;
  }
});

test('rotación en vivo: abre la moneda más fuerte y cambia cuando otra la supera', async () => {
  const real = globalThis.fetch;
  cfg.binanceSymbols = ['BTCUSDT', 'SOLUSDT'];
  Object.assign(bn, { positions: [], closed: [], cashUsd: 100, stats: {}, rotation: { backtest: { periods: 30, wins: 20, totalRetPct: 15, btcHoldPct: 5, days: 30 }, lastDay: null } });
  let leader = 'SOLUSDT';
  globalThis.fetch = async (url) => {
    const u = String(url);
    const ms = u.includes('interval=1h') ? H : M15;
    const drift = u.includes(leader) ? 0.001 : 0.0002;
    return new Response(JSON.stringify(rows(Array.from({ length: 300 }, (_, k) => { const p = 100 * (1 + drift) ** k; return [p, p, p, p]; }), ms)));
  };
  try {
    await scanOnce();
    const pos = bn.positions.find((p) => p.strategy === 'rotacion');
    assert.equal(pos?.symbol, 'SOLUSDT');
    leader = 'BTCUSDT';
    bn.rotation.lastDay = null; // nuevo día
    await scanOnce();
    const now = bn.positions.filter((p) => p.strategy === 'rotacion');
    assert.equal(now.length, 1);
    assert.equal(now[0].symbol, 'BTCUSDT');
    assert.match(bn.closed[0].exitReason, /rotación a BTC/);
  } finally {
    globalThis.fetch = real;
  }
});
