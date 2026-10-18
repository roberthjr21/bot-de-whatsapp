
import http from 'node:http';
import crypto from 'node:crypto';

import * as db from './db.js';
import { CATEGORIAS } from './categorias.js';
import { fechaBogota, rangoMes, valida } from './fechas.js';

// =====================================================
// CONFIGURACIÓN
// =====================================================

export function crearServidorApi(usuarioPorDefecto) {
  const token = process.env.API_TOKEN?.trim();

  if (!token) {
    console.warn(
      '⚠️ API desactivada: no se detectó API_TOKEN en .env.'
    );
    return null;
  }

  if (!usuarioPorDefecto) {
    console.error(
      '❌ API no iniciada: falta el usuario predeterminado.'
    );
    return null;
  }

  const puerto = Number(process.env.API_PUERTO ?? 3001);
  const host = process.env.API_HOST ?? '127.0.0.1';
  const origenConfigurado =
    process.env.ORIGEN_PERMITIDO ??
    'http://localhost:3000';

  if (
    !Number.isInteger(puerto) ||
    puerto < 0 ||
    puerto > 65535
  ) {
    console.error('❌ API_PUERTO no es válido.');
    return null;
  }

  let origenPermitido;

  try {
    origenPermitido = new URL(origenConfigurado).origin;
  } catch {
    console.error(
      '❌ ORIGEN_PERMITIDO debe ser una URL válida.'
    );
    return null;
  }

  // ---------------------------------------------------
  // Validar token sin comparación ordinaria de strings
  // ---------------------------------------------------

  function tokenValido(cabecera) {
    if (typeof cabecera !== 'string') return false;

    const esperado = Buffer.from(`Bearer ${token}`, 'utf8');
    const recibido = Buffer.from(cabecera, 'utf8');

    return (
      esperado.length === recibido.length &&
      crypto.timingSafeEqual(esperado, recibido)
    );
  }

  // ---------------------------------------------------
  // Responder JSON
  // ---------------------------------------------------

  function responder(res, codigo, cuerpo, cabeceras) {
    res.writeHead(codigo, cabeceras);

    if (codigo === 204 || cuerpo === undefined) {
      res.end();
      return;
    }

    res.end(JSON.stringify(cuerpo));
  }

  // ---------------------------------------------------
  // Servidor
  // ---------------------------------------------------

  const servidor = http.createServer((req, res) => {
    const origenSolicitud = req.headers.origin;

    const cabeceras = {
      'Access-Control-Allow-Origin': origenPermitido,
      'Access-Control-Allow-Headers': 'Authorization, Content-Type',
      'Access-Control-Allow-Methods': 'GET, OPTIONS',
      'Content-Type': 'application/json; charset=utf-8',
      'Cache-Control': 'no-store',
      Vary: 'Origin',
    };

    // Rechazar otros orígenes de navegador.
    if (
      origenSolicitud &&
      origenSolicitud !== origenPermitido
    ) {
      responder(
        res,
        403,
        { error: 'Origen no permitido' },
        cabeceras
      );
      return;
    }

    // Preflight de CORS.
    if (req.method === 'OPTIONS') {
      responder(res, 204, undefined, cabeceras);
      return;
    }

    if (req.method !== 'GET') {
      responder(
        res,
        405,
        { error: 'Método no permitido' },
        cabeceras
      );
      return;
    }

    if (!tokenValido(req.headers.authorization)) {
      responder(
        res,
        401,
        { error: 'No autorizado' },
        cabeceras
      );
      return;
    }

    try {
      const url = new URL(
        req.url ?? '/',
        'http://localhost'
      );

      const parametros = url.searchParams;

      // Esta API sirve al usuario del bot que la inició.
      // Ignora el parámetro ?usuario= para impedir que se
      // seleccione otra cuenta desde la URL.
      const usuario = usuarioPorDefecto;

      const mes = parametros.get('mes') ?? fechaBogota().slice(0, 7);

      switch (url.pathname) {
        // ---------------------------------------------
        // Comprobar que la API está activa
        // ---------------------------------------------

        case '/api/salud': {
          responder(
            res,
            200,
            { ok: true },
            cabeceras
          );
          return;
        }

        // ---------------------------------------------
        // Obtener categorías
        // ---------------------------------------------

        case '/api/categorias': {
          responder(
            res,
            200,
            CATEGORIAS,
            cabeceras
          );
          return;
        }

        // ---------------------------------------------
        // Resumen mensual
        // ---------------------------------------------

        case '/api/resumen': {
          if (!/^\d{4}-(0[1-9]|1[0-2])$/.test(mes) || Number(mes.slice(0, 4)) < 1000) {
            responder(res, 400, { error: 'mes debe tener un año entre 1000 y 9999 y formato AAAA-MM' }, cabeceras);
            return;
          }
          const { desde, hasta } = rangoMes(mes);

          const resumen = db.resumen(
            usuario,
            desde,
            hasta
          );

          responder(
            res,
            200,
            {
              mes,
              desde,
              hasta,
              ...resumen,
            },
            cabeceras
          );
          return;
        }

        // ---------------------------------------------
        // Listar movimientos
        // ---------------------------------------------

        case '/api/movimientos': {
          const desde =
            parametros.get('desde') ?? undefined;

          const hasta =
            parametros.get('hasta') ?? undefined;

          const tipo =
            parametros.get('tipo') ?? undefined;

          const categoria =
            parametros.get('categoria') ?? undefined;

          const limiteTexto =
            parametros.get('limite') ?? '100';

          const limite = Number(limiteTexto);
          const offsetTexto = parametros.get('offset') ?? '0';
          const offset = Number(offsetTexto);

          if (
            (desde && !valida(desde)) ||
            (hasta && !valida(hasta))
          ) {
            responder(
              res,
              400,
              {
                error:
                  'desde y hasta deben tener el formato AAAA-MM-DD',
              },
              cabeceras
            );
            return;
          }

          if (desde && hasta && desde > hasta) {
            responder(
              res,
              400,
              {
                error: 'desde no puede ser posterior a hasta',
              },
              cabeceras
            );
            return;
          }

          if (
            tipo &&
            !['gasto', 'ingreso'].includes(tipo)
          ) {
            responder(
              res,
              400,
              {
                error: 'tipo debe ser gasto o ingreso',
              },
              cabeceras
            );
            return;
          }

          if (
            !Number.isInteger(limite) ||
            limite < 1 ||
            limite > 500
          ) {
            responder(
              res,
              400,
              {
                error: 'limite debe ser un entero entre 1 y 500',
              },
              cabeceras
            );
            return;
          }

          if (!Number.isSafeInteger(offset) || offset < 0 || offset > 1_000_000) {
            responder(res, 400, { error: 'offset debe ser un entero entre 0 y 1000000' }, cabeceras);
            return;
          }

          if (
            categoria &&
            !CATEGORIAS.includes(categoria)
          ) {
            responder(
              res,
              400,
              { error: 'Categoría no válida' },
              cabeceras
            );
            return;
          }

          const movimientos = db.listarMovimientos({
            usuario,
            desde,
            hasta,
            tipo,
            categoria: categoria ?? undefined,
            limite,
            offset,
          });

          responder(
            res,
            200,
            movimientos,
            cabeceras
          );
          return;
        }

        // ---------------------------------------------
        // Presupuestos del mes
        // ---------------------------------------------

        case '/api/presupuestos': {
          if (!/^\d{4}-(0[1-9]|1[0-2])$/.test(mes) || Number(mes.slice(0, 4)) < 1000) {
            responder(res, 400, { error: 'mes debe tener un año entre 1000 y 9999 y formato AAAA-MM' }, cabeceras);
            return;
          }
          const { desde, hasta } = rangoMes(mes);

          const presupuestos = db.presupuestos(usuario).map(
            (presupuesto) => {
              const gastado = db.gastoEnCategoria(
                usuario,
                presupuesto.categoria,
                desde,
                hasta
              );

              const limiteMensual = Number(
                presupuesto.limite
              );

              return {
                ...presupuesto,
                gastado,
                porcentaje:
                  Number.isFinite(limiteMensual) &&
                  limiteMensual > 0
                    ? Math.round(
                        (gastado / limiteMensual) * 100
                      )
                    : 0,
              };
            }
          );

          responder(
            res,
            200,
            presupuestos,
            cabeceras
          );
          return;
        }

        // ---------------------------------------------
        // Ruta inexistente
        // ---------------------------------------------

        default: {
          responder(
            res,
            404,
            { error: 'No existe esa ruta' },
            cabeceras
          );
          return;
        }
      }
    } catch (error) {
      console.error(
        '❌ Error en la API:',
        error?.message ?? error
      );

      if (!res.headersSent) {
        responder(
          res,
          500,
          { error: 'Error interno del servidor' },
          cabeceras
        );
      } else {
        res.end();
      }
    }
  });

  servidor.on('error', (error) => {
    console.error(
      '❌ Error del servidor API:',
      error.message
    );
  });

  return servidor;
}

export function iniciarApi(usuarioPorDefecto) {
  const servidor = crearServidorApi(usuarioPorDefecto);
  if (!servidor) return null;
  const puerto = Number(process.env.API_PUERTO ?? 3001);
  const host = process.env.API_HOST ?? '127.0.0.1';
  servidor.listen(puerto, host, () => {
    console.log(`✅ API activa en http://${host}:${servidor.address().port}`);
    console.log(`🌐 Origen permitido: ${process.env.ORIGEN_PERMITIDO ?? 'http://localhost:3000'}`);
    console.log('🔐 Token de API configurado.');
  });
  return servidor;
}
