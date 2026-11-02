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
  const signaled = new Map(); // pool → vela ya señalada (no repetir la misma señal en el siguiente análisis)
  for (;;) {
    try {
      const pools = (await trendingPools()).slice(0, 20);
      let learned = 0;
      let seen = 0;
      for (const pool of pools) {
        try {
          const c = await fetchCandles(pool.address);
          learned += learn(pool.address, c);
          const signals = liveSignals(c);
          const candle = c.t[c.t.length - 1];
          if (signals.length && signaled.get(pool.address) !== candle) {
            signaled.set(pool.address, candle);
            seen++;
            log('chartist', `📈 ${pool.name}: ${signals.map((p) => PATTERNS[p]).join(' + ')}`);
            handlePattern(pool, signals).catch((e) => log('error', `patrones: ${e.message}`));
          }
        } catch (e) {
          book.lastError = `${pool.name}: ${e.message}`;
        }
      }
      book.scans++;
      book.lastScan = Date.now();
      persist();
      log('chartist', `analizó ${pools.length} gráficos · ${seen} señales · ${learned} casos nuevos en la estadística`);
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
    requireProof: cfg.patternRequireProof,
    intervalMin: Math.round(cfg.patternIntervalMs / 60_000),
    tp: cfg.patternTpPct,
    sl: cfg.patternSlPct,
    patterns: Object.keys(PATTERNS).map(patternStatus).sort((a, b) => b.winRate - a.winRate),
  };
}
