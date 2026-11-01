// Bucle de Chartist: cada 5 min analiza los gráficos de los tokens en tendencia,
// aprende de lo que ya pasó y, si ve un patrón probado en la última vela, avisa al equipo.
import { cfg } from './config.js';
import { log } from './state.js';
import { trendingPools } from './agents/hunter.js';
import { book, persist, fetchCandles, learn, liveSignals, patternStatus, PATTERNS } from './agents/chartist.js';
import { handlePattern } from './crew.js';
import { sleep } from './http.js';

export async function chartistLoop() {
  await sleep(90_000); // después de que arranquen el resto de agentes
  for (;;) {
    try {
      const pools = (await trendingPools()).slice(0, 25);
      let learned = 0;
      let seen = 0;
      for (const pool of pools) {
        try {
          const c = await fetchCandles(pool.address);
          learned += learn(pool.address, c);
          const signals = liveSignals(c);
          if (signals.length) {
            seen++;
            log('chartist', `📈 ${pool.name}: ${signals.map((p) => PATTERNS[p]).join(' + ')} (patrón con historial probado)`);
            handlePattern(pool, signals).catch((e) => log('error', `patrones: ${e.message}`));
          }
        } catch (e) {
          book.lastError = `${pool.name}: ${e.message}`;
        }
      }
      book.scans++;
      book.lastScan = Date.now();
      persist();
      const active = Object.keys(PATTERNS).filter((p) => patternStatus(p).status === 'activo').length;
      log('chartist', `analizó ${pools.length} gráficos · ${learned} casos nuevos aprendidos · ${active} patrones activos${seen ? ` · ${seen} señales` : ''}`);
    } catch (e) {
      book.lastError = e.message;
      log('error', `chartist: ${e.message}`);
    }
    await sleep(cfg.patternIntervalMs);
  }
}

export function chartistSummary() {
  return {
    scans: book.scans,
    lastScan: book.lastScan,
    lastError: book.lastError,
    minSamples: cfg.patternMinSamples,
    minWinRate: cfg.patternMinWinRate,
    tp: cfg.patternTpPct,
    sl: cfg.patternSlPct,
    patterns: Object.keys(PATTERNS).map(patternStatus).sort((a, b) => b.winRate - a.winRate),
  };
}
