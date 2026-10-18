import { DatabaseSync } from 'node:sqlite';

// Un solo archivo (finanzas.db). Los montos se guardan como pesos enteros.
const db = new DatabaseSync(process.env.DB_ARCHIVO ?? 'finanzas.db');

db.exec(`
  PRAGMA busy_timeout = 5000;
  PRAGMA journal_mode = WAL;

  CREATE TABLE IF NOT EXISTS movimientos (
    id          INTEGER PRIMARY KEY AUTOINCREMENT,
    usuario     TEXT    NOT NULL,
    tipo        TEXT    NOT NULL CHECK (tipo IN ('gasto', 'ingreso')),
    monto       INTEGER NOT NULL CHECK (monto > 0),
    categoria   TEXT    NOT NULL,
    descripcion TEXT    NOT NULL DEFAULT '',
    fecha       TEXT    NOT NULL,
    creado      TEXT    NOT NULL DEFAULT (datetime('now')),
    mensaje_id  TEXT    UNIQUE
  );
  CREATE INDEX IF NOT EXISTS idx_mov_usuario_fecha ON movimientos (usuario, fecha);

  CREATE TABLE IF NOT EXISTS presupuestos (
    usuario   TEXT    NOT NULL,
    categoria TEXT    NOT NULL,
    limite    INTEGER NOT NULL CHECK (limite > 0),
    PRIMARY KEY (usuario, categoria)
  );

  CREATE TABLE IF NOT EXISTS procesados (
    id     TEXT PRIMARY KEY,
    creado TEXT NOT NULL DEFAULT (datetime('now'))
  );
`);

// --- Mensajes ya atendidos (para no registrar dos veces lo mismo) ---
export function yaProcesado(id) {
  return Boolean(db.prepare('SELECT 1 FROM procesados WHERE id = ?').get(id));
}
export function configuracionSQLite() {
  return {
    journal_mode: db.prepare('PRAGMA journal_mode').get().journal_mode,
    busy_timeout: db.prepare('PRAGMA busy_timeout').get().timeout,
  };
}
export function marcarProcesado(id) {
  db.prepare('INSERT OR IGNORE INTO procesados (id) VALUES (?)').run(id);
}
// Las acciones de un mensaje y su marca de idempotencia se confirman juntas.
// Así, un fallo no deja un lote financiero aplicado a medias.
export function enTransaccion(tarea) {
  db.exec('BEGIN IMMEDIATE');
  try {
    const resultado = tarea();
    db.exec('COMMIT');
    return resultado;
  } catch (error) {
    try { db.exec('ROLLBACK'); } catch {}
    throw error;
  }
}
export function cerrarBase() { db.close(); }

// --- Movimientos ---
// Devuelve el id nuevo, o null si ese mensaje ya estaba registrado
export function agregarMovimiento({ usuario, tipo, monto, categoria, descripcion, fecha, mensajeId }) {
  const r = db
    .prepare(
      `INSERT INTO movimientos (usuario, tipo, monto, categoria, descripcion, fecha, mensaje_id)
       VALUES (?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT (mensaje_id) DO NOTHING`
    )
    .run(usuario, tipo, monto, categoria, descripcion ?? '', fecha, mensajeId ?? null);
  return r.changes === 0 ? null : Number(r.lastInsertRowid);
}

export function listarMovimientos({ usuario, desde, hasta, tipo, categoria, limite = 100, offset = 0 }) {
  const condiciones = ['usuario = ?'];
  const params = [usuario];
  if (desde) { condiciones.push('fecha >= ?'); params.push(desde); }
  if (hasta) { condiciones.push('fecha <= ?'); params.push(hasta); }
  if (tipo) { condiciones.push('tipo = ?'); params.push(tipo); }
  if (categoria) { condiciones.push('categoria = ?'); params.push(categoria); }
  params.push(Math.min(Math.max(Number(limite) || 100, 1), 1000));
  return db
    .prepare(
      `SELECT id, tipo, monto, categoria, descripcion, fecha
         FROM movimientos
        WHERE ${condiciones.join(' AND ')}
        ORDER BY fecha DESC, id DESC
        LIMIT ? OFFSET ?`
    )
    .all(...params, Math.max(0, Number(offset) || 0));
}

export function ultimoMovimientoBorrable(usuario) {
  return db.prepare(
    `SELECT id, tipo, monto, categoria, descripcion, fecha
       FROM movimientos
      WHERE usuario = ? AND creado >= datetime('now', '-1 day')
      ORDER BY id DESC LIMIT 1`,
  ).get(usuario) ?? null;
}

export function borrarMovimiento(usuario, id) {
  const fila = db.prepare(
    `SELECT id, tipo, monto, categoria, descripcion, fecha
       FROM movimientos WHERE usuario = ? AND id = ?
         AND creado >= datetime('now', '-1 day')`,
  ).get(usuario, id);
  if (!fila) return null;
  const resultado = db.prepare('DELETE FROM movimientos WHERE usuario = ? AND id = ?').run(usuario, id);
  return resultado.changes ? fila : null;
}

// Totales de ingresos y gastos, y gastos por categoría, entre dos fechas
export function resumen(usuario, desde, hasta, categoria = null) {
  const filtro = categoria ? 'AND categoria = ?' : '';
  const params = categoria ? [usuario, desde, hasta, categoria] : [usuario, desde, hasta];

  const totales = db
    .prepare(
      `SELECT tipo, COALESCE(SUM(monto), 0) AS total
         FROM movimientos
        WHERE usuario = ? AND fecha BETWEEN ? AND ? ${filtro}
        GROUP BY tipo`
    )
    .all(...params);
  const porCategoria = db
    .prepare(
      `SELECT categoria, SUM(monto) AS total
         FROM movimientos
        WHERE usuario = ? AND tipo = 'gasto' AND fecha BETWEEN ? AND ? ${filtro}
        GROUP BY categoria
        ORDER BY total DESC`
    )
    .all(...params);

  const ingresos = totales.find((t) => t.tipo === 'ingreso')?.total ?? 0;
  const gastos = totales.find((t) => t.tipo === 'gasto')?.total ?? 0;
  return {
    ingresos,
    gastos,
    balance: ingresos - gastos,
    porCategoria: porCategoria.map((c) => ({ categoria: c.categoria, total: c.total })),
  };
}

export function gastoEnCategoria(usuario, categoria, desde, hasta) {
  return (
    db
      .prepare(
        `SELECT COALESCE(SUM(monto), 0) AS total FROM movimientos
          WHERE usuario = ? AND tipo = 'gasto' AND categoria = ? AND fecha BETWEEN ? AND ?`
      )
      .get(usuario, categoria, desde, hasta).total
  );
}

// --- Presupuestos mensuales por categoría ---
export function fijarPresupuesto(usuario, categoria, limite) {
  db.prepare(
    `INSERT INTO presupuestos (usuario, categoria, limite) VALUES (?, ?, ?)
     ON CONFLICT (usuario, categoria) DO UPDATE SET limite = excluded.limite`
  ).run(usuario, categoria, limite);
}

export function presupuestoDe(usuario, categoria) {
  return (
    db.prepare('SELECT limite FROM presupuestos WHERE usuario = ? AND categoria = ?').get(usuario, categoria)
      ?.limite ?? null
  );
}

export function presupuestos(usuario) {
  return db
    .prepare('SELECT categoria, limite FROM presupuestos WHERE usuario = ? ORDER BY categoria')
    .all(usuario)
    .map((p) => ({ categoria: p.categoria, limite: p.limite }));
}
