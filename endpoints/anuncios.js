const express = require("express");
const router = express.Router();
const { ObjectId } = require("mongodb");
const { addNotification } = require("../utils/notificaciones.helper");

// POST /api/anuncios - Crear y enviar anuncio (SOLO NOTIFICACIONES)
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
      actionUrl = null,
      destinatarios
    } = req.body;

    // Validaciones básicas
    if (!titulo || !descripcion) {
      return res.status(400).json({ 
        success: false, 
        error: 'Título y descripción son requeridos' 
      });
    }

    if (!destinatarios || !destinatarios.tipo) {
      return res.status(400).json({ 
        success: false, 
        error: 'Debe especificar destinatarios' 
      });
    }

    console.log('Procesando anuncio para:', destinatarios.tipo);

    let resultadoEnvio;
    const fechaEnvio = new Date();

    // ENVIAR NOTIFICACIONES SEGÚN TIPO DE DESTINATARIOS
    if (destinatarios.tipo === 'todos') {
      console.log('Enviando a TODOS los usuarios activos');
      
      resultadoEnvio = await addNotification(db, {
        filtro: { estado: 'activo' },
        titulo,
        descripcion,
        prioridad,
        color,
        actionUrl
      });

    } else if (destinatarios.tipo === 'filtro') {
      console.log('Enviando por FILTROS:', destinatarios.filtro);
      
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

      resultadoEnvio = await addNotification(db, {
        filtro: condicionesFiltro,
        titulo,
        descripcion,
        prioridad,
        color,
        actionUrl
      });

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
            actionUrl
          });
          
          totalEnviados++;
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
        modificados: totalEnviados,
        errores: totalErrores,
        erroresDetalle
      };
    } else {
      return res.status(400).json({ 
        success: false, 
        error: 'Tipo de destinatario no válido' 
      });
    }

    // RESPONDER
    const respuesta = {
      success: true,
      message: `Anuncio enviado a ${resultadoEnvio.modificados || 0} usuario(s)`,
      data: {
        titulo,
        fechaEnvio,
        destinatariosEnviados: resultadoEnvio.modificados || 0,
        errores: resultadoEnvio.errores || 0
      }
    };

    console.log('Respuesta:', respuesta.message);
    res.json(respuesta);

  } catch (error) {
    console.error('ERROR en POST /api/anuncios:', error);
    
    res.status(500).json({ 
      success: false, 
      error: 'Error interno del servidor',
      detalle: error.message 
    });
  }
});

// GET /api/anuncios - Listar anuncios (vacío)
router.get('/', async (req, res) => {
  res.json({ success: true, data: [] });
});

// Test
router.get('/test', (req, res) => {
  res.json({ success: true, message: 'Endpoint funcionando' });
});

module.exports = router;