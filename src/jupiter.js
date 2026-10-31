import { VersionedTransaction } from '@solana/web3.js';
import { cfg, SOL_MINT } from './config.js';
import { fetchJson, sleep } from './http.js';

const headers = cfg.jupiterApiKey ? { 'x-api-key': cfg.jupiterApiKey } : {};

// La API gratuita de Jupiter rechaza (HTTP 429) si se le pregunta demasiado.
// Todas las peticiones pasan por aquí: como mucho una cada JUPITER_INTERVAL_MS, y pausa general al recibir un 429.
const INTERVAL_MS = Number(process.env.JUPITER_INTERVAL_MS || 1100);
let nextSlot = 0;
let pausedUntil = 0;
export const jupStats = { calls: 0, rateLimited: 0, lastRateLimitAt: null };

async function jupFetch(url, opts = {}) {
  for (let attempt = 0; ; attempt++) {
    const now = Date.now();
    const slot = Math.max(now, nextSlot, pausedUntil);
    nextSlot = slot + INTERVAL_MS;
    if (slot > now) await sleep(slot - now);
    jupStats.calls++;
    try {
      return await fetchJson(url, { ...opts, headers, retries: 0 });
    } catch (e) {
      const transient = !e.noRetry; // 429, 5xx, timeouts y cortes de red
      if (/HTTP 429/.test(e.message)) {
        jupStats.rateLimited++;
        jupStats.lastRateLimitAt = Date.now();
        pausedUntil = Date.now() + 5000;
      }
      if (transient && attempt < 2) continue;
      e.transient = transient;
      throw e;
    }
  }
}

export async function quote(inputMint, outputMint, amountRaw, slippageBps = cfg.slippageBps) {
  const q = new URLSearchParams({
    inputMint,
    outputMint,
    amount: amountRaw.toString(),
    slippageBps: String(slippageBps),
    restrictIntermediateTokens: 'true',
  });
  const res = await jupFetch(`${cfg.jupiterUrl}/swap/v1/quote?${q}`, { timeoutMs: 8000 });
  if (!res?.outAmount) throw new Error(`sin ruta: ${JSON.stringify(res).slice(0, 150)}`);
  return res;
}

export async function buildSwap(quoteResponse, userPublicKey) {
  const res = await jupFetch(`${cfg.jupiterUrl}/swap/v1/swap`, {
    method: 'POST',
    body: {
      quoteResponse,
      userPublicKey: userPublicKey.toBase58(),
      wrapAndUnwrapSol: true,
      dynamicComputeUnitLimit: true,
      prioritizationFeeLamports: {
        priorityLevelWithMaxLamports: { maxLamports: cfg.priorityMaxLamports, priorityLevel: 'veryHigh' },
      },
    },
    timeoutMs: 10_000,
  });
  if (!res?.swapTransaction) throw new Error(`Jupiter no devolvió transacción: ${JSON.stringify(res).slice(0, 150)}`);
  return VersionedTransaction.deserialize(Buffer.from(res.swapTransaction, 'base64'));
}

let solPrice = { usd: 0, at: 0 };
export async function solPriceUsd() {
  if (Date.now() - solPrice.at < 60_000 && solPrice.usd) return solPrice.usd;
  try {
    const res = await jupFetch(`${cfg.jupiterUrl}/price/v3?ids=${SOL_MINT}`);
    const p = Number(res?.[SOL_MINT]?.usdPrice);
    if (p > 0) solPrice = { usd: p, at: Date.now() };
  } catch {
    // Alternativa: cotizar 1 SOL a USDC.
    try {
      const q = await quote(SOL_MINT, 'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v', 1_000_000_000n, 50);
      solPrice = { usd: Number(q.outAmount) / 1e6, at: Date.now() };
    } catch {}
  }
  if (!solPrice.usd) throw new Error('no se pudo obtener el precio de SOL');
  return solPrice.usd;
}
