import { cfg, loadWallets, checkConfig } from './config.js';
import { state, log } from './state.js';
import { keypair } from './solana.js';
import { ingest, setTrackedWallets } from './agents/scout.js';
import { handleSignal, onWalletSell, guardLoop, equityLoop, initMode } from './crew.js';
import { ensureWebhook } from './helius.js';
import { startServer } from './server.js';

const missing = checkConfig();
if (missing.length) {
  console.error(`Faltan datos en .env: ${missing.join(', ')}`);
  process.exit(1);
}

const wallets = loadWallets().filter((w) => w !== keypair.publicKey.toBase58());
if (!wallets.length) {
  console.error('wallets.txt está vacío. Añade las smart wallets a copiar (una por línea).');
  process.exit(1);
}
setTrackedWallets(wallets);

startServer({
  onWebhook: (tx) => ingest(tx, { onSignal: handleSignal, onWalletSell }),
});

await initMode();
const id = await ensureWebhook(wallets);
log('scout', `vigilando ${wallets.length} smart wallets (webhook ${id})`);
log('crew', `modo ${state.mode === 'live' ? 'REAL' : 'observación'} · wallet del bot ${keypair.publicKey.toBase58()} · límite $${cfg.spendCapUsd}`);

guardLoop();
equityLoop();

process.on('unhandledRejection', (e) => console.error('unhandledRejection', e));
