// back_vercel2/endpoints/anuncios.js
const express = require('express');
const router = express.Router();
const { ObjectId } = require('mongodb');
const { addNotification } = require('../utils/notificaciones.helper');

// POST /api/anuncios - Crear y enviar anuncio
router.post('/', async (req, res) => {
  try {
    const db = req.db;
    const {
      titulo,
      descripcion,
      prioridad = 1,
      color = '#f5872dff',
      icono = 'paper',
      actionUrl = null,
      destinatarios // { tipo: 'todos'|'filtro'|'manual', filtro: {empresas: [], cargos: [], roles: []}, usuariosManuales: [] }
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

    let resultadoEnvio;
    const fechaEnvio = new Date();

    // ENVIAR SEGÚN TIPO DE DESTINATARIOS
    if (destinatarios.tipo === 'todos') {
      // ENVIAR A TODOS LOS USUARIOS ACTIVOS
      resultadoEnvio = await addNotification(db, {
        filtro: { estado: 'activo' }, // Esto enviará a TODOS los usuarios activos
        titulo,
        descripcion,
        prioridad,
        color,
        icono,
        actionUrl
      });

    } else if (destinatarios.tipo === 'filtro') {
      // ENVIAR POR FILTROS (empresa, cargo, rol)
      const filtro = destinatarios.filtro || {};
      const condicionesFiltro = { estado: 'activo' };
      
      // Construir filtro combinado con OR (cumpla al menos un filtro)
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
      
      // Si hay condiciones OR, añadirlas
      if (orConditions.length > 0) {
        condicionesFiltro.$or = orConditions;
      }
      
      // Si no hay filtros seleccionados, enviar a todos
      if (orConditions.length === 0) {
        condicionesFiltro.estado = 'activo'; // Enviar a todos los activos
      }

      resultadoEnvio = await addNotification(db, {
        filtro: condicionesFiltro,
        titulo,
        descripcion,
        prioridad,
        color,
        icono,
        actionUrl
      });

    } else if (destinatarios.tipo === 'manual') {
      // ENVIAR A USUARIOS ESPECÍFICOS
      if (!destinatarios.usuariosManuales || destinatarios.usuariosManuales.length === 0) {
        return res.status(400).json({ 
          success: false, 
          error: 'Debe seleccionar al menos un destinatario' 
        });
      }

      let totalEnviados = 0;
      let totalErrores = 0;
      const erroresDetalle = [];

      // Enviar a cada usuario individualmente
      for (const userId of destinatarios.usuariosManuales) {
        try {
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
        } catch (error) {
          totalErrores++;
          erroresDetalle.push({
            userId,
            error: error.message
          });
          console.error(`Error al enviar a usuario ${userId}:`, error);
        }
      }

      resultadoEnvio = {
        modifiedCount: totalEnviados,
        errores: totalErrores,
        erroresDetalle
      };

    } else {
      return res.status(400).json({ 
        success: false, 
        error: 'Tipo de destinatario no válido' 
      });
    }

    // GUARDAR REGISTRO DEL ANUNCIO (opcional, para historial)
    const anuncioRegistro = {
      titulo,
      descripcion,
      prioridad,
      color,
      icono,
      actionUrl,
      destinatarios,
      fechaEnvio,
      enviadoPor: req.userEmail || 'Sistema', // Ajusta según tu autenticación
      resultado: {
        modificados: resultadoEnvio.modifiedCount || 0,
        errores: resultadoEnvio.errores || 0,
        total: (resultadoEnvio.modifiedCount || 0) + (resultadoEnvio.errores || 0)
      }
    };

    await db.collection('anuncios').insertOne(anuncioRegistro);

    // RESPONDER AL FRONTEND
    res.json({
      success: true,
      message: `Anuncio enviado exitosamente a ${resultadoEnvio.modifiedCount || 0} usuario(s)`,
      data: {
        id: anuncioRegistro._id,
        titulo,
        fechaEnvio,
        destinatariosEnviados: resultadoEnvio.modifiedCount || 0,
        errores: resultadoEnvio.errores || 0
      }
    });

  } catch (error) {
    console.error('❌ Error al enviar anuncio:', error);
    res.status(500).json({ 
      success: false, 
      error: error.message 
    });
  }
});

// GET /api/anuncios - Listar anuncios enviados (historial)
router.get('/', async (req, res) => {
  try {
    const db = req.db;
    
    const anuncios = await db.collection('anuncios')
      .find({})
      .sort({ fechaEnvio: -1 })
      .limit(100) // Limitar para no sobrecargar
      .toArray();
    
    // Formatear respuesta
    const anunciosFormateados = anuncios.map(anuncio => ({
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
    }));
    
    res.json({
      success: true,
      data: anunciosFormateados
    });
    
  } catch (error) {
    console.error('Error al obtener anuncios:', error);
    res.status(500).json({ 
      success: false, 
      error: error.message 
    });
  }
});

module.exports = router;