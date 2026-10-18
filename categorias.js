// Categorías disponibles. Puedes agregar o quitar las que quieras.
export const CATEGORIAS = [
  'Comida',
  'Transporte',
  'Servicios',
  'Estudio',
  'Salud',
  'Ocio',
  'Hogar',
  'Ropa',
  'Deudas',
  'Ahorro',
  'Salario',
  'Ventas',
  'Otros',
];

// "Éxito " -> "exito" (sin tildes, en minúscula y sin espacios sobrantes)
export function normalizar(texto) {
  return String(texto)
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .toLowerCase()
    .trim();
}

// Devuelve la categoría que coincide con el texto, o null
export function buscarCategoria(texto) {
  const t = normalizar(texto);
  return CATEGORIAS.find((c) => normalizar(c) === t) ?? null;
}
