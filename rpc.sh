#!/usr/bin/env bash
# Hace que las consultas a la blockchain vayan por otro proveedor (p. ej. Alchemy) en vez de Helius.
# Uso:  bash rpc.sh
cd "$(dirname "$0")"
read -rp "Pega la URL de Alchemy (https://solana-mainnet.g.alchemy.com/v2/...) y pulsa Enter: " URL
if ! [[ "$URL" =~ ^https://[^[:space:]]+$ ]]; then
  echo "❌ Debe empezar por https:// y no tener espacios. No se cambió nada."
  exit 1
fi
if grep -q '^RPC_URL=' .env; then
  sed -i "s#^RPC_URL=.*#RPC_URL=\"$URL\"#" .env
else
  echo "RPC_URL=\"$URL\"" >> .env
fi
pm2 restart copy-crew >/dev/null
echo "✅ Listo: las consultas ahora van por $(echo "$URL" | cut -d/ -f3). Helius solo se usa para avisar de las compras."
