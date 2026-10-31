// Lista de smart wallets vigiladas: un solo sitio para cambiarla (panel o Hunter).
import fs from 'node:fs';
import { loadWallets } from './config.js';
import { keypair } from './solana.js';
import { setTrackedWallets } from './agents/scout.js';
import { ensureWebhook } from './helius.js';
import { mutex } from './http.js';

const exclusive = mutex();
const ADDR = /^[1-9A-HJ-NP-Za-km-z]{32,44}$/;

export function parseWallets(text) {
  return [...new Set(String(text).split(/[\s,;]+/).filter((w) => ADDR.test(w)))].filter((w) => w !== keypair.publicKey.toBase58());
}

// notes: { address: 'comentario' } para dejar constancia de dónde salió cada wallet.
export function saveWallets(list, notes = {}) {
  return exclusive(async () => {
    await ensureWebhook(list);
    const lines = list.map((w) => (notes[w] ? `${w}  # ${notes[w]}` : w));
    fs.writeFileSync('wallets.txt', `# Smart wallets a copiar (una por línea)\n${lines.join('\n')}\n`);
    setTrackedWallets(list);
    return list.length;
  });
}

export function trackedWallets() {
  return loadWallets().filter((w) => w !== keypair.publicKey.toBase58());
}

// Conserva los comentarios ya escritos en wallets.txt.
export function currentNotes() {
  const notes = {};
  if (!fs.existsSync('wallets.txt')) return notes;
  for (const line of fs.readFileSync('wallets.txt', 'utf8').split('\n')) {
    const m = line.match(/^\s*([1-9A-HJ-NP-Za-km-z]{32,44})\s*#\s*(.+)$/);
    if (m) notes[m[1]] = m[2].trim();
  }
  return notes;
}
