import fs from 'node:fs';
import crypto from 'node:crypto';

if (fs.existsSync('.env')) process.loadEnvFile('.env');

const env = process.env;
const num = (k, d) => (env[k] === undefined || env[k] === '' ? d : Number(env[k]));
const bool = (k, d) => (env[k] === undefined || env[k] === '' ? d : env[k] === 'true');

export const SOL_MINT = 'So11111111111111111111111111111111111111112';
export const QUOTE_MINTS = new Set([
  SOL_MINT,
  'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v', // USDC
  'Es9vMFrzaCERmJfrF4H2FYD4KCoNkY11McCe8BenwNYB', // USDT
]);

export const cfg = {
  heliusKey: env.HELIUS_API_KEY || '',
  privateKey: env.PRIVATE_KEY || '',
  publicUrl: (env.PUBLIC_URL || '').replace(/\/$/, ''),
  dashboardPassword: env.DASHBOARD_PASSWORD || '',
  withdrawAddress: env.WITHDRAW_ADDRESS || '',
  mode: env.MODE === 'live' ? 'live' : 'watch',
  port: num('PORT', 3000),

  spendCapUsd: num('SPEND_CAP_USD', 100),
  maxTradeUsd: num('MAX_TRADE_USD', 15),
  minTradeUsd: num('MIN_TRADE_USD', 4),
  copyPct: num('COPY_PCT', 10),
  maxOpenPositions: num('MAX_OPEN_POSITIONS', 3),
  lossLimitPct: num('LOSS_LIMIT_PCT', 50),
  solReserve: num('SOL_RESERVE', 0.03),

  confirmWallets: num('CONFIRM_WALLETS', 2),
  confirmWindowMs: num('CONFIRM_WINDOW_MIN', 15) * 60_000,
  minWalletBuySol: num('MIN_WALLET_BUY_SOL', 0.3),

  maxTop10Pct: num('MAX_TOP10_PCT', 35),
  maxDevPct: num('MAX_DEV_PCT', 5),
  minLiquidityUsd: num('MIN_LIQUIDITY_USD', 25000),
  minLpBurnedPct: num('MIN_LP_BURNED_PCT', 90),

  maxEntryPremiumPct: num('MAX_ENTRY_PREMIUM_PCT', 30),

  stopLossPct: num('STOP_LOSS_PCT', 20),
  takeProfitPct: num('TAKE_PROFIT_PCT', 100),
  trailActivatePct: num('TRAIL_ACTIVATE_PCT', 30),
  trailPct: num('TRAIL_PCT', 20),
  maxHoldMs: num('MAX_HOLD_MIN', 120) * 60_000,
  followWalletSells: bool('FOLLOW_WALLET_SELLS', true),

  hunter: bool('HUNTER', true),
  hunterMaxWallets: num('HUNTER_MAX_WALLETS', 500),
  hunterMinPnlUsd: num('HUNTER_MIN_PNL_USD', 300),
  hunterMinTokens: num('HUNTER_MIN_TOKENS', 3),
  hunterMinWinRate: num('HUNTER_MIN_WINRATE', 50),
  hunterIntervalMs: num('HUNTER_INTERVAL_MIN', 15) * 60_000,

  slippageBps: num('SLIPPAGE_BPS', 1500),
  priorityMaxLamports: num('PRIORITY_MAX_LAMPORTS', 1_000_000),
  jupiterUrl: (env.JUPITER_URL || 'https://lite-api.jup.ag').replace(/\/$/, ''),
  jupiterApiKey: env.JUPITER_API_KEY || '',
};

cfg.rpcUrl = env.RPC_URL || `https://mainnet.helius-rpc.com/?api-key=${cfg.heliusKey}`;

// Secreto para que solo Helius pueda enviarnos eventos al webhook.
// Se genera una vez y se guarda en data/.
fs.mkdirSync('data', { recursive: true });
const secretFile = 'data/webhook-secret';
if (!fs.existsSync(secretFile)) fs.writeFileSync(secretFile, crypto.randomBytes(24).toString('hex'));
cfg.webhookSecret = fs.readFileSync(secretFile, 'utf8').trim();

export function loadWallets() {
  if (!fs.existsSync('wallets.txt')) return [];
  const list = fs
    .readFileSync('wallets.txt', 'utf8')
    .split('\n')
    .map((l) => l.replace(/#.*/, '').trim())
    .filter((l) => /^[1-9A-HJ-NP-Za-km-z]{32,44}$/.test(l));
  return [...new Set(list)];
}

export function checkConfig() {
  const missing = [];
  if (!cfg.heliusKey) missing.push('HELIUS_API_KEY');
  if (!cfg.privateKey) missing.push('PRIVATE_KEY');
  if (!cfg.publicUrl) missing.push('PUBLIC_URL');
  if (!cfg.dashboardPassword) missing.push('DASHBOARD_PASSWORD');
  if (!cfg.withdrawAddress) missing.push('WITHDRAW_ADDRESS');
  return missing;
}

// Ajustes cambiados desde el panel: se guardan aparte y tienen prioridad sobre .env.
const SETTINGS_FILE = 'data/settings.json';
const EDITABLE = { confirmWallets: [1, 2, 3] };
try {
  for (const [k, v] of Object.entries(JSON.parse(fs.readFileSync(SETTINGS_FILE, 'utf8')))) {
    if (EDITABLE[k]?.includes(v)) cfg[k] = v;
  }
} catch {}

export function saveSetting(key, value) {
  if (!EDITABLE[key]?.includes(value)) throw new Error('valor no permitido');
  cfg[key] = value;
  let all = {};
  try {
    all = JSON.parse(fs.readFileSync(SETTINGS_FILE, 'utf8'));
  } catch {}
  all[key] = value;
  fs.writeFileSync(SETTINGS_FILE, JSON.stringify(all));
}
