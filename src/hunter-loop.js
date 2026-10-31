// Bucle del Hunter: escanea, añade las wallets que califican y lo cuenta en el panel.
import { cfg } from './config.js';
import { log } from './state.js';
import { hunt, scanOnce, pickNew, recordAdded, candidates } from './agents/hunter.js';
import { saveWallets, trackedWallets, currentNotes } from './wallets.js';
import { short } from './agents/scout.js';
import { sleep } from './http.js';

export async function hunterLoop() {
  if (!cfg.hunter) return;
  await sleep(60_000); // dejar que el resto del bot arranque primero
  for (;;) {
    try {
      await scanOnce({ log });
      const tracked = new Set(trackedWallets());
      const picks = pickNew(tracked);
      if (picks.length) {
        const notes = currentNotes();
        for (const c of picks) notes[c.wallet] = `hunter +$${Math.round(c.pnl)} ${Math.round(c.winRate)}% ${c.closed} tokens`;
        const list = [...tracked, ...picks.map((c) => c.wallet)];
        await saveWallets(list, notes);
        recordAdded(picks);
        const best = picks[0];
        log('hunter', `➕ ${picks.length} smart wallets nuevas (mejor: ${short(best.wallet)} +$${Math.round(best.pnl)}, ${Math.round(best.winRate)}% acierto) · total ${list.length}`);
      }
    } catch (e) {
      hunt.lastError = e.message;
      log('error', `hunter: ${e.message}`);
    }
    await sleep(cfg.hunterIntervalMs);
  }
}

export function hunterSummary() {
  const tracked = new Set(trackedWallets());
  return {
    enabled: cfg.hunter,
    scans: hunt.scans,
    lastScan: hunt.lastScan,
    lastError: hunt.lastError,
    studied: Object.keys(hunt.wallets).length,
    tradesSeen: hunt.tradesSeen,
    tracked: tracked.size,
    max: cfg.hunterMaxWallets,
    added: Object.keys(hunt.added).length,
    recent: Object.entries(hunt.added)
      .sort((a, b) => b[1].at - a[1].at)
      .slice(0, 10)
      .map(([wallet, a]) => ({ wallet, ...a })),
    pending: candidates(tracked).length,
  };
}
