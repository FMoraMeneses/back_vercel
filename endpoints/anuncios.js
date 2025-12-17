const express = require("express");
const router = express.Router();
const { ObjectId } = require("mongodb");
const { addNotification } = require("../utils/notificaciones.helper");

// Nuevo endpoint para obtener información del documento por responseId
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

    // ENVIAR SEGÚN TIPO DE DESTINATARIOS
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
      
      const orConditions = [];
      
      if (filtro.empresas && filtro.empresas.length > 0) {
        orConditions.push({ empresa: { $in: filtro.empresas } });
      }
      
      if (filtro.cargos && filtro.cargos.length > 0) {
        orConditions.push({ cargo: { $in: filtro.cargos } });
      }
      
      if (filtro.roles && filtro.roles.length > 0) {
        orConditions.push({ rol: { $in: filtro.roles } });
      }
      
      if (orConditions.length > 0) {
        condicionesFiltro.$or = orConditions;
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

    } else {
      console.log('Tipo de destinatario no válido:', destinatarios.tipo);
      return res.status(400).json({ 
        success: false, 
        error: 'Tipo de destinatario no válido' 
      });
    }

    // GUARDAR REGISTRO DEL ANUNCIO
    const anuncioRegistro = {
      titulo,
      descripcion,
      prioridad,
      color,
      icono,
      actionUrl,
      destinatarios,
      fechaEnvio,
      enviadoPor: req.userEmail || req.user?.mail || 'Sistema',
      resultado: {
        modificados: resultadoEnvio.modifiedCount || 0,
        errores: resultadoEnvio.errores || 0,
        total: (resultadoEnvio.modifiedCount || 0) + (resultadoEnvio.errores || 0)
      }
    };

    console.log('Guardando registro en BD:', anuncioRegistro);
    
    const insertResult = await db.collection('anuncios').insertOne(anuncioRegistro);
    console.log('Registro guardado con ID:', insertResult.insertedId);

    // RESPONDER AL FRONTEND
    const respuesta = {
      success: true,
      message: `Anuncio enviado exitosamente a ${resultadoEnvio.modifiedCount || 0} usuario(s)`,
      data: {
        id: insertResult.insertedId,
        titulo,
        fechaEnvio,
        destinatariosEnviados: resultadoEnvio.modifiedCount || 0,
        errores: resultadoEnvio.errores || 0
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

// GET /api/anuncios - Listar anuncios enviados
router.get('/', async (req, res) => {
  console.log('GET /api/anuncios - Obteniendo historial');
  
  try {
    const db = req.db;
    
    if (!db) {
      console.error('No hay conexión a la base de datos');
      return res.status(500).json({ 
        success: false, 
        error: 'Error de conexión a la base de datos' 
      });
    }

    const anuncios = await db.collection('anuncios')
      .find({})
      .sort({ fechaEnvio: -1 })
      .limit(100)
      .toArray();

    console.log(`📊 Encontrados ${anuncios.length} anuncios`);
    
    const respuesta = {
      success: true,
      data: anuncios.map(anuncio => ({
        _id: anuncio._id,
        titulo: anuncio.titulo,
        descripcion: anuncio.descripcion,
        prioridad: anuncio.prioridad,
        color: anuncio.color,
        icono: anuncio.icono,
        fechaEnvio: anuncio.fechaEnvio,
        destinatariosTipo: anuncio.destinatarios?.tipo,
        resultado: anuncio.resultado,
        enviadoPor: anuncio.enviadoPor
      }))
    };

    console.log('Enviando respuesta GET:', { 
      cantidad: respuesta.data.length,
      primerosTitulos: respuesta.data.slice(0, 3).map(a => a.titulo)
    });
    
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