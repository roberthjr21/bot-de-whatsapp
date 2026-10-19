// Ejecutar con:  npm test      (no usa WhatsApp ni internet: la IA y la base de datos son simuladas)
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { after } from 'node:test';
import { DatabaseSync } from 'node:sqlite';
import { Worker } from 'node:worker_threads';

const temporal = fs.mkdtempSync(path.join(os.tmpdir(), 'bot-financiero-test-'));
process.env.DB_ARCHIVO = path.join(temporal, 'pruebas.db');
process.env.API_TOKEN = 'secreto-de-prueba';
process.env.API_PUERTO = '0';
process.env.ANTHROPIC_API_KEY = 'clave-falsa';
for (const variable of ['GEMINI_API_KEY', 'GEMINI_URL', 'ANTHROPIC_URL', 'MODELO_IA', 'MODELO_GEMINI', 'MODELO_ANTHROPIC']) {
  delete process.env[variable];
}

const db = await import('./db.js');
const { ejecutar } = await import('./acciones.js');
const { interpretarComando } = await import('./comandos.js');
const { interpretar } = await import('./ia.js');
const { crearServidorApi } = await import('./api.js');
const { pesos, rangoPeriodo, rangoMes, valida } = await import('./fechas.js');
const { parseMonto, tieneDecimalConPunto } = await import('./montos.js');
const { acotarAcciones } = await import('./politicas.js');
const { crearRespaldo, restaurarRespaldo } = await import('./db-admin.js');

after(() => {
  db.cerrarBase();
  fs.rmSync(temporal, { recursive: true, force: true });
});

const U = '573001234567';
const HOY = '2026-10-17'; // sábado

const reg = (datos, i = 0, id = 'm') => ejecutar({ nombre: 'registrar_movimiento', datos }, { usuario: U, hoy: HOY, mensajeId: id, indice: i });

test('fechas y formato de pesos', () => {
  assert.equal(pesos(20000), '$20.000');
  assert.equal(pesos(1500000), '$1.500.000');
  assert.equal(pesos(-5000), '-$5.000');
  assert.deepEqual(rangoPeriodo('semana', HOY), { desde: '2026-10-12', hasta: HOY, titulo: 'esta semana' }); // lunes
  assert.equal(rangoPeriodo('mes', HOY).desde, '2026-10-01');
  assert.equal(rangoPeriodo('mes_pasado', HOY).desde, '2026-09-01');
  assert.equal(rangoPeriodo('mes_pasado', HOY).hasta, '2026-09-30');
  assert.equal(rangoPeriodo('mes_pasado', '2026-01-15').desde, '2025-12-01');
  assert.deepEqual(rangoMes('2024-02'), { desde: '2024-02-01', hasta: '2024-02-29' });
  assert.ok(valida('2026-10-17'));
  assert.ok(!valida('2026-02-30'));
  assert.ok(!valida('ayer'));
});

test('comandos: /gasto, /ingreso y errores', () => {
  const g = interpretarComando('/gasto 20.000 comida almuerzo con Ana');
  assert.deepEqual(g.acciones[0].datos, { tipo: 'gasto', monto: 20000, categoria: 'Comida', descripcion: 'almuerzo con Ana' });
  const sinCategoria = interpretarComando('/gasto 15k bus al centro');
  assert.equal(sinCategoria.acciones[0].datos.monto, 15000);
  assert.equal(sinCategoria.acciones[0].datos.categoria, 'Otros');
  assert.equal(sinCategoria.acciones[0].datos.descripcion, 'bus al centro');
  assert.equal(interpretarComando('/ingreso 1500000 salario quincena').acciones[0].datos.tipo, 'ingreso');
  assert.match(interpretarComando('/gasto mucho').respuesta, /Usa: \/gasto/);
  assert.equal(interpretarComando('/inventado'), null);
  assert.equal(interpretarComando('/resumen año').acciones[0].datos.periodo, 'anio');
  assert.equal(interpretarComando('/gasto 20 mil comida almuerzo').acciones[0].datos.monto, 20000);
  assert.equal(interpretarComando('/gasto 8 lucas bus').acciones[0].datos.monto, 8000);
  assert.equal(interpretarComando('/gasto 20.5 comida').respuesta.includes('Usa:'), true);
  assert.equal(interpretarComando('/gasto 99999999999999999999 comida').respuesta.includes('Usa:'), true);
  assert.equal(parseMonto('1,5'), 2);
  assert.equal(parseMonto('1,5 millones'), 1500000);
  assert.equal(parseMonto('0,000001 millones'), 1);
  assert.equal(parseMonto('0,0000005 millones'), 1);
  assert.equal(parseMonto('0,0000004 millones'), null);
  assert.equal(parseMonto('2,675'), 3);
  assert.equal(parseMonto('20.000'), 20000);
  assert.equal(parseMonto('20.5'), null);
  assert.equal(tieneDecimalConPunto('pagué 20.5 por el almuerzo'), true);
  assert.equal(tieneDecimalConPunto('pagué $20.5 por el almuerzo.'), true);
  assert.equal(tieneDecimalConPunto('pagué 20.500 por el almuerzo'), false);
});

test('las acciones tienen límite por mensaje y una sola acción destructiva', () => {
  const lote = [
    { nombre: 'deshacer_ultimo' },
    { nombre: 'deshacer_ultimo' },
    { nombre: 'consultar_resumen' },
    { nombre: 'fijar_presupuesto' },
    { nombre: 'ver_presupuestos' },
    { nombre: 'ultimos_movimientos' },
  ];
  const resultado = acotarAcciones(lote);
  assert.equal(resultado.length, 4);
  assert.equal(resultado.filter((a) => a.nombre === 'deshacer_ultimo').length, 1);
  assert.deepEqual(acotarAcciones(null), []);
});

test('registrar movimientos y evitar duplicados', () => {
  const r = reg({ tipo: 'gasto', monto: 20000, categoria: 'Comida', descripcion: 'almuerzo' }, 0, 'msg1');
  assert.match(r, /Gasto registrado: \$20\.000 en Comida \(almuerzo\)/);
  assert.equal(reg({ tipo: 'gasto', monto: 20000, categoria: 'Comida', descripcion: 'almuerzo' }, 0, 'msg1'), null); // mismo mensaje
  assert.match(reg({ tipo: 'ingreso', monto: 1500000, categoria: 'Salario', descripcion: 'quincena' }, 0, 'msg2'), /Ingreso registrado: \$1\.500\.000/);
  assert.match(reg({ tipo: 'gasto', monto: 12000, categoria: 'Inventada', descripcion: '' }, 0, 'msg3'), /No entendí/);
  assert.match(reg({ tipo: 'gasto', monto: -5, categoria: 'Comida' }, 0, 'msg4'), /No entendí/);
  assert.match(reg({ tipo: 'gasto', monto: 8000, categoria: 'Transporte', descripcion: 'bus', fecha: '2026-10-15' }, 0, 'msg5'), /2026-10-15/);
  // fecha futura o inválida: se usa la del mensaje
  assert.doesNotMatch(reg({ tipo: 'gasto', monto: 1000, categoria: 'Otros', descripcion: 'x', fecha: '2027-01-01' }, 0, 'msg6'), /2027/);
  assert.match(reg({ tipo: 'gasto', monto: true, categoria: 'Otros' }, 0, 'msg7'), /No entendí/);
  assert.match(reg({ tipo: 'gasto', monto: 1e12, categoria: 'Otros' }, 0, 'msg8'), /No entendí/);
  assert.match(reg({ tipo: 'transferencia', monto: 100, categoria: 'Otros' }, 0, 'msg9'), /No entendí/);
});

test('las restricciones financieras rechazan datos inválidos y solo se ignora un mensaje duplicado', () => {
  assert.equal(db.agregarMovimiento({ usuario: 'restricciones', tipo: 'gasto', monto: 100, categoria: 'Otros', fecha: HOY, mensajeId: 'restriccion-dup' }) !== null, true);
  assert.equal(db.agregarMovimiento({ usuario: 'restricciones', tipo: 'gasto', monto: 100, categoria: 'Otros', fecha: HOY, mensajeId: 'restriccion-dup' }), null);
  assert.throws(() => db.agregarMovimiento({ usuario: 'restricciones', tipo: 'transferencia', monto: 100, categoria: 'Otros', fecha: HOY, mensajeId: 'restriccion-tipo' }));
  assert.throws(() => db.agregarMovimiento({ usuario: 'restricciones', tipo: 'gasto', monto: 0, categoria: 'Otros', fecha: HOY, mensajeId: 'restriccion-monto' }));
});

test('SQLite crea el esquema, conserva importes enteros y aísla usuarios', () => {
  assert.deepEqual(db.configuracionSQLite(), { journal_mode: 'wal', busy_timeout: 5000 });
  const conexion = new DatabaseSync(process.env.DB_ARCHIVO, { readOnly: true });
  try {
    assert.equal(conexion.prepare('PRAGMA journal_mode').get().journal_mode, 'wal');
    const tablas = new Set(conexion.prepare("SELECT name FROM sqlite_master WHERE type='table'").all().map((r) => r.name));
    assert.deepEqual([...['movimientos', 'presupuestos', 'procesados'].filter((tabla) => tablas.has(tabla))], ['movimientos', 'presupuestos', 'procesados']);
  } finally { conexion.close(); }

  const id = db.agregarMovimiento({ usuario: 'cuenta-a', tipo: 'ingreso', monto: 987654, categoria: 'Salario', fecha: HOY, mensajeId: 'aislamiento-a' });
  assert.ok(id);
  assert.equal(db.listarMovimientos({ usuario: 'cuenta-a' }).find((m) => m.id === id).monto, 987654);
  assert.equal(db.listarMovimientos({ usuario: 'cuenta-b' }).some((m) => m.id === id), false);
  assert.equal(db.resumen('cuenta-b', HOY, HOY).ingresos, 0);
  db.fijarPresupuesto('cuenta-a', 'Comida', 50000);
  assert.equal(db.presupuestoDe('cuenta-b', 'Comida'), null);
  assert.equal(db.borrarMovimiento('cuenta-b', id), null);
  assert.equal(db.borrarMovimiento('cuenta-a', id).monto, 987654);
});

test('las acciones y la marca de procesado se revierten juntas ante fallo', () => {
  assert.throws(() => db.enTransaccion(() => {
    db.agregarMovimiento({ usuario: 'rollback', tipo: 'gasto', monto: 100, categoria: 'Otros', fecha: HOY, mensajeId: 'rollback:0' });
    db.marcarProcesado('rollback-msg');
    throw new Error('fallo simulado');
  }), /fallo simulado/);
  assert.deepEqual(db.listarMovimientos({ usuario: 'rollback' }), []);
  assert.equal(db.yaProcesado('rollback-msg'), false);
});

test('conexiones concurrentes escriben sin perder filas', async () => {
  const archivo = path.join(temporal, 'concurrencia.db');
  const inicial = new DatabaseSync(archivo);
  inicial.exec('PRAGMA journal_mode=WAL; CREATE TABLE operaciones (id INTEGER PRIMARY KEY, escritor INTEGER NOT NULL, valor INTEGER NOT NULL);');
  inicial.close();
  const codigo = `const { parentPort, workerData } = require('node:worker_threads'); const { DatabaseSync } = require('node:sqlite'); const db = new DatabaseSync(workerData.archivo); db.exec('PRAGMA busy_timeout=5000'); const ins = db.prepare('INSERT INTO operaciones(escritor, valor) VALUES (?, ?)'); for (let i=0;i<100;i++) ins.run(workerData.escritor, i); db.close(); parentPort.postMessage('ok');`;
  await Promise.all(Array.from({ length: 4 }, (_, escritor) => new Promise((resolve, reject) => {
    const worker = new Worker(codigo, { eval: true, workerData: { archivo, escritor }, execArgv: [] });
    worker.once('message', resolve);
    worker.once('error', reject);
    worker.once('exit', (code) => { if (code !== 0) reject(new Error(`worker terminó con código ${code}`)); });
  })));
  const verificacion = new DatabaseSync(archivo, { readOnly: true });
  try {
    assert.equal(verificacion.prepare('SELECT count(*) AS total FROM operaciones').get().total, 400);
    assert.equal(verificacion.prepare('PRAGMA integrity_check').get().integrity_check, 'ok');
  } finally { verificacion.close(); }
});

test('resumen del periodo y por categoría', () => {
  const texto = ejecutar({ nombre: 'consultar_resumen', datos: { periodo: 'mes' } }, { usuario: U, hoy: HOY });
  assert.match(texto, /Ingresos: \$1\.500\.000/);
  assert.match(texto, /Gastos: \$29\.000/); // 20.000 + 8.000 + 1.000; categoría inválida rechazada
  assert.match(texto, /• Comida: \$20\.000/);
  const vacio = ejecutar({ nombre: 'consultar_resumen', datos: { periodo: 'mes_pasado' } }, { usuario: U, hoy: HOY });
  assert.match(vacio, /No tienes movimientos/);
});

test('presupuestos con alertas al 80% y al pasarse', () => {
  assert.match(ejecutar({ nombre: 'fijar_presupuesto', datos: { categoria: 'Ocio', limite_mensual: 100000 } }, { usuario: U, hoy: HOY }), /\$100\.000/);
  assert.doesNotMatch(reg({ tipo: 'gasto', monto: 50000, categoria: 'Ocio', descripcion: 'cine' }, 0, 'o1'), /⚠️|🚨/);
  assert.match(reg({ tipo: 'gasto', monto: 35000, categoria: 'Ocio', descripcion: 'salida' }, 0, 'o2'), /⚠️ Llevas el 85%/);
  assert.match(reg({ tipo: 'gasto', monto: 30000, categoria: 'Ocio', descripcion: 'juego' }, 0, 'o3'), /🚨 Te pasaste/);
  assert.match(ejecutar({ nombre: 'ver_presupuestos', datos: {} }, { usuario: U, hoy: HOY }), /Ocio: \$115\.000 de \$100\.000 \(115%\)/);
  assert.match(ejecutar({ nombre: 'fijar_presupuesto', datos: { categoria: 'Ocio', limite_mensual: 1e12 } }, { usuario: U, hoy: HOY }), /Dime la categoría/);
});

test('últimos movimientos y deshacer con confirmación', () => {
  const ultimos = ejecutar({ nombre: 'ultimos_movimientos', datos: { cantidad: 2 } }, { usuario: U, hoy: HOY });
  assert.equal(ultimos.split('\n').length, 3);
  assert.match(ejecutar({ nombre: 'deshacer_ultimo', datos: {} }, { usuario: U, hoy: HOY }), /\/deshacer confirmar/);
  assert.match(ejecutar({ nombre: 'confirmar_deshacer', datos: {} }, { usuario: U, hoy: HOY }), /Borré el movimiento confirmado/);
  ejecutar({ nombre: 'deshacer_ultimo', datos: {} }, { usuario: U, hoy: HOY });
  assert.match(ejecutar({ nombre: 'cancelar_deshacer', datos: {} }, { usuario: U, hoy: HOY }), /cancelé/);
  assert.match(ejecutar({ nombre: 'confirmar_deshacer', datos: {} }, { usuario: U, hoy: HOY }), /No hay un borrado pendiente/);
  assert.match(ejecutar({ nombre: 'deshacer_ultimo', datos: {} }, { usuario: 'otro' }), /No hay movimientos/);
});

test('respaldo y restauración conservan datos en WAL sin sobrescribir', () => {
  const origen = path.join(temporal, 'wal-origen.db');
  const respaldo = path.join(temporal, 'respaldo.db');
  const restaurada = path.join(temporal, 'restaurada.db');
  const origenDb = new DatabaseSync(origen);
  origenDb.exec("PRAGMA journal_mode=WAL; CREATE TABLE movimientos (id INTEGER PRIMARY KEY AUTOINCREMENT, usuario TEXT NOT NULL, tipo TEXT NOT NULL CHECK(tipo IN ('gasto','ingreso')), monto INTEGER NOT NULL CHECK(monto > 0), categoria TEXT NOT NULL, descripcion TEXT NOT NULL DEFAULT '', fecha TEXT NOT NULL, creado TEXT NOT NULL DEFAULT (datetime('now')), mensaje_id TEXT UNIQUE); CREATE INDEX idx_mov_usuario_fecha ON movimientos(usuario,fecha); CREATE TABLE presupuestos (usuario TEXT NOT NULL, categoria TEXT NOT NULL, limite INTEGER NOT NULL CHECK(limite > 0), PRIMARY KEY(usuario,categoria)); CREATE TABLE procesados (id TEXT PRIMARY KEY, creado TEXT NOT NULL DEFAULT (datetime('now')));");
  const insertar = origenDb.prepare('INSERT INTO movimientos (usuario, tipo, monto, categoria, fecha) VALUES (?, ?, ?, ?, ?)');
  for (let i = 1; i <= 100; i++) insertar.run('prueba', 'gasto', i, 'Otros', '2026-01-01');
  assert.throws(() => restaurarRespaldo(origen, path.join(temporal, 'restauracion-insegura.db')), /WAL\/SHM/);
  crearRespaldo(origen, respaldo);
  assert.equal(fs.statSync(respaldo).mode & 0o777, 0o600);
  origenDb.close();
  restaurarRespaldo(respaldo, restaurada);
  assert.equal(fs.statSync(restaurada).mode & 0o777, 0o600);
  const restauradaDb = new DatabaseSync(restaurada, { readOnly: true });
  assert.equal(restauradaDb.prepare('SELECT count(*) AS n FROM movimientos').get().n, 100);
  restauradaDb.close();
  const restauradaReabierta = new DatabaseSync(restaurada, { readOnly: true });
  assert.equal(restauradaReabierta.prepare('SELECT count(*) AS n FROM movimientos').get().n, 100);
  restauradaReabierta.close();
  const integridadDb = new DatabaseSync(restaurada, { readOnly: true });
  assert.equal(integridadDb.prepare('PRAGMA integrity_check').get().integrity_check, 'ok');
  integridadDb.close();
  assert.throws(() => restaurarRespaldo(respaldo, restaurada), /ya existe/);
});

test('respaldo y restauración rechazan archivos corruptos y limpian ante errores de permiso', () => {
  const corrupta = path.join(temporal, 'corrupta.db');
  const destino = path.join(temporal, 'corrupta-restaurada.db');
  fs.writeFileSync(corrupta, 'esto no es una base SQLite');
  assert.throws(() => crearRespaldo(corrupta, path.join(temporal, 'respaldo-corrupto.db')));
  assert.throws(() => restaurarRespaldo(corrupta, destino));
  const incompatible = path.join(temporal, 'esquema-incompatible.db');
  const incompatibleDb = new DatabaseSync(incompatible);
  incompatibleDb.exec('CREATE TABLE movimientos (id INTEGER); CREATE TABLE presupuestos (id INTEGER); CREATE TABLE procesados (id INTEGER);');
  incompatibleDb.close();
  assert.throws(() => restaurarRespaldo(incompatible, path.join(temporal, 'incompatible-restaurada.db')), /Esquema incompatible/);
  const respaldoDenegado = path.join(temporal, 'respaldo-denegado.db');
  const restauracionDenegada = path.join(temporal, 'restauracion-denegada.db');
  const fuenteIndependiente = path.join(temporal, 'fuente-independiente.db');
  const fuenteDb = new DatabaseSync(fuenteIndependiente);
  fuenteDb.exec("CREATE TABLE movimientos (id INTEGER PRIMARY KEY AUTOINCREMENT, usuario TEXT NOT NULL, tipo TEXT NOT NULL CHECK(tipo IN ('gasto','ingreso')), monto INTEGER NOT NULL CHECK(monto > 0), categoria TEXT NOT NULL, descripcion TEXT NOT NULL DEFAULT '', fecha TEXT NOT NULL, creado TEXT NOT NULL DEFAULT (datetime('now')), mensaje_id TEXT UNIQUE); CREATE INDEX idx_mov_usuario_fecha ON movimientos(usuario,fecha); CREATE TABLE presupuestos (usuario TEXT NOT NULL, categoria TEXT NOT NULL, limite INTEGER NOT NULL CHECK(limite > 0), PRIMARY KEY(usuario,categoria)); CREATE TABLE procesados (id TEXT PRIMARY KEY, creado TEXT NOT NULL DEFAULT (datetime('now')));");
  fuenteDb.close();
  const linkOriginal = fs.linkSync;
  fs.linkSync = () => { const error = new Error('permiso denegado simulado'); error.code = 'EACCES'; throw error; };
  try {
    assert.throws(() => crearRespaldo(process.env.DB_ARCHIVO, respaldoDenegado), { code: 'EACCES' });
    assert.throws(() => restaurarRespaldo(fuenteIndependiente, restauracionDenegada), { code: 'EACCES' });
  } finally { fs.linkSync = linkOriginal; }
  assert.equal(fs.existsSync(respaldoDenegado), false);
  assert.equal(fs.existsSync(restauracionDenegada), false);
});

test('restauración conserva datos al cerrar y volver a abrir SQLite', () => {
  const archivo = path.join(temporal, 'persistencia.db');
  const primera = new DatabaseSync(archivo);
  primera.exec('CREATE TABLE prueba (valor INTEGER NOT NULL); INSERT INTO prueba VALUES (42);');
  primera.close();
  const segunda = new DatabaseSync(archivo, { readOnly: true });
  try { assert.equal(segunda.prepare('SELECT valor FROM prueba').get().valor, 42); }
  finally { segunda.close(); }
});

test('los datos de cada persona están separados', () => {
  const otro = ejecutar({ nombre: 'consultar_resumen', datos: { periodo: 'mes' } }, { usuario: 'otra-persona', hoy: HOY });
  assert.match(otro, /No tienes movimientos/);
});

test('IA simulada: interpreta varias herramientas en un mensaje', async () => {
  let recibido;
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async (_url, opciones) => {
    recibido = { cabeceras: opciones.headers, cuerpo: JSON.parse(opciones.body) };
    return new Response(JSON.stringify({
        content: [
          { type: 'text', text: 'Listo, anoté los dos.' },
          { type: 'tool_use', id: 'a', name: 'registrar_movimiento', input: { tipo: 'gasto', monto: 5000, categoria: 'Transporte', descripcion: 'bus' } },
          { type: 'tool_use', id: 'b', name: 'registrar_movimiento', input: { tipo: 'gasto', monto: 12000, categoria: 'Comida', descripcion: 'almuerzo' } },
        ],
      }), { status: 200, headers: { 'content-type': 'application/json' } });
  };
  try {
    const { interpretar: interpretarConUrl } = await import('./ia.js?respuesta-falsa');
    const r = await interpretarConUrl('bus 5 mil y almuerzo 12 mil', HOY);

    assert.equal(r.acciones.length, 2);
    assert.equal(r.acciones[1].datos.monto, 12000);
    assert.equal(r.texto, 'Listo, anoté los dos.');
    assert.equal(recibido.cabeceras['x-api-key'], 'clave-falsa');
    assert.equal(recibido.cuerpo.tools.length, 6);
    assert.match(recibido.cuerpo.system, /Hoy es 2026-10-17/);
    assert.equal(typeof interpretar, 'function');
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test('IA simulada: un error de la API se propaga con un mensaje claro', async () => {
  const originalFetch = globalThis.fetch;
  let intentos = 0;
  globalThis.fetch = async () => { intentos++; return new Response('sobrecargada', { status: 529 }); };
  try {
    const { interpretar: otra } = await import('./ia.js?respuesta-caida');
    await assert.rejects(() => otra('hola', HOY), /API 529/);
    assert.equal(intentos, 2);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test('IA simulada: Gemini usa su modelo y sus herramientas sin salir a internet', async () => {
  const originalFetch = globalThis.fetch;
  process.env.GEMINI_API_KEY = 'clave-falsa-gemini';
  process.env.MODELO_GEMINI = 'modelo-prueba';
  let recibido;
  globalThis.fetch = async (url, opciones) => {
    recibido = { url, opciones };
    return new Response(JSON.stringify({ candidates: [{ content: { parts: [
      { functionCall: { name: 'registrar_movimiento', args: { tipo: 'gasto', monto: 8000, categoria: 'Transporte' } } },
    ] } }] }), { status: 200, headers: { 'content-type': 'application/json' } });
  };
  try {
    const r = await interpretar('8 lucas en bus', HOY);
    assert.equal(r.acciones[0].datos.monto, 8000);
    assert.equal(recibido.opciones.headers['x-goog-api-key'], 'clave-falsa-gemini');
    assert.match(recibido.url, /modelo-prueba/);
  } finally {
    delete process.env.GEMINI_API_KEY;
    delete process.env.MODELO_GEMINI;
    globalThis.fetch = originalFetch;
  }
});

test('API para la página: token, resumen, movimientos y presupuestos', async () => {
  const servidor = crearServidorApi(U);
  const solicitar = (url, { method = 'GET', headers = {} } = {}) => {
    const req = { method, url, headers };
    const res = {
      headersSent: false,
      writeHead(status, cabeceras) { this.statusCode = status; this.headers = cabeceras; this.headersSent = true; },
      end(body = '') { this.body = body; },
    };
    servidor.emit('request', req, res);
    return { status: res.statusCode, headers: res.headers, json: res.body ? JSON.parse(res.body) : undefined };
  };
  const con = { headers: { authorization: 'Bearer secreto-de-prueba' } };

  assert.equal(solicitar('/api/salud').status, 401);
  assert.equal(solicitar('/api/salud', { headers: { authorization: 'Bearer malo' } }).status, 401);
  assert.equal(solicitar('/api/salud', con).status, 200);

  const resumen = solicitar('/api/resumen?mes=2026-10', con).json;
  assert.equal(resumen.ingresos, 1500000);
  assert.ok(resumen.gastos > 0 && Array.isArray(resumen.porCategoria));
  assert.deepEqual(solicitar('/api/resumen?mes=2026-10&usuario=otra-persona', con).json, resumen);

  const movs = solicitar('/api/movimientos?tipo=gasto&categoria=Ocio', con).json;
  assert.ok(movs.length >= 2 && movs.every((m) => m.categoria === 'Ocio' && m.tipo === 'gasto'));

  assert.equal(solicitar('/api/movimientos?desde=ayer', con).status, 400);
  assert.equal(solicitar('/api/resumen?mes=octubre', con).status, 400);
  assert.equal(solicitar('/api/resumen?mes=0000-01', con).status, 400);
  assert.equal(solicitar('/api/categorias?mes=abc', con).status, 200);
  assert.equal(solicitar('/api/nada', con).status, 404);

  const pagina1 = solicitar('/api/movimientos?limite=1&offset=0', con).json;
  const pagina2 = solicitar('/api/movimientos?limite=1&offset=1', con).json;
  assert.equal(pagina1.length, 1);
  assert.equal(pagina2.length, 1);
  assert.notEqual(pagina1[0].id, pagina2[0].id);
  assert.equal(solicitar('/api/movimientos?offset=-1', con).status, 400);

  const presu = solicitar('/api/presupuestos?mes=2026-10', con).json;
  assert.equal(presu[0].categoria, 'Ocio');

  const preflight = solicitar('/api/resumen', { method: 'OPTIONS' });
  assert.equal(preflight.status, 204);
  assert.equal(preflight.headers['Access-Control-Allow-Origin'], 'http://localhost:3000');
  assert.equal(solicitar('/api/salud', { method: 'POST', ...con }).status, 405);
  assert.equal(solicitar('/api/salud', { headers: { ...con.headers, origin: 'https://malicioso.example' } }).status, 403);
});
