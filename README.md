# Bot financiero por WhatsApp

Le escribes por WhatsApp en lenguaje normal ("compré aceite por 20 mil") y el bot lo
registra en una base de datos SQLite. También te hace resúmenes, controla presupuestos
y expone una API de solo lectura para que tu página web muestre los datos.

```
Tu WhatsApp ──► bot.js (Baileys) ──► ia.js (Claude interpreta)  ──► acciones.js ──► finanzas.db
                     │                                                                  ▲
                     └── comandos.js (/gasto, /resumen... sin IA)                        │
                                                                   api.js (para tu página)┘
```

## Requisitos
- **Node.js 22.5 o superior** (`node --version`). Usa el SQLite que ya trae Node, sin compilar nada.
- **Un número de WhatsApp para el bot** (idealmente uno secundario; Baileys no es oficial y puede
  provocar bloqueos). Tú le escribes desde tu número personal.
- **Una clave de la API de Anthropic** (console.anthropic.com) si quieres escribir en texto libre.
  Es independiente de tu suscripción a Claude y se paga por uso. Sin clave, el bot funciona solo
  con comandos.

## Instalación
```bash
cd ~/bot-financiero
npm install @whiskeysockets/baileys qrcode-terminal pino
cp .env.example .env
nano .env        # pon tu número, tu clave y un API_TOKEN largo
```

## Primera ejecución (para vincular WhatsApp)
```bash
npm test         # opcional: comprueba que todo está bien (no usa WhatsApp ni internet)
npm start
```
Escanea el QR con el número del bot (WhatsApp → Dispositivos vinculados). Cuando salga
`✅ Bot financiero conectado`, escríbele desde tu número personal. Cierra con `Ctrl + C`.

## Dejarlo en segundo plano (systemd de usuario)
```bash
mkdir -p ~/.config/systemd/user
cat > ~/.config/systemd/user/bot-financiero.service <<'EOF'
[Unit]
Description=Bot financiero de WhatsApp

[Service]
WorkingDirectory=/home/roberth/bot-financiero
ExecStart=/usr/bin/node --env-file=/home/roberth/bot-financiero/.env /home/roberth/bot-financiero/bot.js
Restart=always
RestartSec=10

[Install]
WantedBy=default.target
EOF
systemctl --user daemon-reload
systemctl --user enable --now bot-financiero.service
journalctl --user -u bot-financiero.service -f
```
Ojo: **no ejecutes `npm start` mientras el servicio esté encendido** (dos copias con la misma
sesión se echan una a otra). Usa `systemctl --user stop bot-financiero.service` antes.

## Qué entiende
Texto libre (necesita la clave de IA):
- "compré aceite por 20 mil" · "me pagaron 1,5 millones" · "ayer gasté 8 lucas en bus"
- "cuánto gasté esta semana" · "qué gasté en comida este mes"
- "ponme un presupuesto de 300 mil en comida" · "me equivoqué, borra lo último"
- "¿cómo empiezo a ahorrar?" (respuestas generales, no es asesoría financiera)

Comandos (funcionan siempre, también sin IA):
```
/gasto 20000 comida almuerzo        /ingreso 1500000 salario quincena
/resumen [hoy|semana|mes|mes_pasado|anio]
/ultimos [cantidad]    /deshacer
/presupuesto comida 300000          /presupuestos
```
Categorías (editables en `categorias.js`): Comida, Transporte, Servicios, Estudio, Salud, Ocio,
Hogar, Ropa, Deudas, Ahorro, Salario, Ventas, Otros.

## API para tu página
Solo lectura, con token. Por defecto escucha en `127.0.0.1:3001` y acepta peticiones desde
`http://localhost:3000` (cámbialo con `ORIGEN_PERMITIDO`).

Todas las peticiones llevan la cabecera `Authorization: Bearer TU_API_TOKEN`.

| Ruta | Qué devuelve |
|---|---|
| `GET /api/salud` | `{ "ok": true }` |
| `GET /api/categorias` | Lista de categorías |
| `GET /api/resumen?mes=2026-10` | `{ mes, desde, hasta, ingresos, gastos, balance, porCategoria: [{categoria, total}] }` |
| `GET /api/movimientos?desde=&hasta=&tipo=&categoria=&limite=` | `[{ id, tipo, monto, categoria, descripcion, fecha }]` (más recientes primero) |
| `GET /api/presupuestos?mes=2026-10` | `[{ categoria, limite, gastado, porcentaje }]` |

Ejemplo desde tu página (Next.js, en el servidor para no exponer el token en el navegador):
```js
const res = await fetch('http://127.0.0.1:3001/api/resumen?mes=2026-10', {
  headers: { Authorization: `Bearer ${process.env.API_TOKEN}` },
});
const resumen = await res.json();
```
Los montos son pesos enteros y las fechas vienen como `AAAA-MM-DD` (hora de Bogotá).

## Privacidad y límites
- **Tus mensajes se envían a la API de Anthropic** para interpretarlos (solo el texto de cada
  mensaje, no tu historial). Si no quieres eso, deja `ANTHROPIC_API_KEY` vacío y usa comandos.
- **Solo responde a los números de `NUMEROS_PERMITIDOS`.** Si alguien más escribe, el bot lo
  ignora y deja una línea en el registro con su número.
- Los datos viven en `finanzas.db` (más `finanzas.db-wal` y `-shm` mientras corre). Para un
  respaldo, detén el bot y copia `finanzas.db`. No subas `.env`, `auth/` ni `*.db` a GitHub.
- Si el bot estuvo apagado, atiende los mensajes de hasta 3 días que WhatsApp le entregue y los
  registra con la fecha en que los escribiste.
- Es una herramienta de registro y organización. Las respuestas generales no son asesoría
  financiera.
