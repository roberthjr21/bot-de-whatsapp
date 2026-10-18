// Ejecutar con:  npm test      (no usa WhatsApp ni internet: la IA y la base de datos son simuladas)
import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';

process.env.DB_ARCHIVO = ':memory:';
process.env.API_TOKEN = 'secreto-de-prueba';
process.env.API_PUERTO = '0';
process.env.ANTHROPIC_API_KEY = 'clave-falsa';

const db = await import('./db.js');
const { ejecutar } = await import('./acciones.js');
const { interpretarComando } = await import('./comandos.js');
const { interpretar } = await import('./ia.js');
const { iniciarApi } = await import('./api.js');
const { pesos, rangoPeriodo, rangoMes, valida } = await import('./fechas.js');

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
});

test('registrar movimientos y evitar duplicados', () => {
  const r = reg({ tipo: 'gasto', monto: 20000, categoria: 'Comida', descripcion: 'almuerzo' }, 0, 'msg1');
  assert.match(r, /Gasto registrado: \$20\.000 en Comida \(almuerzo\)/);
  assert.equal(reg({ tipo: 'gasto', monto: 20000, categoria: 'Comida', descripcion: 'almuerzo' }, 0, 'msg1'), null); // mismo mensaje
  assert.match(reg({ tipo: 'ingreso', monto: 1500000, categoria: 'Salario', descripcion: 'quincena' }, 0, 'msg2'), /Ingreso registrado: \$1\.500\.000/);
  assert.match(reg({ tipo: 'gasto', monto: 12000, categoria: 'Inventada', descripcion: '' }, 0, 'msg3'), /en Otros/);
  assert.match(reg({ tipo: 'gasto', monto: -5, categoria: 'Comida' }, 0, 'msg4'), /No entendí/);
  assert.match(reg({ tipo: 'gasto', monto: 8000, categoria: 'Transporte', descripcion: 'bus', fecha: '2026-10-15' }, 0, 'msg5'), /2026-10-15/);
  // fecha futura o inválida: se usa la del mensaje
  assert.doesNotMatch(reg({ tipo: 'gasto', monto: 1000, categoria: 'Otros', descripcion: 'x', fecha: '2027-01-01' }, 0, 'msg6'), /2027/);
});

test('resumen del periodo y por categoría', () => {
  const texto = ejecutar({ nombre: 'consultar_resumen', datos: { periodo: 'mes' } }, { usuario: U, hoy: HOY });
  assert.match(texto, /Ingresos: \$1\.500\.000/);
  assert.match(texto, /Gastos: \$41\.000/); // 20.000 + 12.000 + 8.000 + 1.000
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
});

test('últimos movimientos y deshacer', () => {
  const ultimos = ejecutar({ nombre: 'ultimos_movimientos', datos: { cantidad: 2 } }, { usuario: U, hoy: HOY });
  assert.equal(ultimos.split('\n').length, 3);
  assert.match(ejecutar({ nombre: 'deshacer_ultimo', datos: {} }, { usuario: U, hoy: HOY }), /Borré el último registro/);
  assert.match(ejecutar({ nombre: 'deshacer_ultimo', datos: {} }, { usuario: 'otro' }), /No tienes movimientos/);
});

test('los datos de cada persona están separados', () => {
  const otro = ejecutar({ nombre: 'consultar_resumen', datos: { periodo: 'mes' } }, { usuario: 'otra-persona', hoy: HOY });
  assert.match(otro, /No tienes movimientos/);
});

test('IA simulada: interpreta varias herramientas en un mensaje', async () => {
  let recibido;
  const falsa = http.createServer((req, res) => {
    let cuerpo = '';
    req.on('data', (d) => (cuerpo += d));
    req.on('end', () => {
      recibido = { cabeceras: req.headers, cuerpo: JSON.parse(cuerpo) };
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify({
        content: [
          { type: 'text', text: 'Listo, anoté los dos.' },
          { type: 'tool_use', id: 'a', name: 'registrar_movimiento', input: { tipo: 'gasto', monto: 5000, categoria: 'Transporte', descripcion: 'bus' } },
          { type: 'tool_use', id: 'b', name: 'registrar_movimiento', input: { tipo: 'gasto', monto: 12000, categoria: 'Comida', descripcion: 'almuerzo' } },
        ],
      }));
    });
  });
  await new Promise((r) => falsa.listen(0, '127.0.0.1', r));
  process.env.ANTHROPIC_URL = `http://127.0.0.1:${falsa.address().port}/v1/messages`;
  const { interpretar: interpretarConUrl } = await import('./ia.js?url=falsa');
  const r = await interpretarConUrl('bus 5 mil y almuerzo 12 mil', HOY);
  falsa.close();

  assert.equal(r.acciones.length, 2);
  assert.equal(r.acciones[1].datos.monto, 12000);
  assert.equal(r.texto, 'Listo, anoté los dos.');
  assert.equal(recibido.cabeceras['x-api-key'], 'clave-falsa');
  assert.equal(recibido.cuerpo.tools.length, 6);
  assert.match(recibido.cuerpo.system, /Hoy es 2026-10-17/);
  assert.equal(typeof interpretar, 'function');
});

test('IA simulada: un error de la API se propaga con un mensaje claro', async () => {
  const caida = http.createServer((req, res) => { res.writeHead(529); res.end('sobrecargada'); });
  await new Promise((r) => caida.listen(0, '127.0.0.1', r));
  process.env.ANTHROPIC_URL = `http://127.0.0.1:${caida.address().port}/v1/messages`;
  const { interpretar: otra } = await import('./ia.js?url=caida');
  await assert.rejects(() => otra('hola', HOY), /API 529/);
  caida.close();
});

test('API para la página: token, resumen, movimientos y presupuestos', async () => {
  const servidor = iniciarApi(U);
  await new Promise((r) => servidor.once('listening', r));
  const base = `http://127.0.0.1:${servidor.address().port}`;
  const con = { headers: { Authorization: 'Bearer secreto-de-prueba' } };

  assert.equal((await fetch(`${base}/api/salud`)).status, 401);
  assert.equal((await fetch(`${base}/api/salud`, { headers: { Authorization: 'Bearer malo' } })).status, 401);
  assert.equal((await fetch(`${base}/api/salud`, con)).status, 200);

  const resumen = await (await fetch(`${base}/api/resumen?mes=2026-10`, con)).json();
  assert.equal(resumen.ingresos, 1500000);
  assert.ok(resumen.gastos > 0 && Array.isArray(resumen.porCategoria));

  const movs = await (await fetch(`${base}/api/movimientos?tipo=gasto&categoria=Ocio`, con)).json();
  assert.ok(movs.length >= 2 && movs.every((m) => m.categoria === 'Ocio' && m.tipo === 'gasto'));

  assert.equal((await fetch(`${base}/api/movimientos?desde=ayer`, con)).status, 400);
  assert.equal((await fetch(`${base}/api/resumen?mes=octubre`, con)).status, 400);
  assert.equal((await fetch(`${base}/api/nada`, con)).status, 404);

  const presu = await (await fetch(`${base}/api/presupuestos?mes=2026-10`, con)).json();
  assert.equal(presu[0].categoria, 'Ocio');

  const preflight = await fetch(`${base}/api/resumen`, { method: 'OPTIONS' });
  assert.equal(preflight.status, 204);
  assert.equal(preflight.headers.get('access-control-allow-origin'), 'http://localhost:3000');
  servidor.close();
});
