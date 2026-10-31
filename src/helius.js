import { cfg } from './config.js';
import { fetchJson } from './http.js';

const API = 'https://api.helius.xyz/v0/webhooks';

// Crea o actualiza el webhook de Helius que nos envía las transacciones de las smart wallets.
export async function ensureWebhook(wallets) {
  const webhookURL = `${cfg.publicUrl}/webhook`;
  const body = {
    webhookURL,
    transactionTypes: ['ANY'],
    accountAddresses: wallets,
    webhookType: 'enhanced',
    authHeader: cfg.webhookSecret,
  };
  const existing = (await fetchJson(`${API}?api-key=${cfg.heliusKey}`)) || [];
  const mine = existing.find((w) => w.webhookURL === webhookURL);
  if (mine) {
    await fetchJson(`${API}/${mine.webhookID}?api-key=${cfg.heliusKey}`, { method: 'PUT', body });
    return mine.webhookID;
  }
  const created = await fetchJson(`${API}?api-key=${cfg.heliusKey}`, { method: 'POST', body });
  return created.webhookID;
}
