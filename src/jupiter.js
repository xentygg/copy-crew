import { VersionedTransaction } from '@solana/web3.js';
import { cfg, SOL_MINT } from './config.js';
import { fetchJson } from './http.js';

const headers = cfg.jupiterApiKey ? { 'x-api-key': cfg.jupiterApiKey } : {};

export async function quote(inputMint, outputMint, amountRaw, slippageBps = cfg.slippageBps) {
  const q = new URLSearchParams({
    inputMint,
    outputMint,
    amount: amountRaw.toString(),
    slippageBps: String(slippageBps),
    restrictIntermediateTokens: 'true',
  });
  const res = await fetchJson(`${cfg.jupiterUrl}/swap/v1/quote?${q}`, { headers, timeoutMs: 8000, retries: 1 });
  if (!res?.outAmount) throw new Error(`sin ruta: ${JSON.stringify(res).slice(0, 150)}`);
  return res;
}

export async function buildSwap(quoteResponse, userPublicKey) {
  const res = await fetchJson(`${cfg.jupiterUrl}/swap/v1/swap`, {
    method: 'POST',
    headers,
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
    retries: 1,
  });
  if (!res?.swapTransaction) throw new Error(`Jupiter no devolvió transacción: ${JSON.stringify(res).slice(0, 150)}`);
  return VersionedTransaction.deserialize(Buffer.from(res.swapTransaction, 'base64'));
}

let solPrice = { usd: 0, at: 0 };
export async function solPriceUsd() {
  if (Date.now() - solPrice.at < 60_000 && solPrice.usd) return solPrice.usd;
  try {
    const res = await fetchJson(`${cfg.jupiterUrl}/price/v3?ids=${SOL_MINT}`, { headers });
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
