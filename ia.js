import { CATEGORIAS } from './categorias.js';
import { montoMaximo } from './montos.js';
 
// Proveedor de IA: Gemini si hay GEMINI_API_KEY; si no, Claude si hay ANTHROPIC_API_KEY.
// MODELO_GEMINI / MODELO_ANTHROPIC eligen cada proveedor; MODELO_IA queda como compatibilidad.
function proveedor() {
  if (process.env.GEMINI_API_KEY) return 'gemini';
  if (process.env.ANTHROPIC_API_KEY) return 'claude';
  return null;
}
export const hayIA = () => proveedor() !== null;
export const nombreProveedor = () => proveedor();
 
// Herramientas en un formato neutro; abajo se convierten al formato de cada proveedor
const HERRAMIENTAS = [
  {
    nombre: 'registrar_movimiento',
    descripcion:
      'Registra UN gasto o ingreso. Si la persona cuenta varios, llama a esta herramienta una vez por cada uno.',
    propiedades: {
      tipo: { type: 'string', enum: ['gasto', 'ingreso'] },
      monto: { type: 'integer', minimum: 1, description: 'Monto en pesos colombianos, entero.' },
      categoria: { type: 'string', enum: CATEGORIAS },
      descripcion: { type: 'string', description: 'Descripción muy corta (2 a 5 palabras).' },
      fecha: { type: 'string', description: 'AAAA-MM-DD. Solo si la persona indicó una fecha distinta de hoy.' },
    },
    requeridas: ['tipo', 'monto', 'categoria', 'descripcion'],
  },
  {
    nombre: 'consultar_resumen',
    descripcion: 'Muestra ingresos, gastos y balance de un periodo.',
    propiedades: {
      periodo: { type: 'string', enum: ['hoy', 'semana', 'mes', 'mes_pasado', 'anio'] },
      categoria: { type: 'string', enum: CATEGORIAS, description: 'Opcional: limitar a una categoría.' },
    },
    requeridas: ['periodo'],
  },
  {
    nombre: 'ultimos_movimientos',
    descripcion: 'Lista los últimos movimientos registrados.',
    propiedades: { cantidad: { type: 'integer', description: 'Cuántos mostrar (1 a 20).' } },
  },
  {
    nombre: 'deshacer_ultimo',
    descripcion: 'Solicita confirmación para borrar el último movimiento reciente. No se borra hasta que la persona confirme con /deshacer confirmar.',
  },
  {
    nombre: 'fijar_presupuesto',
    descripcion: 'Fija un límite mensual de gasto para una categoría.',
    propiedades: {
      categoria: { type: 'string', enum: CATEGORIAS },
      limite_mensual: { type: 'integer', minimum: 1, description: 'Límite mensual entero en COP.' },
    },
    requeridas: ['categoria', 'limite_mensual'],
  },
  {
    nombre: 'ver_presupuestos',
    descripcion: 'Muestra los presupuestos mensuales y cuánto se ha gastado de cada uno.',
  },
];
 
const esquema = (h) => ({
  type: 'object',
  properties: h.propiedades && Object.fromEntries(Object.entries(h.propiedades).map(([nombre, propiedad]) => [
    nombre,
    ['monto', 'limite_mensual'].includes(nombre)
      ? { ...propiedad, maximum: montoMaximo() }
      : propiedad,
  ])),
  ...(h.requeridas ? { required: h.requeridas } : {}),
});

async function solicitarConReintento(url, opciones) {
  let respuesta = await fetch(url, opciones);
  if (respuesta.status === 429 || respuesta.status >= 500) {
    await new Promise((resolve) => setTimeout(resolve, 300));
    respuesta = await fetch(url, opciones);
  }
  return respuesta;
}
 
// Formato de Claude
const herramientasClaude = () =>
  HERRAMIENTAS.map((h) => ({
    name: h.nombre,
    description: h.descripcion,
    input_schema: h.propiedades ? esquema(h) : { type: 'object', properties: {} },
  }));
 
// Formato de Gemini (las funciones sin parámetros no llevan "parameters")
const herramientasGemini = () => [
  {
    functionDeclarations: HERRAMIENTAS.map((h) => ({
      name: h.nombre,
      description: h.descripcion,
      ...(h.propiedades ? { parameters: esquema(h) } : {}),
    })),
  },
];
 
function instrucciones(hoy) {
  return `Eres un asistente de finanzas personales que habla con una sola persona por WhatsApp, en Colombia. La moneda es el peso colombiano (COP). Hoy es ${hoy}.
 
Reglas:
- Cuando la persona cuente un gasto o un ingreso, usa registrar_movimiento (una llamada por cada movimiento).
- Convierte siempre los montos a pesos enteros: "20 mil" = 20000, "20 lucas" = 20000, "1,5 millones" = 1500000.
- La moneda usa el formato colombiano: punto para miles y coma para decimales. No inventes ni adivines montos con separadores ambiguos.
- Si dice "ayer", "el lunes", etc., calcula la fecha a partir de hoy. Si no dice fecha, no la envíes.
- Si falta el monto o no se entiende qué pasó, NO registres nada: haz una pregunta corta.
- Para saber cuánto gastó o ganó usa consultar_resumen; para ver lo último, ultimos_movimientos; para iniciar un borrado pide confirmación con deshacer_ultimo; para límites mensuales, fijar_presupuesto o ver_presupuestos.
- Para otras preguntas de dinero (ahorro, deudas, cómo organizarse), responde en texto, breve y práctico. Das información general, no eres asesor financiero: no recomiendes inversiones concretas ni prometas resultados.
- Responde siempre en español, corto y amable. No inventes datos que la persona no haya dicho.`;
}
 
async function leerError(res) {
  const detalle = await res.text().catch(() => '');
  return new Error(`API ${res.status}: ${detalle.slice(0, 200)}`);
}
 
async function conGemini(texto, hoy) {
  const modelo = process.env.MODELO_GEMINI ?? process.env.MODELO_IA ?? 'gemini-2.5-flash';
  const url =
    process.env.GEMINI_URL ??
    `https://generativelanguage.googleapis.com/v1beta/models/${encodeURIComponent(modelo)}:generateContent`;
 
  const res = await solicitarConReintento(url, {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'x-goog-api-key': process.env.GEMINI_API_KEY },
    body: JSON.stringify({
      systemInstruction: { parts: [{ text: instrucciones(hoy) }] },
      contents: [{ role: 'user', parts: [{ text: texto }] }],
      tools: herramientasGemini(),
      toolConfig: { functionCallingConfig: { mode: 'AUTO' } },
      generationConfig: { temperature: 0.2, maxOutputTokens: 2048 },
    }),
    signal: AbortSignal.timeout(25_000),
  });
  if (!res.ok) throw await leerError(res);
 
  const respuesta = await res.json();
  const partes = respuesta.candidates?.[0]?.content?.parts ?? [];
  if (partes.length === 0 && respuesta.promptFeedback?.blockReason) {
    throw new Error(`Gemini bloqueó el mensaje: ${respuesta.promptFeedback.blockReason}`);
  }
  return {
    acciones: partes
      .filter((p) => p.functionCall)
      .map((p) => ({ nombre: p.functionCall.name, datos: p.functionCall.args ?? {} })),
    texto: partes
      .filter((p) => typeof p.text === 'string' && !p.thought)
      .map((p) => p.text)
      .join('\n')
      .trim(),
  };
}
 
async function conClaude(texto, hoy) {
  const url = process.env.ANTHROPIC_URL ?? 'https://api.anthropic.com/v1/messages';
  const res = await solicitarConReintento(url, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      'x-api-key': process.env.ANTHROPIC_API_KEY,
      'anthropic-version': '2023-06-01',
    },
    body: JSON.stringify({
      model: process.env.MODELO_ANTHROPIC ?? process.env.MODELO_IA ?? 'claude-haiku-5-5',
      max_tokens: 600,
      system: instrucciones(hoy),
      tools: herramientasClaude(),
      messages: [{ role: 'user', content: texto }],
    }),
    signal: AbortSignal.timeout(25_000),
  });
  if (!res.ok) throw await leerError(res);
 
  const bloques = (await res.json()).content ?? [];
  return {
    acciones: bloques
      .filter((b) => b.type === 'tool_use')
      .map((b) => ({ nombre: b.name, datos: b.input ?? {} })),
    texto: bloques
      .filter((b) => b.type === 'text')
      .map((b) => b.text)
      .join('\n')
      .trim(),
  };
}
 
// Envía el mensaje a la IA y devuelve { acciones, texto }
export async function interpretar(texto, hoy) {
  switch (proveedor()) {
    case 'gemini':
      return conGemini(texto, hoy);
    case 'claude':
      return conClaude(texto, hoy);
    default:
      throw new Error('No hay ninguna clave de IA configurada (GEMINI_API_KEY o ANTHROPIC_API_KEY).');
  }
}
