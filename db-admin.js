#!/usr/bin/env node
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { randomUUID } from 'node:crypto';
import { DatabaseSync } from 'node:sqlite';

function validarBase(archivo) {
  const db = new DatabaseSync(archivo, { readOnly: true });
  try {
    const integridad = db.prepare('PRAGMA integrity_check').get();
    if (integridad?.integrity_check !== 'ok') throw new Error('La base no pasó integrity_check.');
    const tablas = new Set(db.prepare("SELECT name FROM sqlite_master WHERE type = 'table'").all().map((r) => r.name));
    for (const tabla of ['movimientos', 'presupuestos', 'procesados']) {
      if (!tablas.has(tabla)) throw new Error(`Falta la tabla requerida: ${tabla}.`);
    }
  } finally {
    db.close();
  }
}

export function crearRespaldo(origen, destino) {
  const src = path.resolve(origen);
  const dst = path.resolve(destino);
  if (src === dst) throw new Error('El origen y el destino deben ser distintos.');
  if (fs.existsSync(dst)) throw new Error('El archivo de destino ya existe; no se sobrescribió.');
  fs.mkdirSync(path.dirname(dst), { recursive: true });
  validarBase(src);
  const db = new DatabaseSync(src);
  try {
    db.exec('PRAGMA wal_checkpoint(FULL)');
    const literal = dst.replaceAll("'", "''");
    db.exec(`VACUUM INTO '${literal}'`);
  } finally {
    db.close();
  }
  try {
    validarBase(dst);
  } catch (error) {
    fs.rmSync(dst, { force: true });
    throw error;
  }
  return dst;
}

export function restaurarRespaldo(origen, destino) {
  const src = path.resolve(origen);
  const dst = path.resolve(destino);
  if (src === dst) throw new Error('El origen y el destino deben ser distintos.');
  if (fs.existsSync(dst)) throw new Error('El destino ya existe; restaura a una ruta nueva para evitar sobrescribir datos.');
  if (fs.existsSync(`${src}-wal`) || fs.existsSync(`${src}-shm`)) {
    throw new Error('El origen tiene archivos WAL/SHM; crea primero un respaldo independiente con el comando backup.');
  }
  if (fs.existsSync(`${dst}-wal`) || fs.existsSync(`${dst}-shm`)) {
    throw new Error('El destino tiene archivos WAL/SHM huérfanos; elige otra ruta.');
  }
  validarBase(src);
  fs.mkdirSync(path.dirname(dst), { recursive: true });
  const temporal = path.join(path.dirname(dst), `.${path.basename(dst)}.restore-${randomUUID()}.db`);
  try {
    fs.copyFileSync(src, temporal, fs.constants.COPYFILE_EXCL);
    validarBase(temporal);
    fs.linkSync(temporal, dst);
  } catch (error) {
    throw error;
  } finally {
    fs.rmSync(temporal, { force: true });
  }
  return dst;
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const [operacion, origen, destino] = process.argv.slice(2);
  if (!['backup', 'restore'].includes(operacion) || !origen || !destino) {
    console.error('Uso: node db-admin.js backup <finanzas.db> <respaldo.db>\n     node db-admin.js restore <respaldo.db> <nueva-finanzas.db>');
    process.exitCode = 2;
  } else {
    try {
      const resultado = operacion === 'backup'
        ? crearRespaldo(origen, destino)
        : restaurarRespaldo(origen, destino);
      console.log(`Operación ${operacion} completada: ${resultado}`);
    } catch (error) {
      console.error(`No se completó ${operacion}: ${error.message}`);
      process.exitCode = 1;
    }
  }
}
