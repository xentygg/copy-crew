// Datos públicos de Binance (no necesitan API key). data-api.binance.vision es el espejo oficial
// solo de datos de mercado, accesible desde cualquier país.
import { fetchJson, sleep } from '../http.js';
import { withIndicators } from '../agents/chartist.js';

const API = process.env.BINANCE_DATA_URL || 'https://data-api.binance.vision';

export async function klines(symbol, interval, { limit = 1000, endTime } = {}) {
  const q = new URLSearchParams({ symbol, interval, limit: String(limit) });
  if (endTime) q.set('endTime', String(endTime));
  return fetchJson(`${API}/api/v3/klines?${q}`, { timeoutMs: 15_000, retries: 2 });
}

// Binance: [openTime, open, high, low, close, volume, closeTime, ...] del más antiguo al más reciente.
export function toCandles(rows, now = Date.now()) {
  const c = { t: [], o: [], h: [], l: [], c: [], v: [] };
  const seen = new Set();
  for (const r of [...rows].sort((a, b) => a[0] - b[0])) {
    if (seen.has(r[0]) || Number(r[6]) >= now) continue; // sin duplicados ni la vela que aún se forma
    seen.add(r[0]);
    c.t.push(Number(r[0]));
    c.o.push(Number(r[1]));
    c.h.push(Number(r[2]));
    c.l.push(Number(r[3]));
    c.c.push(Number(r[4]));
    c.v.push(Number(r[5]));
  }
  return withIndicators(c);
}

// Historial largo (varias páginas de 1000 velas) para comprobar los patrones.
export async function history(symbol, interval, pages = 4) {
  let rows = [];
  let endTime;
  for (let p = 0; p < pages; p++) {
    const page = await klines(symbol, interval, { limit: 1000, endTime });
    if (!page?.length) break;
    rows = page.concat(rows);
    endTime = Number(page[0][0]) - 1;
    await sleep(300);
  }
  return toCandles(rows);
}

export async function recent(symbol, interval, limit = 120) {
  return toCandles(await klines(symbol, interval, { limit }));
}
