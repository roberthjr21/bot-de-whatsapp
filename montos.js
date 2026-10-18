// Los importes de almacenamiento y de la API son pesos enteros COP.
export const MONTO_MAXIMO_PREDETERMINADO = 100_000_000;

export function montoMaximo() {
  const configurado = Number(process.env.MONTO_MAXIMO);
  return Number.isSafeInteger(configurado) && configurado > 0
    ? Math.min(configurado, Number.MAX_SAFE_INTEGER)
    : MONTO_MAXIMO_PREDETERMINADO;
}

export function montoValido(valor) {
  return Number.isSafeInteger(valor) && valor > 0 && valor <= montoMaximo();
}

export function tieneDecimalConPunto(texto) {
  return /(?<![\d.])\$?\d{1,3}\.\d{1,2}(?!\d|\.\d)/.test(String(texto ?? ''));
}

// Acepta miles con punto y decimales con coma (es-CO). El punto decimal
// aislado, por ejemplo «20.5», no es un grupo de miles válido y se rechaza.
export function parseMonto(texto) {
  const entrada = String(texto ?? '').trim().toLowerCase().replace(/^\$/, '');
  const coincidencia = entrada.match(
    /^([\d.,]+)\s*(millones?|millón|millon|m|mil|lucas|k)?$/u,
  );
  if (!coincidencia) return null;

  const [, numero, sufijo = ''] = coincidencia;
  let canonico;
  if (numero.includes(',')) {
    const partes = numero.split(',');
    if (partes.length !== 2 || !/^\d{1,2}$/.test(partes[1])) return null;
    const entero = partes[0];
    const valido = /^\d+$/.test(entero) || /^\d{1,3}(?:\.\d{3})+$/.test(entero);
    if (!valido) return null;
    canonico = `${entero.replaceAll('.', '')}.${partes[1]}`;
  } else if (numero.includes('.')) {
    if (!/^\d{1,3}(?:\.\d{3})+$/.test(numero)) return null;
    canonico = numero.replaceAll('.', '');
  } else {
    canonico = numero;
  }

  const valor = Number(canonico);
  const multiplicador = /^(millones?|millón|millon|m)$/.test(sufijo)
    ? 1_000_000
    : /^(mil|lucas|k)$/.test(sufijo) ? 1_000 : 1;
  const redondeado = Math.round(valor * multiplicador);
  return montoValido(redondeado) ? redondeado : null;
}
