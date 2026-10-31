#!/usr/bin/env bash
# Instalador de Copy Crew para un servidor Ubuntu nuevo.
# Uso:  bash install.sh
set -euo pipefail
cd "$(dirname "$0")"

echo "==> Instalando Node.js 22 y PM2…"
if ! command -v node >/dev/null || [ "$(node -v | cut -d. -f1 | tr -d v)" -lt 22 ]; then
  curl -fsSL https://deb.nodesource.com/setup_22.x | sudo -E bash -
  sudo apt-get install -y nodejs
fi
sudo npm install -g pm2 >/dev/null

echo "==> Instalando dependencias del bot…"
npm ci --omit=dev --no-audit --no-fund

if [ ! -f .env ]; then
  echo
  echo "==> Configuración (pega cada dato y pulsa Enter)"
  read -rp "API key de Helius: " HELIUS
  read -rsp "Clave privada de la wallet DEL BOT (no se verá al pegarla): " PK; echo
  read -rsp "Contraseña para el panel: " PASS; echo
  IP=$(curl -fsS https://api.ipify.org || hostname -I | awk '{print $1}')
  cp .env.example .env
  sed -i "s|^HELIUS_API_KEY=.*|HELIUS_API_KEY=$HELIUS|" .env
  sed -i "s|^PRIVATE_KEY=.*|PRIVATE_KEY=$PK|" .env
  sed -i "s|^DASHBOARD_PASSWORD=.*|DASHBOARD_PASSWORD=$PASS|" .env
  sed -i "s|^PUBLIC_URL=.*|PUBLIC_URL=http://$IP:3000|" .env
  chmod 600 .env
fi

if command -v ufw >/dev/null; then
  sudo ufw allow OpenSSH >/dev/null
  sudo ufw allow 3000/tcp >/dev/null
  sudo ufw --force enable >/dev/null
fi

if ! grep -qvE '^\s*(#|$)' wallets.txt; then
  echo
  echo "⚠  wallets.txt está vacío. Edítalo con:  nano wallets.txt"
  echo "   y luego arranca el bot con:          pm2 start src/index.js --name copy-crew && pm2 save"
  exit 0
fi

pm2 delete copy-crew >/dev/null 2>&1 || true
pm2 start src/index.js --name copy-crew
pm2 save
sudo env PATH="$PATH" pm2 startup systemd -u "$USER" --hp "$HOME" >/dev/null
echo
echo "✅ Bot en marcha. Abre en el móvil: $(grep ^PUBLIC_URL .env | cut -d= -f2)"
