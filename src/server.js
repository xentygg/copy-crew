import http from 'node:http';
import fs from 'node:fs';
import crypto from 'node:crypto';
import { cfg, saveSetting, POSITION_PRESETS } from './config.js';
import { state, log, resetStats } from './state.js';
import { reasonLabel, forceSell, switchMode, isVetoed } from './crew.js';
import { keypair, withdrawAll, getSolBalance } from './solana.js';
import { parseWallets, saveWallets, trackedWallets, currentNotes, syncWebhook } from './wallets.js';
import { hunterSummary } from './hunter-loop.js';
import { chartistSummary } from './chartist-loop.js';
import { lastRugcheckError } from './agents/filter.js';
import { jupStats } from './jupiter.js';

const page = () => fs.readFileSync(new URL('../public/index.html', import.meta.url));

const same = (x, y) => {
  const a = Buffer.from(String(x));
  const b = Buffer.from(String(y));
  return a.length === b.length && crypto.timingSafeEqual(a, b);
};

// La sesión es una firma de la contraseña: cambiarla cierra todas las sesiones.
const sessionToken = () => crypto.createHmac('sha256', cfg.webhookSecret).update(cfg.dashboardPassword).digest('hex');

function authorized(req) {
  const cookie = (req.headers.cookie || '').split(/;\s*/).find((c) => c.startsWith('cc_session='));
  return Boolean(cookie) && same(cookie.slice('cc_session='.length), sessionToken());
}

let loginFailures = 0;
setInterval(() => (loginFailures = 0), 15 * 60_000).unref();

const loginPage = (error = '') => `<!doctype html><html lang="es"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1"><title>Copy Crew</title><style>
body{margin:0;background:#0b0d12;color:#e8ecf4;font:16px -apple-system,Segoe UI,Roboto,sans-serif}
main{max-width:380px;margin:0 auto;padding:60px 16px}h1{font-size:26px;margin:0 0 20px}
input{display:block;width:100%;box-sizing:border-box;padding:14px;border-radius:12px;border:1px solid #2a3142;background:#151922;color:#e8ecf4;font-size:17px}
button{margin-top:14px;width:100%;padding:14px;border:0;border-radius:12px;background:#2ecc71;color:#06210f;font-size:17px;font-weight:800}
.err{background:#3a1015;color:#ff5c5c;padding:10px 12px;border-radius:10px;margin-bottom:14px}label{display:block;margin:12px 0 6px;color:#8a93a6}
</style></head><body><main><h1>Copy Crew</h1>${error ? `<div class="err">${error}</div>` : ''}
<form method="post" action="/login"><label>Contraseña del panel</label>
<input name="password" type="password" autocomplete="current-password" autocapitalize="off" autocorrect="off" spellcheck="false" autofocus required>
<button>Entrar</button></form></main></body></html>`;

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

// Resultado de tus copias agrupado por la smart wallet que las originó.
function walletRanking(closed) {
  const by = {};
  for (const t of closed) {
    for (const src of t.sources || []) {
      const r = (by[src.wallet] ||= { wallet: src.wallet, trades: 0, wins: 0, pnlUsd: 0 });
      r.trades++;
      if (t.pnlUsd > 0) r.wins++;
      r.pnlUsd += t.pnlUsd / t.sources.length;
    }
  }
  return Object.values(by)
    .map((r) => ({ ...r, vetoed: isVetoed(r.wallet) }))
    .sort((a, b) => b.pnlUsd - a.pnlUsd);
}

// Resultados por estrategia, para comparar cuál funciona.
function strategyStats(closed) {
  const out = {};
  for (const id of ['top10', 'patrones', 'equipo']) {
    const ts = closed.filter((t) => (t.strategy || 'equipo') === id);
    const wins = ts.filter((t) => t.pnlUsd > 0).length;
    out[id] = { trades: ts.length, wins, winRate: ts.length ? (wins / ts.length) * 100 : null, pnlUsd: ts.reduce((s, t) => s + t.pnlUsd, 0) };
  }
  return out;
}

function publicState() {
  const closed = state.closed;
  const wins = closed.filter((t) => t.pnlSol > 0).length;
  return {
    mode: state.mode,
    paused: state.paused,
    pauseReason: state.pauseReason,
    wallet: keypair?.publicKey.toBase58(),
    withdrawAddress: cfg.withdrawAddress,
    startedAt: state.startedAt,
    startEquityUsd: state.startEquityUsd,
    equityUsd: state.equityUsd,
    solUsd: state.solUsd,
    spendCapUsd: cfg.spendCapUsd,
    counters: state.counters,
    kills: Object.entries(state.killReasons)
      .map(([k, n]) => ({ agent: k.split(':')[0], label: reasonLabel(k), n, detail: state.killDetails?.[k] }))
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
    confirmWallets: cfg.confirmWallets,
    maxOpenPositions: cfg.maxOpenPositions,
    maxTradeUsd: cfg.maxTradeUsd,
    quality: cfg.quality,
    followWalletSells: cfg.followWalletSells,
    rugcheckError: lastRugcheckError,
    jupiter: jupStats,
    positions: state.positions,
    closed: closed.slice(0, 60),
    equity: state.equity.filter((_, i, arr) => arr.length < 300 || i % Math.ceil(arr.length / 300) === 0 || i === arr.length - 1),
    log: state.log.slice(0, 80),
    hunter: hunterSummary(),
    walletRanking: walletRanking(state.closed),
    chartist: chartistSummary(),
    strategies: { team: cfg.stratTeam, top10: cfg.stratTop10, patterns: cfg.stratPatterns, topN: cfg.topN, stats: strategyStats(state.closed) },
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
        state.counters.events = (state.counters.events || 0) + (Array.isArray(txs) ? txs.length : 1);
        for (const tx of Array.isArray(txs) ? txs : [txs]) onWebhook(tx);
        return;
      }

      if (req.method === 'POST' && url.pathname === '/login') {
        const html = (code, body, headers = {}) => {
          res.writeHead(code, { 'content-type': 'text/html; charset=utf-8', ...headers });
          res.end(body);
        };
        if (loginFailures >= 20) return html(429, loginPage('Demasiados intentos. Espera 15 minutos.'));
        const pass = new URLSearchParams(await readBody(req, 10_000)).get('password') || '';
        if (!same(pass, cfg.dashboardPassword) && !same(pass.trim(), cfg.dashboardPassword)) {
          loginFailures++;
          return html(401, loginPage('Contraseña incorrecta.'));
        }
        return html(302, '', {
          location: '/',
          'set-cookie': `cc_session=${sessionToken()}; HttpOnly; SameSite=Lax; Path=/; Max-Age=${60 * 60 * 24 * 30}`,
        });
      }

      if (!authorized(req)) {
        if (url.pathname.startsWith('/api/')) return json(res, 401, { error: 'sesión caducada, recarga la página' });
        res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
        return res.end(loginPage());
      }

      if (req.method === 'GET' && url.pathname === '/') {
        res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
        return res.end(page());
      }
      if (req.method === 'GET' && url.pathname === '/api/state') return json(res, 200, publicState());
      if (req.method === 'GET' && url.pathname === '/api/wallets') return json(res, 200, { wallets: trackedWallets() });

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
            const list = parseWallets(body.text || '');
            if (!list.length) return json(res, 400, { error: 'No hay ninguna dirección válida' });
            await saveWallets(list, currentNotes());
            log('scout', `lista actualizada: vigilando ${list.length} smart wallets`);
            return json(res, 200, { ok: true, count: list.length });
          }
          case '/api/confirm': {
            const n = Number(body.n);
            saveSetting('confirmWallets', n);
            log('scout', `confirmación cambiada: ${n === 1 ? 'basta 1 smart wallet' : `${n} smart wallets deben comprar el mismo token`}`);
            break;
          }
          case '/api/reset-stats':
            resetStats();
            log('crew', '🔄 estadísticas reiniciadas: desde ahora se mide solo la estrategia actual');
            break;
          case '/api/strategy': {
            const key = { team: 'stratTeam', top10: 'stratTop10', patterns: 'stratPatterns' }[body.id];
            if (!key) return json(res, 400, { error: 'estrategia desconocida' });
            saveSetting(key, body.on === true);
            await syncWebhook();
            log('crew', `estrategia ${body.id === 'team' ? 'Equipo' : body.id === 'top10' ? `Top ${cfg.topN}` : 'Patrones'}: ${body.on ? 'ACTIVADA' : 'desactivada'}`);
            break;
          }
          case '/api/pattern-winrate': {
            saveSetting('patternMinWinRate', Number(body.n));
            log('chartist', `solo se operan patrones con ≥ ${cfg.patternMinWinRate}% de acierto`);
            break;
          }
          case '/api/follow': {
            const on = body.on === true;
            saveSetting('followWalletSells', on);
            log('guard', on ? 'se siguen las ventas de las smart wallets' : 'se IGNORAN las ventas de las smart wallets: Guard decide la salida');
            break;
          }
          case '/api/quality': {
            const q = body.q === 'strict' ? 'strict' : 'normal';
            saveSetting('quality', q);
            log('filter', q === 'strict' ? 'calidad ESTRICTA: pool mínimo $50k y top 10 ≤ 30%' : 'calidad normal');
            break;
          }
          case '/api/positions': {
            const n = Number(body.n);
            if (!POSITION_PRESETS[n]) return json(res, 400, { error: 'opción no válida' });
            saveSetting('maxOpenPositions', n);
            saveSetting('maxTradeUsd', POSITION_PRESETS[n]);
            log('sniper', `límites cambiados: hasta ${n} posiciones de máximo $${POSITION_PRESETS[n]}`);
            break;
          }
          case '/api/withdraw': {
            if (body.confirm !== 'RETIRAR') return json(res, 400, { error: 'Escribe RETIRAR para confirmar' });
            if (state.positions.some((p) => !p.paper)) return json(res, 400, { error: 'Primero pulsa "Vender todo" y espera a que se cierren las posiciones' });
            state.paused = true;
            state.pauseReason = 'retiro';
            const r = await withdrawAll(cfg.withdrawAddress);
            log('crew', `💸 retirados ${r.sol.toFixed(4)} SOL a ${cfg.withdrawAddress} (${r.sig})`);
            return json(res, 200, { ok: true, sol: r.sol });
          }
          case '/api/mode':
            if (body.mode === 'live' && body.confirm !== 'REAL') return json(res, 400, { error: 'Escribe REAL para confirmar' });
            if (body.mode === 'live' && Number(await getSolBalance()) / 1e9 < cfg.solReserve + 0.02) {
              return json(res, 400, { error: 'La wallet del bot no tiene SOL suficiente. Envía el SOL primero.' });
            }
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
