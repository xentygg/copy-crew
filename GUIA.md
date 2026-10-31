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

## Paso 1: tu dirección de Phantom (1 min)

No hace falta crear ninguna wallet ni copiar claves privadas: **el bot crea su propia wallet** en tu servidor.

Solo necesitas la dirección **pública** de tu Phantom (para poder retirar): **Phantom → Recibir → Solana → copiar**. Es como un número de cuenta: se puede compartir sin peligro.

> ⚠️ Nunca pegues en ningún sitio tus **12 palabras de recuperación**.

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

En la consola del servidor **escribe** estos dos comandos (no hace falta pegar nada) y pulsa Enter después de cada uno:

```bash
git clone https://github.com/xentygg/copy-crew
```

```bash
bash copy-crew/install.sh
```

Al terminar (1-2 minutos) verás algo así:

```
  Abre en el móvil:   http://203.0.113.10:3000
  Código:             482915
```

## Paso 6: configurar desde el móvil

1. Abre esa dirección en el navegador del móvil.
2. Rellena el formulario (aquí sí puedes copiar y pegar):
   - el **código** de 6 cifras de la consola,
   - la **API key de Helius**,
   - tu **dirección de Phantom** (para retirar),
   - deja **vacío** el campo de clave privada (el bot crea su wallet),
   - una **contraseña** para el panel,
   - la lista de **smart wallets**.
3. Pulsa **Guardar y arrancar**. A los pocos segundos se abre el panel: entra con tu contraseña (el usuario da igual). Añade la página a la pantalla de inicio.

## Paso 7: enviar el SOL y arrancar

En el panel verás **"Wallet del bot"** con su dirección. Envía ahí el SOL desde Binance (**Retirar → SOL → red Solana**).

1. El bot empieza en **SIM** (simulado). Déjalo **30 minutos** y comprueba que:
   - Scout ve compras (el contador sube).
   - Filter y Analyst eliminan tokens con motivos coherentes.
   - Si copia algo, el espejo muestra la wallet a la izquierda y tu copia a la derecha.
2. Si todo se ve bien, toca **🔴 Activar dinero REAL** y escribe `REAL`.

Las smart wallets se cambian cuando quieras desde el propio panel (apartado **Smart wallets → Guardar wallets**).

## Controles del panel

- **Pausar**: no abre operaciones nuevas, pero sigue gestionando las abiertas.
- **Vender todo**: cierra todas las posiciones de inmediato.
- **Vender** (en cada posición): cierra esa posición.
- Si el capital cae un **50 %**, el bot se pausa solo.

## Retirar el dinero

1. **Vender todo** y espera a que no quede ninguna posición abierta.
2. **💸 Retirar todo a mi Phantom** y escribe `RETIRAR`. Todo el SOL va a la dirección que pusiste en la configuración (y a ninguna otra).

Copia de seguridad de la wallet del bot (por si algún día borras el servidor): en la consola, `grep PRIVATE_KEY ~/copy-crew/.env` muestra su clave privada, que puedes importar en Phantom (**Añadir cuenta → Importar clave privada**).

## Comandos útiles (en la consola del servidor)

Ver lo que hace el bot en directo:

```bash
pm2 logs copy-crew
```

Reiniciar (después de cambiar `.env`):

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
