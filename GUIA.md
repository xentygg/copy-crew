# Copy Crew: guía paso a paso

Bot de copy-trading en Solana. Cinco agentes deben aprobar cada operación:

| Agente | Qué hace |
|---|---|
| **Scout** | Vigila tus smart wallets. Da la señal cuando **2 de ellas** compran el mismo token en menos de 15 min. |
| **Filter** | Elimina el token si rompe una regla: top 10 > 35 %, dev > 5 %, pool < $25k, mint o freeze sin revocar, LP sin quemar. |
| **Analyst** | Comprueba que las wallets siguen dentro y que el precio no ha subido ya más de un 30 % desde su compra. |
| **Guard** | Fija el stop (−20 %), el take profit (+100 %) y el trailing **antes** de comprar. Si la wallet copiada vende, sale. |
| **Sniper** | Compra el 10 % de lo que compró la wallet (entre $4 y $15), con un máximo de $100 invertidos a la vez. |

Tiempo total: unos 45 minutos. Todo se puede hacer desde el móvil.

---

## Paso 1: wallet nueva para el bot (5 min)

1. En **Phantom**: toca tu cuenta arriba a la izquierda → **Añadir / Conectar cuenta** → **Crear nueva cuenta**. Llámala "Bot".
2. Envía a esa cuenta los **$100 en SOL**.
3. Saca su clave privada: **Ajustes → Gestionar cuentas → Bot → Mostrar clave privada**. Cópiala en un lugar seguro; la pegarás en el paso 5.

> ⚠️ Usa **solo** esta wallet nueva. Quien tenga la clave privada puede vaciarla, así que no la compartas con nadie, ni conmigo.

## Paso 2: cuenta en Helius (3 min)

1. Entra en **dashboard.helius.dev** y regístrate (gratis).
2. En **API Keys**, copia tu clave.

## Paso 3: servidor (10 min, unos $5–6/mes)

Opción recomendada: **DigitalOcean** (su consola funciona desde el navegador del móvil).

1. Crea una cuenta en digitalocean.com.
2. **Create → Droplets**:
   - Región: cualquiera de EE. UU. (Nueva York va bien).
   - Imagen: **Ubuntu 24.04**.
   - Plan: **Basic → Regular → $6/mes** (1 GB de RAM).
   - Autenticación: **Password** (elige una contraseña fuerte).
3. Cuando se cree, ábrelo y toca **Console** (o "Access → Launch Droplet Console"). Se abre una terminal negra: ahí pegarás los comandos.

(Hetzner o Vultr también sirven; los pasos son iguales.)

## Paso 4: elegir las smart wallets (15 min)

El bot es tan bueno como las wallets que copia. Dónde buscarlas:

- **gmgn.ai** → Solana → pestaña *Smart Money* / *Top Traders*
- **kolscan.io** → leaderboard
- **birdeye.so** → *Top Traders* de un token que haya subido mucho

Qué buscar:
- PnL positivo a **30 días**, no solo de un día de suerte.
- Win rate por encima del 50 %.
- **Evita** wallets con cientos de operaciones al día: suelen ser bots, son imposibles de copiar a tiempo y gastan los créditos gratuitos de Helius.

**Empieza con 20–50 wallets.** Más adelante puedes ampliar.

## Paso 5: instalar el bot (5 min)

En la consola del servidor, pega estos comandos uno por uno:

```bash
git clone <URL_DE_TU_REPO> copy-crew
```

```bash
cd copy-crew
```

```bash
nano wallets.txt
```

Pega tus wallets (una por línea), guarda con **Ctrl+O, Enter** y sal con **Ctrl+X**. Después:

```bash
bash install.sh
```

Te pedirá la API key de Helius, la clave privada del paso 1 y una contraseña para el panel. Al terminar te dará una dirección como `http://203.0.113.10:3000`.

## Paso 6: arrancar

1. Abre esa dirección en el móvil e introduce la contraseña (el usuario da igual). Añádela a la pantalla de inicio.
2. El bot arranca en **SIM** (simulado). Déjalo **30 minutos** y comprueba que:
   - Scout ve compras (el contador sube).
   - Filter y Analyst eliminan tokens con motivos coherentes.
   - Si copia algo, el espejo muestra la wallet a la izquierda y tu copia a la derecha.
3. Si todo se ve bien, toca **🔴 Activar dinero REAL** y escribe `REAL`.

## Controles del panel

- **Pausar**: no abre operaciones nuevas, pero sigue gestionando las abiertas.
- **Vender todo**: cierra todas las posiciones de inmediato.
- **Vender** (en cada posición): cierra esa posición.
- Si el capital cae un **50 %**, el bot se pausa solo.

## Comandos útiles (en la consola del servidor)

Ver lo que hace el bot en directo:

```bash
pm2 logs copy-crew
```

Reiniciar (después de cambiar `.env` o `wallets.txt`):

```bash
pm2 restart copy-crew
```

Cambiar ajustes (stop, tamaño, filtros…):

```bash
nano ~/copy-crew/.env
```

## Lo que debes saber

- **Las memecoins pueden llegar a cero en segundos.** El stop es una orden de venta, no una garantía: si el precio se desploma de golpe, se vende más abajo del −20 %.
- Cada operación cuesta algo de comisión: la de red, la de prioridad (hasta 0.001 SOL) y el slippage. Con operaciones pequeñas, estos costes pesan.
- Los resultados del post de X eran **simulados**. Tu resultado real será distinto.
- El panel usa `http` sin cifrar: no reutilices una contraseña importante.
