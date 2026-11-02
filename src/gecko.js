// GeckoTerminal (gratis) limita las peticiones por minuto. Hunter y Chartist comparten este regulador.
// Si responde 429 (demasiadas peticiones), espera un minuto y va más despacio; luego recupera el ritmo poco a poco.
import { fetchJson, sleep } from './http.js';

export const GT = 'https://api.geckoterminal.com/api/v2';
const HEADERS = { accept: 'application/json;version=20230302' };
const MIN_INTERVAL_MS = 3000;
const MAX_INTERVAL_MS = 12_000;
let interval = 6000;
let nextSlot = 0;
export const geckoStats = { calls: 0, rateLimited: 0 };

export async function geckoGet(url) {
  for (let attempt = 0; ; attempt++) {
    const now = Date.now();
    const slot = Math.max(now, nextSlot);
    nextSlot = slot + interval;
    if (slot > now) await sleep(slot - now);
    geckoStats.calls++;
    try {
      const res = await fetchJson(url, { headers: HEADERS, timeoutMs: 15_000, retries: 0 });
      interval = Math.max(MIN_INTERVAL_MS, interval - 100);
      return res;
    } catch (e) {
      if (!/HTTP 429/.test(e.message) || attempt >= 2) throw e;
      geckoStats.rateLimited++;
      interval = Math.min(MAX_INTERVAL_MS, interval * 1.5);
      nextSlot = Date.now() + 60_000;
    }
  }
}
