import { buscarCategoria, normalizar } from './categorias.js';
import { parseMonto } from './montos.js';

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
      const cantidad = resto[0] && /^(mil|lucas|k|millones?|millón|millon)$/iu.test(resto[1] ?? '')
        ? `${resto[0]} ${resto[1]}`
        : resto[0];
      const desplazamiento = cantidad === `${resto[0]} ${resto[1]}` ? 2 : 1;
      const monto = parseMonto(cantidad);
      if (!monto) return { respuesta: `Usa: /${comando} 20000 comida almuerzo` };
      const categoria = buscarCategoria(resto[desplazamiento] ?? '');
      const descripcion = (categoria ? resto.slice(desplazamiento + 1) : resto.slice(desplazamiento)).join(' ');
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
      if (normalizar(resto[0] ?? '') === 'confirmar') {
        return { acciones: [{ nombre: 'confirmar_deshacer', datos: {} }] };
      }
      if (normalizar(resto[0] ?? '') === 'cancelar') {
        return { acciones: [{ nombre: 'cancelar_deshacer', datos: {} }] };
      }
      return { acciones: [{ nombre: 'deshacer_ultimo', datos: {} }] };

    case 'presupuesto': {
      const categoria = buscarCategoria(resto[0] ?? '');
      const segundo = resto[1] && /^(mil|lucas|k|millones?|millón|millon)$/iu.test(resto[2] ?? '')
        ? `${resto[1]} ${resto[2]}`
        : resto[1];
      const limite = parseMonto(segundo);
      if (!categoria || !limite) return { respuesta: 'Usa: /presupuesto comida 300000' };
      return { acciones: [{ nombre: 'fijar_presupuesto', datos: { categoria, limite_mensual: limite } }] };
    }

    case 'presupuestos':
      return { acciones: [{ nombre: 'ver_presupuestos', datos: {} }] };

    default:
      return null;
  }
}
