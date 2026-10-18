
import makeWASocket, {
  useMultiFileAuthState,
  DisconnectReason,
  fetchLatestBaileysVersion,
  normalizeMessageContent,
} from '@whiskeysockets/baileys';

import qrcode from 'qrcode-terminal';
import pino from 'pino';

import * as db from './db.js';
import { fechaBogota } from './fechas.js';
import { hayIA, interpretar, nombreProveedor } from './ia.js';
import { interpretarComando } from './comandos.js';
import { ejecutar } from './acciones.js';
import { iniciarApi } from './api.js';
import { acotarAcciones } from './politicas.js';
import { tieneDecimalConPunto } from './montos.js';

// ==========================================
// CONFIGURACIÓN
// ==========================================

// Números autorizados con indicativo de país.
// Ejemplo: 573001234567, sin + ni espacios.
const PERMITIDOS = (process.env.NUMEROS_PERMITIDOS ?? '')
  .split(',')
  .map((n) => n.replace(/\D/g, ''))
  .filter(Boolean);

const DEBUG = process.env.DEBUG === '1';
const AUTOCHAT = process.env.MODO_AUTOCHAT === '1';

const ESPERA_RECONEXION_MS = Number(
  process.env.ESPERA_RECONEXION_MS ?? 3000
);

const MAX_ANTIGUEDAD_S = 3 * 24 * 60 * 60;

const MARCA = '\u200B';

const TIPOS_MEDIA = new Set([
  'audioMessage',
  'imageMessage',
  'videoMessage',
  'documentMessage',
  'stickerMessage',
]);

const enviadosPorBot = new Set();
let remitentesNoAutorizados = 0;

// ==========================================
// COLA DE MENSAJES
// ==========================================

let cola = Promise.resolve();

function encolar(tarea) {
  cola = cola
    .then(tarea)
    .catch((e) => console.error('Error en la cola:', e));

  return cola;
}

// ==========================================
// UTILIDADES DE MENSAJES
// ==========================================

function contenidoDe(msg) {
  return normalizeMessageContent(msg.message);
}

function textoDe(msg) {
  const m = contenidoDe(msg);

  if (!m) return '';

  return m.conversation ?? m.extendedTextMessage?.text ?? '';
}

function tipoDe(msg) {
  const m = contenidoDe(msg);

  return m ? Object.keys(m)[0] : 'vacío';
}

function segundos(t) {
  if (typeof t === 'number') return t;
  if (t?.toNumber) return t.toNumber();

  return Number(t) || 0;
}

// Extrae el identificador sin el sufijo de WhatsApp.
const soloNumero = (jid) =>
  String(jid ?? '')
    .split('@')[0]
    .split(':')[0];

// ==========================================
// AUTORIZACIÓN DE USUARIOS
// ==========================================

// Devuelve un número autorizado o null.
// Nunca autoriza un LID solo por su identificador.
async function usuarioPermitido(sock, msg) {
  const candidatos = [
    msg.key.remoteJid,
    msg.key.remoteJidAlt,
    msg.key.participant,
    msg.key.participantAlt,
  ].filter(Boolean);

  // Los newsletters no son contactos personales.
  if (
    candidatos.some((jid) =>
      String(jid).endsWith('@newsletter')
    )
  ) {
    return null;
  }

  // 1. Comprobar números telefónicos explícitos.
  for (const jid of candidatos) {
    const id = String(jid);

    if (!id.endsWith('@s.whatsapp.net')) continue;

    const numero = soloNumero(id);

    if (PERMITIDOS.includes(numero)) {
      return numero;
    }
  }

  // 2. Resolver identificadores LID cuando sea posible.
  const mapping = sock.signalRepository?.lidMapping;

  if (typeof mapping?.getPNForLID !== 'function') {
    if (DEBUG) {
      console.log(
        '[debug] Baileys no expone getPNForLID en esta sesión.'
      );
    }

    return null;
  }

  for (const jid of candidatos) {
    const id = String(jid);

    if (!id.endsWith('@lid')) continue;

    // Algunas versiones pueden esperar el identificador
    // completo y otras el identificador sin el sufijo.
    const posiblesLid = [id, soloNumero(id)];

    for (const lid of posiblesLid) {
      try {
        const pn = await mapping.getPNForLID(lid);

        if (!pn) continue;

        const numero = soloNumero(pn);

        if (PERMITIDOS.includes(numero)) {
          if (DEBUG) console.log('[debug] Identidad autorizada resuelta mediante LID.');

          return numero;
        }
      } catch (error) {
        if (DEBUG) {
          console.warn('No se pudo resolver una identidad LID autorizada.');
        }
      }
    }
  }

  return null;
}

// ==========================================
// MODO CHAT CONTIGO MISMO
// ==========================================

const numerosPropios = (sock) =>
  [sock.user?.id, sock.user?.lid]
    .filter(Boolean)
    .map(soloNumero);

const esChatPropio = (sock, jid) =>
  numerosPropios(sock).includes(soloNumero(jid));

const usuarioPropio = (sock) =>
  PERMITIDOS.find((n) => numerosPropios(sock).includes(n)) ?? null;

// ==========================================
// CONTROL DE MENSAJES ENVIADOS
// ==========================================

function registrarEnviado(resultado) {
  const id = resultado?.key?.id;

  if (!id) return;

  enviadosPorBot.add(id);

  if (enviadosPorBot.size > 500) {
    enviadosPorBot.delete(
      enviadosPorBot.values().next().value
    );
  }
}

async function enviarTexto(sock, jid, texto, citado) {
  try {
    const resultado = await sock.sendMessage(
      jid,
      { text: MARCA + texto },
      citado ? { quoted: citado } : undefined
    );

    registrarEnviado(resultado);
  } catch (e) {
    console.error(
      'No se pudo enviar la respuesta:',
      e.message
    );
  }
}

// ==========================================
// PROCESAMIENTO FINANCIERO
// ==========================================

async function atender(sock, jid, msg, usuario, texto) {
  const id = msg.key.id;

  try {
    if (db.yaProcesado(id)) return;
  } catch (error) {
    console.error('No se pudo consultar el estado del mensaje:', error.message);
    await enviarTexto(sock, jid, '⚠️ La base de datos no está disponible. No repetí ni registré el movimiento.', msg);
    return;
  }

  const ts = segundos(msg.messageTimestamp);

  const hoy = ts
    ? fechaBogota(new Date(ts * 1000))
    : fechaBogota();

  let acciones = [];
  const respuestas = [];

  try {
    const comando = texto.startsWith('/')
      ? interpretarComando(texto)
      : null;

    if (comando?.respuesta) {
      respuestas.push(comando.respuesta);
    } else if (comando) {
      acciones = comando.acciones;
    } else if (texto.startsWith('/')) {
      respuestas.push(
        'No conozco ese comando. Escribe /ayuda para ver los disponibles.'
      );
    } else if (hayIA()) {
      const r = await interpretar(texto, hoy);

      acciones = r.acciones;

      if (r.texto) {
        respuestas.push(r.texto);
      }
    } else {
      respuestas.push(
        'La IA no está configurada todavía. Mientras tanto usa comandos, por ejemplo:\n' +
        '/gasto 20000 comida almuerzo\n\n' +
        'Escribe /ayuda para ver más.'
      );
    }
  } catch (e) {
    console.error(
      'Error al interpretar el mensaje:',
      e.message
    );

    respuestas.push(
      '😕 No pude entender el mensaje ahora mismo. ' +
      'Intenta de nuevo o usa un comando, por ejemplo:\n' +
      '/gasto 20000 comida almuerzo'
    );
  }

  if (
    !texto.startsWith('/') &&
    tieneDecimalConPunto(texto) &&
    Array.isArray(acciones) &&
    acciones.some((accion) => ['registrar_movimiento', 'fijar_presupuesto'].includes(accion?.nombre))
  ) {
    acciones = [];
    respuestas.push('⚠️ No pude interpretar el punto decimal con seguridad. Usa coma para decimales y punto solo para grupos de miles, por ejemplo 20.500.');
  }

  const acotadas = acotarAcciones(acciones);
  const efectos = [];
  try {
    const procesado = db.enTransaccion(() => {
      // Revisa dentro del bloqueo de escritura para cubrir dos instancias del bot.
      if (db.yaProcesado(id)) return false;
      acotadas.forEach((accion, indice) => {
        const r = ejecutar(accion, { usuario, hoy, mensajeId: id, indice, efectos });
        if (r) respuestas.push(r);
      });
      if (acotadas.length < acciones.length) {
        respuestas.push('⚠️ Procesé solo las primeras 5 acciones de este mensaje.');
      }
      db.marcarProcesado(id);
      return true;
    });
    if (!procesado) return;
    efectos.forEach((efecto) => efecto());
  } catch (error) {
    console.error('No se pudo completar el mensaje de forma atómica:', error.message);
    respuestas.length = 0;
    respuestas.push('⚠️ No pude completar este mensaje; no guardé cambios parciales. Puedes volver a intentarlo.');
  }

  if (respuestas.length === 0) {
    respuestas.push(
      '🤔 No encontré nada para registrar. ' +
      'Cuéntame un gasto o ingreso, por ejemplo: ' +
      '"compré aceite por 20 mil".'
    );
  }

  await enviarTexto(
    sock,
    jid,
    respuestas.join('\n\n'),
    msg
  );
}

// ==========================================
// MENSAJES SIN TEXTO
// ==========================================

async function responderSinTexto(sock, jid, msg) {
  const procesado = db.enTransaccion(() => {
    if (db.yaProcesado(msg.key.id)) return false;
    db.marcarProcesado(msg.key.id);
    return true;
  });
  if (!procesado) return;

  await enviarTexto(
    sock,
    jid,
    'Por ahora solo entiendo mensajes de texto. ' +
    'Escríbeme el gasto o ingreso, por ejemplo: ' +
    '"compré aceite por 20 mil".',
    msg
  );
}

// ==========================================
// RECONEXIÓN
// ==========================================

let reconectando = false;
let cerrando = false;
let socketActivo = null;
let autorizacionesEnCurso = 0;

function reconectar(motivo) {
  if (reconectando || cerrando) return;

  reconectando = true;

  console.log(
    `${motivo} Reintentando en ${ESPERA_RECONEXION_MS / 1000} s...`
  );

  setTimeout(() => {
    reconectando = false;

    iniciar().catch((e) =>
      console.error('Error al reconectar:', e)
    );
  }, ESPERA_RECONEXION_MS);
}

// ==========================================
// INICIAR WHATSAPP
// ==========================================

async function iniciar() {
  const { state, saveCreds } =
    await useMultiFileAuthState('auth');

  const { version } = await fetchLatestBaileysVersion();

  const sock = makeWASocket({
    version,
    auth: state,
    logger: pino({ level: 'silent' }),
  });
  socketActivo = sock;

  sock.ev.on('creds.update', saveCreds);

  sock.ev.on(
    'connection.update',
    ({ connection, lastDisconnect, qr }) => {
      if (qr) {
        console.log(
          'Escanea este QR desde WhatsApp > Dispositivos vinculados:'
        );

        qrcode.generate(qr, { small: true });
      }

      if (connection === 'open') {
        console.log('✅ Bot financiero conectado.');
      }

      if (connection === 'close') {
        const codigo =
          lastDisconnect?.error?.output?.statusCode;

        if (codigo === DisconnectReason.loggedOut) {
          console.log(
            'Sesión cerrada. Borra la carpeta "auth" y vuelve a iniciar el bot.'
          );
          void apagar('sesión cerrada').then(() => {
            process.exitCode = 2;
            process.exit(2);
          });
        } else if (
          codigo === DisconnectReason.connectionReplaced
        ) {
          console.error(
            '⚠️ Otra copia del bot está usando esta misma sesión. ' +
            'Ciérrala con ayuda de: pgrep -af bot.js'
          );

          void apagar('sesión reemplazada').then(() => {
            process.exitCode = 2;
            process.exit(2);
          });
        } else {
          reconectar(
            `Conexión perdida (código ${codigo ?? 'desconocido'}).`
          );
        }
      }
    }
  );

  // ==========================================
  // RECIBIR MENSAJES
  // ==========================================

  sock.ev.on(
    'messages.upsert',
    async ({ messages, type }) => {
      if (cerrando) return;
      if (DEBUG) {
        console.log(
          `[debug] messages.upsert tipo=${type} cantidad=${messages.length}`
        );
      }

      if (type !== 'notify' && type !== 'append') return;

      for (const msg of messages) {
        if (!msg.message) continue;

        const jid = msg.key.remoteJid;

        // Ignorar estados, grupos y newsletters.
        if (
          !jid ||
          jid === 'status@broadcast' ||
          jid.endsWith('@g.us') ||
          jid.endsWith('@newsletter')
        ) {
          continue;
        }

        // Ignorar ecos de mensajes enviados por el bot.
        if (enviadosPorBot.has(msg.key.id)) continue;

        const crudo = textoDe(msg);

        if (crudo.startsWith(MARCA)) continue;

        const texto = crudo.trim();

        let usuario;

        if (msg.key.fromMe) {
          // Solo permite utilizar el chat propio si está activado.
          if (!AUTOCHAT || !esChatPropio(sock, jid)) {
            if (DEBUG) {
              console.log('[debug] Mensaje propio ignorado por configuración.');
            }

            continue;
          }

          usuario = usuarioPropio(sock);

          if (!usuario) {
            console.log('El número del chat propio no está en NUMEROS_PERMITIDOS.');

            continue;
          }
        } else {
          // Verificar autorización antes de procesar el mensaje.
          autorizacionesEnCurso++;
          try {
            usuario = await usuarioPermitido(sock, msg);
          } finally {
            autorizacionesEnCurso--;
          }

          // El cierre pudo empezar mientras se resolvía el identificador.
          if (cerrando) return;

          if (!usuario) {
            remitentesNoAutorizados++;
            if (remitentesNoAutorizados === 1 || remitentesNoAutorizados % 10 === 0) {
              console.warn(`Mensajes no autorizados ignorados: ${remitentesNoAutorizados}.`);
            }

            continue;
          }
        }

        if (DEBUG) {
          console.log(`[debug] Mensaje autorizado (tipo ${tipoDe(msg)}).`);
        }

        const ts = segundos(msg.messageTimestamp);

        if (
          type === 'append' &&
          ts &&
          Date.now() / 1000 - ts > MAX_ANTIGUEDAD_S
        ) {
          continue;
        }

        if (!texto) {
          const tipo = tipoDe(msg);

            console.log(`Mensaje sin texto (${tipo}) ignorado.`);

          if (TIPOS_MEDIA.has(tipo)) {
            encolar(() =>
              responderSinTexto(sock, jid, msg)
            );
          }

          continue;
        }

        encolar(() =>
          atender(sock, jid, msg, usuario, texto)
        );
      }
    }
  );
}

// ==========================================
// VALIDAR CONFIGURACIÓN
// ==========================================

if (PERMITIDOS.length === 0) {
  console.warn(
    '⚠️ NUMEROS_PERMITIDOS está vacío. ' +
    'Revisa tu archivo .env.'
  );
} else {
  console.log(
    `Números autorizados configurados: ${PERMITIDOS.length}` +
    `${AUTOCHAT ? ' (modo chat contigo mismo activado)' : ''}`
  );
}

if (PERMITIDOS.includes('573001234567')) {
  console.warn(
    '⚠️ NUMEROS_PERMITIDOS contiene el número de ejemplo ' +
    '573001234567. Cámbialo por tu número real.'
  );
}

if (hayIA()) {
  console.log(
    `IA: ${nombreProveedor()} ` +
    `(modelo: ${process.env.MODELO_GEMINI ?? process.env.MODELO_ANTHROPIC ?? process.env.MODELO_IA ?? 'por defecto'})`
  );
} else {
  console.warn(
    'ℹ️ Sin GEMINI_API_KEY ni ANTHROPIC_API_KEY: ' +
    'solo funcionarán los comandos. Escribe /ayuda.'
  );
}

// ==========================================
// INICIAR SERVICIOS
// ==========================================

const servidorApi = iniciarApi(PERMITIDOS[0]);

async function apagar(signal) {
  if (cerrando) return;
  cerrando = true;
  console.log(`Cierre solicitado (${signal}); guardando y cerrando SQLite.`);
  try { socketActivo?.end(new Error('Cierre solicitado')); } catch {}
  // Eventos que ya estaban resolviendo la identidad pueden encolar trabajo
  // después de que el socket se cierre.
  while (autorizacionesEnCurso > 0) {
    await new Promise((resolve) => setImmediate(resolve));
  }
  // Deja que termine el trabajo ya encolado antes de cerrar la conexión SQLite.
  await cola;
  if (servidorApi?.listening) {
    await new Promise((resolve) => servidorApi.close(resolve));
  }
  try { db.cerrarBase(); } catch (error) {
    console.error('No se pudo cerrar SQLite limpiamente:', error.message);
    process.exitCode = 1;
  }
}

process.once('SIGINT', () => { void apagar('SIGINT'); });
process.once('SIGTERM', () => { void apagar('SIGTERM'); });

iniciar().catch((e) => {
  console.error('No se pudo iniciar el bot:', e);
  void apagar('error al iniciar').then(() => {
    process.exitCode = 1;
    process.exit(1);
  });
});
