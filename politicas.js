const destructivas = new Set(['deshacer_ultimo', 'confirmar_deshacer']);

export function acotarAcciones(acciones, maximo = 5) {
  if (!Array.isArray(acciones)) return [];
  const resultado = [];
  let yaHayDestructiva = false;
  for (const accion of acciones.slice(0, maximo)) {
    if (destructivas.has(accion?.nombre)) {
      if (yaHayDestructiva) continue;
      yaHayDestructiva = true;
    }
    resultado.push(accion);
  }
  return resultado;
}
