const ZONA = 'America/Bogota';

// Fecha (AAAA-MM-DD) en Bogotá para un momento dado (por defecto, ahora)
export function fechaBogota(momento = new Date()) {
  return momento.toLocaleDateString('en-CA', { timeZone: ZONA });
}

const aDate = (iso) => {
  const [a, m, d] = iso.split('-').map(Number);
  return new Date(Date.UTC(a, m - 1, d));
};
const aIso = (date) => date.toISOString().slice(0, 10);
const dos = (n) => String(n).padStart(2, '0');

export function sumarDias(iso, dias) {
  const d = aDate(iso);
  d.setUTCDate(d.getUTCDate() + dias);
  return aIso(d);
}

// ¿Es una fecha real con formato AAAA-MM-DD?
export function valida(iso) {
  return typeof iso === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(iso) && aIso(aDate(iso)) === iso;
}

// Primer y último día de un mes "AAAA-MM"
export function rangoMes(mes) {
  if (typeof mes !== 'string' || !/^\d{4}-(0[1-9]|1[0-2])$/.test(mes) || Number(mes.slice(0, 4)) < 1000) {
    throw new RangeError('Mes fuera de rango. Usa un año entre 1000 y 9999.');
  }
  const [a, m] = mes.split('-').map(Number);
  const desde = `${a}-${dos(m)}-01`;
  const hasta = aIso(new Date(Date.UTC(a, m, 0))); // día 0 del mes siguiente = último del actual
  return { desde, hasta };
}

// Rango de fechas para "hoy", "semana", "mes", "mes_pasado" o "anio"
export function rangoPeriodo(periodo, hoy) {
  const [a, m] = hoy.split('-').map(Number);
  switch (periodo) {
    case 'hoy':
      return { desde: hoy, hasta: hoy, titulo: 'hoy' };
    case 'semana': {
      const diasDesdeLunes = (aDate(hoy).getUTCDay() + 6) % 7;
      return { desde: sumarDias(hoy, -diasDesdeLunes), hasta: hoy, titulo: 'esta semana' };
    }
    case 'mes_pasado': {
      const ultimo = sumarDias(`${a}-${dos(m)}-01`, -1);
      return { ...rangoMes(ultimo.slice(0, 7)), titulo: 'el mes pasado' };
    }
    case 'anio':
      return { desde: `${a}-01-01`, hasta: hoy, titulo: `el año ${a}` };
    case 'mes':
    default:
      return { desde: `${a}-${dos(m)}-01`, hasta: hoy, titulo: 'este mes' };
  }
}

// 20000 -> "$20.000"
export function pesos(n) {
  const entero = Math.round(Number(n) || 0);
  return `${entero < 0 ? '-' : ''}$${Math.abs(entero).toLocaleString('es-CO')}`;
}
