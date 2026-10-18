import * as db from './db.js';
import { CATEGORIAS } from './categorias.js';
import { pesos, rangoMes, rangoPeriodo, valida } from './fechas.js';
import { montoValido } from './montos.js';

const confirmacionesBorrado = new Map();
const CONFIRMACION_MS = 2 * 60 * 1000;

// Aviso cuando un gasto se acerca o pasa el presupuesto mensual de su categoría
function alertaPresupuesto(usuario, categoria, fecha) {
  const limite = db.presupuestoDe(usuario, categoria);
  if (!limite) return '';
  const { desde, hasta } = rangoMes(fecha.slice(0, 7));
  const gastado = db.gastoEnCategoria(usuario, categoria, desde, hasta);
  const porcentaje = Math.round((gastado / limite) * 100);
  if (gastado > limite) {
    return `\n🚨 Te pasaste del presupuesto de ${categoria}: ${pesos(gastado)} de ${pesos(limite)}.`;
  }
  if (porcentaje >= 80) {
    return `\n⚠️ Llevas el ${porcentaje}% del presupuesto de ${categoria} (${pesos(gastado)} de ${pesos(limite)}).`;
  }
  return '';
}

function linea(m) {
  const signo = m.tipo === 'gasto' ? '💸' : '💰';
  const desc = m.descripcion ? ` · ${m.descripcion}` : '';
  return `${signo} ${m.fecha} · ${pesos(m.monto)} · ${m.categoria}${desc}`;
}

// Ejecuta una acción y devuelve el texto a responder (o null si no hay nada que decir)
export function ejecutar(accion, { usuario, hoy, mensajeId, indice, efectos }) {
  const datos = accion.datos ?? {};
  const diferir = (efecto) => efectos ? efectos.push(efecto) : efecto();

  switch (accion.nombre) {
    case 'registrar_movimiento': {
      const monto = datos.monto;
      if (!['gasto', 'ingreso'].includes(datos.tipo) || !montoValido(monto) || !CATEGORIAS.includes(datos.categoria) || (datos.descripcion !== undefined && typeof datos.descripcion !== 'string')) {
        return '⚠️ No entendí bien ese movimiento. Dime el monto y de qué fue.';
      }
      const categoria = datos.categoria;
      const descripcion = String(datos.descripcion ?? '').slice(0, 120);
      // Sin fecha, o con una fecha futura o inválida: se usa la del mensaje
      const fecha = valida(datos.fecha) && datos.fecha <= hoy ? datos.fecha : hoy;

      const id = db.agregarMovimiento({
        usuario,
        tipo: datos.tipo,
        monto,
        categoria,
        descripcion,
        fecha,
        mensajeId: `${mensajeId}:${indice}`,
      });
      if (id === null) return null; // ya estaba registrado

      const etiqueta = datos.tipo === 'gasto' ? '💸 Gasto' : '💰 Ingreso';
      let texto = `${etiqueta} registrado: ${pesos(monto)} en ${categoria}`;
      if (descripcion) texto += ` (${descripcion})`;
      if (fecha !== hoy) texto += ` · ${fecha}`;
      if (datos.tipo === 'gasto') texto += alertaPresupuesto(usuario, categoria, fecha);
      return texto;
    }

    case 'consultar_resumen': {
      const rango = rangoPeriodo(datos.periodo ?? 'mes', hoy);
      const categoria = CATEGORIAS.includes(datos.categoria) ? datos.categoria : null;
      const r = db.resumen(usuario, rango.desde, rango.hasta, categoria);
      if (r.ingresos === 0 && r.gastos === 0) {
        return `📊 No tienes movimientos ${rango.titulo === 'hoy' ? 'hoy' : `en ${rango.titulo}`}${categoria ? ` en ${categoria}` : ''}.`;
      }
      const lineas = [
        `📊 Resumen de ${rango.titulo}${categoria ? ` · ${categoria}` : ''}`,
        `💰 Ingresos: ${pesos(r.ingresos)}`,
        `💸 Gastos: ${pesos(r.gastos)}`,
        `🧮 Balance: ${pesos(r.balance)}`,
      ];
      if (r.porCategoria.length > 0 && !categoria) {
        lineas.push('', 'En qué se fue la plata:');
        for (const c of r.porCategoria.slice(0, 5)) lineas.push(`• ${c.categoria}: ${pesos(c.total)}`);
      }
      return lineas.join('\n');
    }

    case 'ultimos_movimientos': {
      const cantidad = Math.min(Math.max(Number(datos.cantidad) || 5, 1), 20);
      const filas = db.listarMovimientos({ usuario, limite: cantidad });
      if (filas.length === 0) return 'Todavía no tienes movimientos registrados.';
      return ['🧾 Tus últimos movimientos:', ...filas.map(linea)].join('\n');
    }

    case 'deshacer_ultimo': {
      const fila = db.ultimoMovimientoBorrable(usuario);
      if (!fila) return 'No hay movimientos recientes para deshacer.';
      diferir(() => confirmacionesBorrado.set(usuario, { id: fila.id, vence: Date.now() + CONFIRMACION_MS }));
      return `⚠️ ¿Confirmas borrar este movimiento?\n${linea(fila)}\nResponde /deshacer confirmar. Para cancelar: /deshacer cancelar.`;
    }

    case 'confirmar_deshacer': {
      const pendiente = confirmacionesBorrado.get(usuario);
      diferir(() => confirmacionesBorrado.delete(usuario));
      if (!pendiente || pendiente.vence < Date.now()) return 'No hay un borrado pendiente. Escribe /deshacer para iniciar uno.';
      const fila = db.borrarMovimiento(usuario, pendiente.id);
      return fila ? `↩️ Borré el movimiento confirmado:\n${linea(fila)}` : 'El movimiento cambió o ya no está disponible; no borré nada.';
    }

    case 'cancelar_deshacer': {
      const existia = confirmacionesBorrado.has(usuario);
      diferir(() => confirmacionesBorrado.delete(usuario));
      return existia ? 'Listo, cancelé el borrado.' : 'No hay un borrado pendiente.';
    }

    case 'fijar_presupuesto': {
      const limite = datos.limite_mensual;
      if (!CATEGORIAS.includes(datos.categoria) || !montoValido(limite)) {
        return '⚠️ Dime la categoría y el monto del presupuesto, por ejemplo: presupuesto de 300 mil en comida.';
      }
      db.fijarPresupuesto(usuario, datos.categoria, limite);
      return `🎯 Listo: presupuesto mensual de ${datos.categoria} en ${pesos(limite)}.`;
    }

    case 'ver_presupuestos': {
      const lista = db.presupuestos(usuario);
      if (lista.length === 0) return 'Aún no tienes presupuestos. Prueba: "presupuesto de 300 mil en comida".';
      const { desde, hasta } = rangoMes(hoy.slice(0, 7));
      const lineas = ['🎯 Presupuestos de este mes:'];
      for (const p of lista) {
        const gastado = db.gastoEnCategoria(usuario, p.categoria, desde, hasta);
        lineas.push(`• ${p.categoria}: ${pesos(gastado)} de ${pesos(p.limite)} (${Math.round((gastado / p.limite) * 100)}%)`);
      }
      return lineas.join('\n');
    }

    default:
      return '⚠️ No supe qué hacer con eso.';
  }
}
