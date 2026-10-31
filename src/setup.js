// Página de configuración inicial: permite pegar las claves desde el navegador del móvil
// en vez de hacerlo en la consola del servidor.
import http from 'node:http';
import fs from 'node:fs';
import crypto from 'node:crypto';
import { cfg, checkConfig, loadWallets } from './config.js';
import { Keypair } from '@solana/web3.js';
import bs58 from 'bs58';
import { loadKeypair } from './solana.js';

const CODE_FILE = 'data/setup-code';
const ADDR = /^[1-9A-HJ-NP-Za-km-z]{32,44}$/;

function setupCode() {
  if (!fs.existsSync(CODE_FILE)) fs.writeFileSync(CODE_FILE, String(crypto.randomInt(100000, 999999)));
  return fs.readFileSync(CODE_FILE, 'utf8').trim();
}

const esc = (s) => String(s).replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));

function form(missing, error = '') {
  const field = (key, label, help, type = 'text', required = true) =>
    missing.includes(key)
      ? `<label>${label}<input name="${key}" type="${type}" autocomplete="off" autocapitalize="off" spellcheck="false"${required ? ' required' : ''}></label><p>${help}</p>`
      : '';
  const needWallets = !loadWallets().length;
  return `<!doctype html><html lang="es"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>Copy Crew · configuración</title><style>
body{margin:0;background:#0b0d12;color:#e8ecf4;font:16px/1.4 -apple-system,Segoe UI,Roboto,sans-serif}
main{max-width:520px;margin:0 auto;padding:20px 16px 48px}h1{font-size:24px;margin:0 0 4px}
label{display:block;font-weight:700;margin-top:18px}input,textarea{display:block;width:100%;box-sizing:border-box;margin-top:6px;padding:12px;border-radius:10px;border:1px solid #2a3142;background:#151922;color:#e8ecf4;font:15px ui-monospace,Menlo,monospace}
textarea{height:180px}p{color:#8a93a6;font-size:13px;margin:6px 0 0}button{margin-top:24px;width:100%;padding:14px;border:0;border-radius:12px;background:#2ecc71;color:#06210f;font-size:17px;font-weight:800}
.err{background:#3a1015;color:#ff5c5c;padding:10px 12px;border-radius:10px;margin-top:14px}</style></head><body><main>
<h1>Copy Crew</h1><p>Configuración inicial. Solo se hace una vez.</p>
${error ? `<div class="err">${esc(error)}</div>` : ''}
<form method="post">
<label>Código de instalación<input name="code" inputmode="numeric" autocomplete="off" required></label><p>El número de 6 cifras que apareció en la consola del servidor al terminar la instalación.</p>
${field('HELIUS_API_KEY', 'API key de Helius', 'De dashboard.helius.dev → API Keys.')}
${field('WITHDRAW_ADDRESS', 'Tu dirección de Phantom (para retirar)', 'Phantom → Recibir → Solana → copiar. Es pública, se puede compartir. El botón "Retirar" del panel solo podrá enviar el dinero aquí.')}
${field('PRIVATE_KEY', 'Clave privada de la wallet del bot (opcional)', '<b>Déjalo vacío</b> y se creará una wallet nueva para el bot automáticamente. Te mostraremos su dirección para que le envíes el SOL.', 'password', false)}
${field('DASHBOARD_PASSWORD', 'Contraseña para el panel', 'Te la pedirá cada vez que abras el panel. No reutilices una contraseña importante.', 'password')}
${needWallets ? '<label>Smart wallets a copiar<textarea name="wallets" required placeholder="Una dirección por línea"></textarea></label><p>Pega entre 20 y 50 direcciones de gmgn.ai o kolscan.io. Podrás cambiarlas luego desde el panel.</p>' : ''}
<button>Guardar y arrancar</button></form></main></body></html>`;
}

function writeEnv(values) {
  let text = fs.existsSync('.env') ? fs.readFileSync('.env', 'utf8') : fs.readFileSync('.env.example', 'utf8');
  for (const [k, v] of Object.entries(values)) {
    // Entre comillas para que caracteres como # o espacios no corten el valor.
    const line = `${k}=${v.includes('"') ? `'${v}'` : `"${v}"`}`;
    const re = new RegExp(`^${k}=.*$`, 'm');
    text = re.test(text) ? text.replace(re, () => line) : `${text}\n${line}\n`;
  }
  fs.writeFileSync('.env', text, { mode: 0o600 });
}

export function startSetup() {
  const code = setupCode();
  let failures = 0;
  console.log(`\nModo configuración. Abre http://<IP-del-servidor>:${cfg.port} en el móvil. Código: ${code}\n`);

  http
    .createServer(async (req, res) => {
      const missing = checkConfig();
      const send = (html, status = 200) => {
        res.writeHead(status, { 'content-type': 'text/html; charset=utf-8' });
        res.end(html);
      };
      if (req.method !== 'POST') return send(form(missing));

      let body = '';
      for await (const c of req) {
        body += c;
        if (body.length > 200_000) return send(form(missing, 'Demasiados datos.'), 413);
      }
      const p = Object.fromEntries(new URLSearchParams(body));

      if (failures >= 10) return send(form(missing, 'Demasiados intentos. Reinicia el bot desde la consola.'), 429);
      if ((p.code || '').trim() !== code) {
        failures++;
        return send(form(missing, 'Código de instalación incorrecto.'), 401);
      }

      const values = {};
      for (const k of ['HELIUS_API_KEY', 'PRIVATE_KEY', 'DASHBOARD_PASSWORD', 'WITHDRAW_ADDRESS']) {
        if (missing.includes(k)) values[k] = (p[k] || '').trim();
      }
      if (values.WITHDRAW_ADDRESS !== undefined && !ADDR.test(values.WITHDRAW_ADDRESS)) {
        return send(form(missing, 'La dirección de Phantom no es válida. Cópiala desde Phantom → Recibir → Solana.'));
      }
      if (values.PRIVATE_KEY === '') {
        values.PRIVATE_KEY = bs58.encode(Keypair.generate().secretKey);
      } else if (values.PRIVATE_KEY !== undefined) {
        try {
          loadKeypair(values.PRIVATE_KEY);
        } catch {
          return send(form(missing, 'La clave privada no es válida. Cópiala de nuevo desde Phantom.'));
        }
      }
      if (values.DASHBOARD_PASSWORD !== undefined && values.DASHBOARD_PASSWORD.length < 6) {
        return send(form(missing, 'La contraseña del panel debe tener al menos 6 caracteres.'));
      }
      if (missing.includes('PUBLIC_URL')) values.PUBLIC_URL = `http://${req.headers.host}`;

      if (p.wallets !== undefined) {
        const list = [...new Set(p.wallets.split(/[\s,;]+/).filter((w) => ADDR.test(w)))];
        if (!list.length) return send(form(missing, 'No encontré ninguna dirección de wallet válida.'));
        fs.writeFileSync('wallets.txt', `# Smart wallets a copiar (una por línea)\n${list.join('\n')}\n`);
      }

      writeEnv(values);
      fs.rmSync(CODE_FILE, { force: true });
      send(`<!doctype html><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<meta http-equiv="refresh" content="8;url=/"><body style="background:#0b0d12;color:#e8ecf4;font:18px -apple-system,sans-serif;padding:24px">
<h2>✅ Guardado</h2><p>El bot se está reiniciando. En unos segundos se abrirá el panel y te pedirá la contraseña.</p><p>En el panel verás la <b>dirección de la wallet del bot</b>: envía ahí el SOL.</p></body>`);
      setTimeout(() => process.exit(0), 500); // PM2 lo vuelve a arrancar ya configurado
    })
    .listen(cfg.port);
}
