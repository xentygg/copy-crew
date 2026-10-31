#!/usr/bin/env bash
# Cambia la contraseña del panel y reinicia el bot.  Uso:  bash clave.sh
cd "$(dirname "$0")"
read -rp "Escribe la contraseña nueva (solo letras y números) y pulsa Enter: " PASS
if ! [[ "$PASS" =~ ^[A-Za-z0-9]{6,}$ ]]; then
  echo "❌ Usa al menos 6 letras o números, sin espacios ni símbolos. No se cambió nada."
  exit 1
fi
if grep -q '^DASHBOARD_PASSWORD=' .env; then
  sed -i "s/^DASHBOARD_PASSWORD=.*/DASHBOARD_PASSWORD=\"$PASS\"/" .env
else
  echo "DASHBOARD_PASSWORD=\"$PASS\"" >> .env
fi
pm2 restart copy-crew >/dev/null
sleep 3
echo
echo "✅ Contraseña cambiada a:  $PASS"
echo "   Versión del bot:        $(git log -1 --format=%h)"
if curl -s localhost:3000 | grep -q 'Contraseña del panel'; then
  echo "✅ El bot está funcionando. Entra en: http://$(curl -fsS https://api.ipify.org 2>/dev/null):3000"
else
  echo "⚠️  El bot no responde todavía. Mándale una foto de esta pantalla a Claude."
  pm2 logs copy-crew --lines 15 --nostream
fi
