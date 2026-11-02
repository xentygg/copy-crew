// Lista de smart wallets vigiladas: un solo sitio para cambiarla (panel o Hunter).
import fs from 'node:fs';
import { cfg, loadWallets } from './config.js';
import { keypair } from './solana.js';
import { setTrackedWallets, setDirectWallets, short } from './agents/scout.js';
import { ensureWebhook, webhookTypes } from './helius.js';
import { topWallets } from './agents/hunter.js';
import { isVetoed } from './crew.js';
import { log } from './state.js';
import { mutex } from './http.js';

const exclusive = mutex();
const ADDR = /^[1-9A-HJ-NP-Za-km-z]{32,44}$/;

export function parseWallets(text) {
  return [...new Set(String(text).split(/[\s,;]+/).filter((w) => ADDR.test(w)))].filter((w) => w !== keypair?.publicKey.toBase58());
}

// notes: { address: 'comentario' } para dejar constancia de dónde salió cada wallet.
export async function saveWallets(list, notes = {}) {
  const lines = list.map((w) => (notes[w] ? `${w}  # ${notes[w]}` : w));
  fs.writeFileSync('wallets.txt', `# Smart wallets a copiar (una por línea)\n${lines.join('\n')}\n`);
  await syncWebhook();
  return list.length;
}

// --- Top 10 del momento --------------------------------------------------------
// Las mejores según el Hunter (últimas 24 h). Si no llegan a 10, se completa con wallets.txt en su orden
// (las primeras son las elegidas de kolscan). Nunca entra una wallet vetada por tus resultados.
export let top = [];

export function computeTop() {
  const picked = topWallets(cfg.topN, isVetoed).map((c) => ({ wallet: c.wallet, pnl: Math.round(c.pnl), winRate: Math.round(c.winRate), closed: c.closed, source: 'hunter' }));
  for (const w of trackedWallets()) {
    if (picked.length >= cfg.topN) break;
    if (!isVetoed(w) && !picked.some((p) => p.wallet === w)) picked.push({ wallet: w, source: 'lista' });
  }
  const changed = picked.map((p) => p.wallet).join() !== top.map((p) => p.wallet).join();
  top = picked;
  return changed;
}

// El webhook de Helius solo vigila lo que hace falta: con "Equipo" apagado, solo las 10 del Top
// (ahorra muchos créditos). Las wallets del Top se copian al instante si la estrategia está activa.
let lastSynced = '';
export function syncWebhook() {
  return exclusive(async () => {
    const topList = top.map((p) => p.wallet);
    const list = cfg.stratTeam ? [...new Set([...trackedWallets(), ...topList])] : topList;
    setDirectWallets(cfg.stratTop10 ? topList : []);
    setTrackedWallets(list);
    const key = list.slice().sort().join();
    if (list.length && key !== lastSynced) {
      await ensureWebhook(list);
      lastSynced = key;
      log('scout', `vigilando ${list.length} wallets (${cfg.stratTeam ? 'todas' : 'solo el Top ' + cfg.topN}, solo ${webhookTypes?.join('/') || 'SWAP'})`);
    }
    return list.length;
  });
}

export function topSummary() {
  return top.map((p) => ({ ...p, label: short(p.wallet) }));
}

export function trackedWallets() {
  return loadWallets().filter((w) => w !== keypair?.publicKey.toBase58());
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
