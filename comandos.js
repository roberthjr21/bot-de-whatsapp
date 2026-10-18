import { buscarCategoria, normalizar } from './categorias.js';

export const AYUDA = [
  '🤖 *Tu ayudante financiero*',
  '',
  'Escríbeme normal, por ejemplo:',
  '• "compré aceite por 20 mil"',
  '• "me pagaron 1,5 millones"',
  '• "cuánto gasté esta semana"',
  '• "ponme un presupuesto de 300 mil en comida"',
  '',
  'O usa comandos (funcionan aunque la IA falle):',
  '/gasto 20000 comida almuerzo',
  '/ingreso 1500000 salario quincena',
  '/resumen [hoy|semana|mes|mes_pasado|anio]',
  '/ultimos [cantidad]',
  '/deshacer',
  '/presupuesto comida 300000',
  '/presupuestos',
].join('\n');

// "20000", "$20.000", "20k", "20mil" -> 20000
function parseMonto(texto) {
  const m = String(texto ?? '').toLowerCase().match(/^\$?([\d.,]+)(k|mil|lucas)?$/);
  if (!m) return null;
  let n = parseInt(m[1].replace(/[.,]/g, ''), 10);
  if (!Number.isFinite(n) || n <= 0) return null;
  if (m[2]) n *= 1000;
  return n;
}

const PERIODOS = {
  hoy: 'hoy',
  semana: 'semana',
  mes: 'mes',
  mes_pasado: 'mes_pasado',
  anio: 'anio',
  ano: 'anio',
};

// Devuelve { acciones } o { respuesta } para un comando, o null si no es un comando conocido
export function interpretarComando(texto) {
  const [cabeza, ...resto] = texto.trim().split(/\s+/);
  const comando = normalizar(cabeza).replace(/^\//, '');

  switch (comando) {
    case 'ayuda':
    case 'help':
      return { respuesta: AYUDA };

    case 'gasto':
    case 'ingreso': {
      const monto = parseMonto(resto[0]);
      if (!monto) return { respuesta: `Usa: /${comando} 20000 comida almuerzo` };
      const categoria = buscarCategoria(resto[1] ?? '');
      const descripcion = (categoria ? resto.slice(2) : resto.slice(1)).join(' ');
      return {
        acciones: [
          {
            nombre: 'registrar_movimiento',
            datos: { tipo: comando, monto, categoria: categoria ?? 'Otros', descripcion },
          },
        ],
      };
    }

    case 'resumen': {
      const periodo = PERIODOS[normalizar(resto[0] ?? 'mes')];
      if (!periodo) return { respuesta: 'Usa: /resumen hoy | semana | mes | mes_pasado | anio' };
      return { acciones: [{ nombre: 'consultar_resumen', datos: { periodo } }] };
    }

    case 'ultimos':
      return { acciones: [{ nombre: 'ultimos_movimientos', datos: { cantidad: Number(resto[0]) || 5 } }] };

    case 'deshacer':
      return { acciones: [{ nombre: 'deshacer_ultimo', datos: {} }] };

    case 'presupuesto': {
      const categoria = buscarCategoria(resto[0] ?? '');
      const limite = parseMonto(resto[1]);
      if (!categoria || !limite) return { respuesta: 'Usa: /presupuesto comida 300000' };
      return { acciones: [{ nombre: 'fijar_presupuesto', datos: { categoria, limite_mensual: limite } }] };
    }

    case 'presupuestos':
      return { acciones: [{ nombre: 'ver_presupuestos', datos: {} }] };

    default:
      return null;
  }
}
