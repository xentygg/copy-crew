import { loadWallets, checkConfig } from './config.js';

// Sin claves o sin wallets: arrancar la página de configuración en lugar del bot.
if (checkConfig().length || !loadWallets().length) {
  const { startSetup } = await import('./setup.js');
  startSetup();
} else {
  await import('./main.js');
}
