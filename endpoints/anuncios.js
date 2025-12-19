const express = require("express");
const router = express.Router();
const { ObjectId } = require("mongodb");
const { addNotification } = require("../utils/notificaciones.helper");
const { createBlindIndex, verifyPassword, decrypt } = require("../utils/seguridad.helper");

// Nuevo endpoint para obtener información del documento por responseId
// MODIFICAR el endpoint POST para no almacenar en BD
router.post('/', async (req, res) => {
  console.log('POST /api/anuncios - Body recibido:', req.body);

  try {
    const db = req.db;

    if (!db) {
      console.error('No hay conexión a la base de datos');
      return res.status(500).json({
        success: false,
        error: 'Error de conexión a la base de datos'
      });
    }

    const {
      titulo,
      descripcion,
      prioridad = 1,
      color = '#f5872dff',
      icono = 'paper',
      actionUrl = null,
      destinatarios
    } = req.body;

    // Validaciones básicas
    if (!titulo || !descripcion) {
      console.log('Validación fallida: título o descripción faltante');
      return res.status(400).json({
        success: false,
        error: 'Título y descripción son requeridos'
      });
    }

    if (!destinatarios || !destinatarios.tipo) {
      console.log('Validación fallida: destinatarios faltante');
      return res.status(400).json({
        success: false,
        error: 'Debe especificar destinatarios'
      });
    }

    console.log('Validaciones pasadas, procesando destinatarios tipo:', destinatarios.tipo);

    let resultadoEnvio;
    const fechaEnvio = new Date();

    // ENVIAR SEGÚN TIPO DE DESTINATARIOS (sin almacenar en BD)
    if (destinatarios.tipo === 'todos') {
      console.log('📨 Enviando a TODOS los usuarios activos');

      resultadoEnvio = await addNotification(db, {
        filtro: { estado: 'activo' },
        titulo,
        descripcion,
        prioridad,
        color,
        icono,
        actionUrl
      });

      console.log('Notificación enviada a todos:', resultadoEnvio);

    } else if (destinatarios.tipo === 'filtro') {
      console.log('📨 Enviando por FILTROS:', destinatarios.filtro);

      const filtro = destinatarios.filtro || {};
      const condicionesFiltro = { estado: 'activo' };

      const andConditions = [];

      if (filtro.empresas && filtro.empresas.length > 0) {
        andConditions.push({ empresa: { $in: filtro.empresas } });
      }

      if (filtro.cargos && filtro.cargos.length > 0) {
        andConditions.push({ cargo: { $in: filtro.cargos } });
      }

      if (filtro.roles && filtro.roles.length > 0) {
        andConditions.push({ rol: { $in: filtro.roles } });
      }

      if (andConditions.length > 0) {
        condicionesFiltro.$and = andConditions;
      }

      console.log('🔍 Filtro construido:', condicionesFiltro);

      resultadoEnvio = await addNotification(db, {
        filtro: condicionesFiltro,
        titulo,
        descripcion,
        prioridad,
        color,
        icono,
        actionUrl
      });

      console.log('Notificación enviada por filtro:', resultadoEnvio);

    } else if (destinatarios.tipo === 'manual') {
      console.log('Enviando a usuarios MANUALES:', destinatarios.usuariosManuales);

      if (!destinatarios.usuariosManuales || destinatarios.usuariosManuales.length === 0) {
        return res.status(400).json({
          success: false,
          error: 'Debe seleccionar al menos un destinatario'
        });
      }

      let totalEnviados = 0;
      let totalErrores = 0;
      const erroresDetalle = [];

      for (const userId of destinatarios.usuariosManuales) {
        try {
          console.log(`Enviando a usuario: ${userId}`);

          await addNotification(db, {
            userId: userId,
            titulo,
            descripcion,
            prioridad,
            color,
            icono,
            actionUrl
          });

          totalEnviados++;
          console.log(`Enviado a ${userId}`);

        } catch (error) {
          totalErrores++;
          erroresDetalle.push({
            userId,
            error: error.message
          });
          console.error(`Error al enviar a ${userId}:`, error);
        }
      }

      resultadoEnvio = {
        modifiedCount: totalEnviados,
        errores: totalErrores,
        erroresDetalle
      };

      console.log(`Total manual: ${totalEnviados} enviados, ${totalErrores} errores`);
    }

    // ✅ REMOVER: No guardar en colección 'anuncios'
    // const anuncioRegistro = { ... }; // Eliminar todo este bloque
    // const insertResult = await db.collection('anuncios').insertOne(anuncioRegistro);

    // ✅ RESPONDER sin ID de BD
    const respuesta = {
      success: true,
      message: `Notificación enviada exitosamente a ${resultadoEnvio?.modifiedCount || 0} usuario(s)`,
      data: {
        titulo,
        fechaEnvio,
        destinatariosEnviados: resultadoEnvio?.modifiedCount || 0,
        errores: resultadoEnvio?.errores || 0
      }
    };

    console.log('Enviando respuesta al frontend:', respuesta);
    res.json(respuesta);

  } catch (error) {
    console.error('ERROR CRÍTICO en POST /api/anuncios:', error);
    console.error('Stack trace:', error.stack);

    res.status(500).json({
      success: false,
      error: 'Error interno del servidor',
      detalle: error.message
    });
  }
});

// MODIFICAR el GET para devolver array vacío (ya que no se almacenan)
router.get('/', async (req, res) => {
  console.log('GET /api/anuncios - Sin almacenamiento histórico');

  try {
    // Devolver array vacío ya que no se almacenan anuncios
    const respuesta = {
      success: true,
      data: []
    };

    res.json(respuesta);

  } catch (error) {
    console.error('ERROR en GET /api/anuncios:', error);

    res.status(500).json({
      success: false,
      error: error.message
    });
  }
});

// Ruta de prueba simple
router.get('/test', (req, res) => {
  console.log('GET /api/anuncios/test - Prueba de conexión');
  res.json({
    success: true,
    message: 'Endpoint de anuncios funcionando',
    timestamp: new Date().toISOString()
  });
});

module.exports = router;