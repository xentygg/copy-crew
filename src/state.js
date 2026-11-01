import fs from 'node:fs';
import { cfg } from './config.js';

const FILE = 'data/state.json';

function fresh(mode) {
  return {
    mode,
    startedAt: Date.now(),
    startEquityUsd: null,
    paperCashSol: null,
    paused: false,
    pauseReason: null,
    counters: { seen: 0, signals: 0, skipped: 0, filterKilled: 0, analystKilled: 0, guardSet: 0, copied: 0 },
    killReasons: {},
    positions: [],
    closed: [],
    equity: [],
    peakEquityUsd: 0,
    maxDrawdownPct: 0,
    log: [],
  };
}

function load() {
  try {
    return JSON.parse(fs.readFileSync(FILE, 'utf8'));
  } catch {
    return fresh(cfg.mode);
  }
}

export const state = load();

// Al cambiar de modo se empieza de cero (las posiciones simuladas no pasan a reales).
export function resetForMode(mode) {
  const archive = `data/history-${state.mode}-${state.startedAt}.json`;
  fs.writeFileSync(archive, JSON.stringify(state));
  Object.assign(state, fresh(mode));
  save();
}

// Empieza a medir de cero sin tocar posiciones abiertas, ajustes, wallets ni el Hunter.
export function resetStats() {
  const archive = `data/history-${state.mode}-${state.startedAt}-reset.json`;
  fs.writeFileSync(archive, JSON.stringify(state));
  const f = fresh(state.mode);
  Object.assign(state, {
    startedAt: Date.now(),
    counters: f.counters,
    killReasons: {},
    killDetails: {},
    closed: [],
    equity: [],
    startEquityUsd: null,
    peakEquityUsd: 0,
    maxDrawdownPct: 0,
  });
  save();
}

let timer = null;
export function save() {
  clearTimeout(timer);
  timer = setTimeout(() => {
    fs.writeFileSync(FILE + '.tmp', JSON.stringify(state));
    fs.renameSync(FILE + '.tmp', FILE);
  }, 500);
}

export function log(agent, msg) {
  const line = { t: Date.now(), agent, msg };
  state.log.unshift(line);
  if (state.log.length > 300) state.log.length = 300;
  console.log(`${new Date().toISOString()} [${agent}] ${msg}`);
  save();
}

export function kill(agent, reason, detail) {
  const key = `${agent}:${reason}`;
  state.killReasons[key] = (state.killReasons[key] || 0) + 1;
  // Guardar el último error concreto de los fallos de API para poder diagnosticarlos desde el panel.
  if ((reason.startsWith('nodata') || reason === 'noroute' || reason === 'busy') && detail) (state.killDetails ||= {})[key] = String(detail).slice(0, 160);
  if (agent === 'filter') state.counters.filterKilled++;
  if (agent === 'analyst') state.counters.analystKilled++;
  save();
}
