import { cfg } from './config.js';
import { fetchJson } from './http.js';

const API = 'https://api.helius.xyz/v0/webhooks';

// Crea o actualiza el webhook de Helius que nos envía las transacciones de las smart wallets.
// Solo swaps: el resto (transferencias, spam, NFTs…) gasta créditos de Helius sin servir para nada.
export let webhookTypes = null;

export async function ensureWebhook(wallets) {
  try {
    return await upsertWebhook(wallets, ['SWAP']);
  } catch (e) {
    if (!e.noRetry) throw e;
    console.warn('Helius rechazó el filtro SWAP, se usa ANY:', e.message);
    return upsertWebhook(wallets, ['ANY']);
  }
}

async function upsertWebhook(wallets, transactionTypes) {
  const webhookURL = `${cfg.publicUrl}/webhook`;
  const body = {
    webhookURL,
    transactionTypes,
    accountAddresses: wallets,
    webhookType: 'enhanced',
    authHeader: cfg.webhookSecret,
  };
  const existing = (await fetchJson(`${API}?api-key=${cfg.heliusKey}`)) || [];
  // Si el bot se mudó de servidor, se reutiliza su webhook anterior (el plan gratuito permite pocos).
  const mine = existing.find((w) => w.webhookURL === webhookURL) || existing.find((w) => /:3000\/webhook$/.test(w.webhookURL || ''));
  if (mine) {
    await fetchJson(`${API}/${mine.webhookID}?api-key=${cfg.heliusKey}`, { method: 'PUT', body });
    webhookTypes = transactionTypes;
    return mine.webhookID;
  }
  const created = await fetchJson(`${API}?api-key=${cfg.heliusKey}`, { method: 'POST', body });
  webhookTypes = transactionTypes;
  return created.webhookID;
}
