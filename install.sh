#!/usr/bin/env bash
# Instalador de Copy Crew para un servidor Ubuntu nuevo.
# Uso:  bash install.sh
# No pide nada por consola: las claves se ponen después desde el navegador.
set -euo pipefail
cd "$(dirname "$0")"

echo "==> Instalando Node.js 22 y PM2 (tarda 1-2 minutos)…"
if ! command -v node >/dev/null || [ "$(node -v | cut -d. -f1 | tr -d v)" -lt 22 ]; then
  curl -fsSL https://deb.nodesource.com/setup_22.x | bash - >/dev/null
  apt-get install -y nodejs >/dev/null
fi
npm install -g pm2 >/dev/null 2>&1

echo "==> Instalando el bot…"
npm ci --omit=dev --no-audit --no-fund >/dev/null

mkdir -p data
if [ ! -f .env ] && [ ! -f data/setup-code ]; then
  shuf -i 100000-999999 -n 1 > data/setup-code
fi

if command -v ufw >/dev/null; then
  ufw allow OpenSSH >/dev/null
  ufw allow 3000/tcp >/dev/null
  ufw --force enable >/dev/null
fi

pm2 delete copy-crew >/dev/null 2>&1 || true
pm2 start src/index.js --name copy-crew >/dev/null
pm2 save >/dev/null
pm2 startup systemd -u "$USER" --hp "$HOME" >/dev/null 2>&1 || true

IP=$(curl -fsS https://api.ipify.org 2>/dev/null || hostname -I | awk '{print $1}')
echo
echo "============================================"
echo "  ✅ Instalado"
echo
echo "  Abre en el móvil:   http://$IP:3000"
if [ -f data/setup-code ]; then
echo "  Código:             $(cat data/setup-code)"
fi
echo "============================================"
