// GeckoTerminal (gratis) permite ~30 peticiones por minuto. Hunter y Chartist comparten este regulador.
import { fetchJson, sleep } from './http.js';

export const GT = 'https://api.geckoterminal.com/api/v2';
const HEADERS = { accept: 'application/json;version=20230302' };
const INTERVAL_MS = 2300;
let nextSlot = 0;

export async function geckoGet(url) {
  const now = Date.now();
  const slot = Math.max(now, nextSlot);
  nextSlot = slot + INTERVAL_MS;
  if (slot > now) await sleep(slot - now);
  return fetchJson(url, { headers: HEADERS, timeoutMs: 15_000, retries: 1 });
}
