import { cfg, loadWallets } from './config.js';
import { state, log } from './state.js';
import { keypair } from './solana.js';
import { ingest } from './agents/scout.js';
import { hunterLoop } from './hunter-loop.js';
import { handleSignal, handleDirect, onWalletSell, guardLoop, equityLoop, initMode } from './crew.js';
import { computeTop, syncWebhook, topSummary } from './wallets.js';
import { chartistLoop } from './chartist-loop.js';
import { startServer } from './server.js';

const wallets = loadWallets().filter((w) => w !== keypair.publicKey.toBase58());
if (!wallets.length) {
  console.error('wallets.txt está vacío. Añade las smart wallets a copiar (una por línea).');
  process.exit(1);
}

startServer({
  onWebhook: (tx) => ingest(tx, { onSignal: handleSignal, onWalletSell, onDirect: handleDirect }),
});

await initMode();
computeTop();
await syncWebhook();
log('top10', `Top ${cfg.topN}: ${topSummary().map((t) => t.label).join(', ')}`);
log('crew', `estrategias: ${[cfg.stratTop10 && `Top ${cfg.topN} (${cfg.top10Safety ? 'con' : 'SIN'} protección)`, cfg.stratPatterns && 'Patrones'].filter(Boolean).join(' + ') || 'ninguna'}`);
log('crew', `modo ${state.mode === 'live' ? 'REAL' : 'observación'} · wallet del bot ${keypair.publicKey.toBase58()} · límite $${cfg.spendCapUsd}`);

guardLoop();
equityLoop();
hunterLoop();
chartistLoop();

process.on('unhandledRejection', (e) => console.error('unhandledRejection', e));
