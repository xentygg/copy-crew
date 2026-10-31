import http from 'node:http';
import fs from 'node:fs';
import crypto from 'node:crypto';
import { cfg, loadWallets } from './config.js';
import { state, log } from './state.js';
import { reasonLabel, forceSell, switchMode } from './crew.js';
import { keypair } from './solana.js';
import { setTrackedWallets } from './agents/scout.js';
import { ensureWebhook } from './helius.js';

const page = () => fs.readFileSync(new URL('../public/index.html', import.meta.url));

function authorized(req) {
  const h = req.headers.authorization || '';
  if (!h.startsWith('Basic ')) return false;
  const pass = Buffer.from(h.slice(6), 'base64').toString().split(':').slice(1).join(':');
  const a = Buffer.from(pass);
  const b = Buffer.from(cfg.dashboardPassword);
  return a.length === b.length && crypto.timingSafeEqual(a, b);
}

function readBody(req, limit = 5_000_000) {
  return new Promise((resolve, reject) => {
    let data = '';
    req.on('data', (c) => {
      data += c;
      if (data.length > limit) reject(new Error('demasiado grande'));
    });
    req.on('end', () => resolve(data));
    req.on('error', reject);
  });
}

function json(res, code, obj) {
  res.writeHead(code, { 'content-type': 'application/json' });
  res.end(JSON.stringify(obj));
}

function publicState() {
  const closed = state.closed;
  const wins = closed.filter((t) => t.pnlSol > 0).length;
  return {
    mode: state.mode,
    paused: state.paused,
    pauseReason: state.pauseReason,
    wallet: keypair?.publicKey.toBase58(),
    startedAt: state.startedAt,
    startEquityUsd: state.startEquityUsd,
    equityUsd: state.equityUsd,
    solUsd: state.solUsd,
    spendCapUsd: cfg.spendCapUsd,
    counters: state.counters,
    kills: Object.entries(state.killReasons)
      .map(([k, n]) => ({ agent: k.split(':')[0], label: reasonLabel(k), n }))
      .sort((a, b) => b.n - a.n),
    stats: {
      trades: closed.length,
      wins,
      winRate: closed.length ? (wins / closed.length) * 100 : null,
      bestUsd: closed.length ? Math.max(...closed.map((t) => t.pnlUsd)) : null,
      worstUsd: closed.length ? Math.min(...closed.map((t) => t.pnlUsd)) : null,
      maxDrawdownPct: state.maxDrawdownPct,
    },
    plan: { sl: cfg.stopLossPct, tp: cfg.takeProfitPct },
    positions: state.positions,
    closed: closed.slice(0, 60),
    equity: state.equity.filter((_, i, arr) => arr.length < 300 || i % Math.ceil(arr.length / 300) === 0 || i === arr.length - 1),
    log: state.log.slice(0, 80),
  };
}

export function startServer({ onWebhook }) {
  const server = http.createServer(async (req, res) => {
    try {
      const url = new URL(req.url, 'http://x');

      if (req.method === 'POST' && url.pathname === '/webhook') {
        if (req.headers.authorization !== cfg.webhookSecret) return json(res, 401, { error: 'no' });
        const body = await readBody(req);
        json(res, 200, { ok: true });
        const txs = JSON.parse(body);
        for (const tx of Array.isArray(txs) ? txs : [txs]) onWebhook(tx);
        return;
      }

      if (!authorized(req)) {
        res.writeHead(401, { 'www-authenticate': 'Basic realm="copy-crew"' });
        return res.end('Contraseña requerida');
      }

      if (req.method === 'GET' && url.pathname === '/') {
        res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
        return res.end(page());
      }
      if (req.method === 'GET' && url.pathname === '/api/state') return json(res, 200, publicState());
      if (req.method === 'GET' && url.pathname === '/api/wallets') return json(res, 200, { wallets: loadWallets() });

      if (req.method === 'POST' && url.pathname.startsWith('/api/')) {
        const body = JSON.parse((await readBody(req)) || '{}');
        switch (url.pathname) {
          case '/api/pause':
            state.paused = true;
            state.pauseReason = 'manual';
            log('crew', '⏸ pausado desde el panel');
            break;
          case '/api/resume':
            state.paused = false;
            state.pauseReason = null;
            log('crew', '▶ reanudado desde el panel');
            break;
          case '/api/sell':
            forceSell(body.id || 'all');
            log('crew', body.id ? 'venta manual pedida' : '🚨 vender TODO pedido desde el panel');
            break;
          case '/api/wallets': {
            const list = [...new Set(String(body.text || '').split(/[\s,;]+/).filter((w) => /^[1-9A-HJ-NP-Za-km-z]{32,44}$/.test(w)))]
              .filter((w) => w !== keypair.publicKey.toBase58());
            if (!list.length) return json(res, 400, { error: 'No hay ninguna dirección válida' });
            fs.writeFileSync('wallets.txt', `# Smart wallets a copiar (una por línea)\n${list.join('\n')}\n`);
            await ensureWebhook(list);
            setTrackedWallets(list);
            log('scout', `lista actualizada: vigilando ${list.length} smart wallets`);
            return json(res, 200, { ok: true, count: list.length });
          }
          case '/api/mode':
            if (body.mode === 'live' && body.confirm !== 'REAL') return json(res, 400, { error: 'Escribe REAL para confirmar' });
            await switchMode(body.mode === 'live' ? 'live' : 'watch');
            break;
          default:
            return json(res, 404, { error: 'no existe' });
        }
        return json(res, 200, { ok: true });
      }
      json(res, 404, { error: 'no existe' });
    } catch (e) {
      if (!res.headersSent) json(res, 500, { error: e.message });
    }
  });
  server.listen(cfg.port, () => console.log(`Panel en ${cfg.publicUrl || `http://localhost:${cfg.port}`}`));
  return server;
}
