const express = require("express");
const router = express.Router();
const { ObjectId } = require("mongodb");
const { addNotification } = require("../utils/notificaciones.helper");
const { createBlindIndex, verifyPassword, decrypt } = require("../utils/seguridad.helper");

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
      actionUrl = null,
      destinatarios,
      enviarNotificacion = true, // Por defecto true para compatibilidad
      enviarCorreo = false
    } = req.body;

    // Validación: al menos un método debe estar seleccionado
    if (enviarNotificacion === false && !enviarCorreo) {
      return res.status(400).json({
        success: false,
        error: 'Debe seleccionar al menos un método de envío (notificación o correo)'
      });
    }

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

    console.log('Métodos seleccionados:', {
      notificacion: enviarNotificacion,
      correo: enviarCorreo
    });

    let resultadoEnvio = { modificados: 0, errores: 0 };
    const fechaEnvio = new Date();
    let usuariosParaCorreo = [];

    // 1. ENVIAR NOTIFICACIONES (si está seleccionado)
    if (enviarNotificacion !== false) {
      console.log('📨 Procesando envío de notificaciones...');

      if (destinatarios.tipo === 'todos') {
        console.log('Enviando notificaciones a TODOS los usuarios activos');

        const resultadoNotificacion = await addNotification(db, {
          filtro: { estado: 'activo' },
          titulo,
          descripcion,
          prioridad,
          color,
          actionUrl
        });

        resultadoEnvio.modificados = resultadoNotificacion.modifiedCount || 0;

        // Obtener usuarios para correo si también se enviará por correo
        if (enviarCorreo) {
          usuariosParaCorreo = await db.collection('usuarios')
            .find({ estado: 'activo' })
            .project({ mail: 1 })
            .toArray();
        }

      } else if (destinatarios.tipo === 'filtro') {
        // ... (mantener lógica existente de filtros)
        // IMPORTANTE: Dentro de cada caso, si enviarCorreo es true,
        // debes guardar los usuarios encontrados en usuariosParaCorreo

      } else if (destinatarios.tipo === 'manual') {
        // ... (mantener lógica existente de manual)
        // IMPORTANTE: Similar a los casos anteriores
      }

      console.log('Resultado notificaciones:', resultadoEnvio);
    }

    // 2. ENVIAR CORREOS (si está seleccionado)
    let resultadoCorreos = { enviados: 0, errores: 0 };
    if (enviarCorreo && usuariosParaCorreo.length > 0) {
      console.log('📧 Procesando envío de correos...');

      // Crear HTML del correo
      const htmlCorreo = `
        <div style="font-family: Arial, sans-serif; max-width: 600px; margin: 0 auto;">
          <div style="background-color: ${color}; color: white; padding: 20px; border-radius: 8px 8px 0 0;">
            <h1 style="margin: 0;">${titulo}</h1>
          </div>
          <div style="padding: 20px; background-color: #f9f9f9; border-radius: 0 0 8px 8px;">
            <p style="font-size: 16px; line-height: 1.6; color: #333;">
              ${descripcion.replace(/\n/g, '<br>')}
            </p>
            ${actionUrl ? `
            <div style="margin-top: 20px;">
              <a href="${actionUrl}" style="display: inline-block; background-color: ${color}; color: white; padding: 10px 20px; text-decoration: none; border-radius: 4px; font-weight: bold;">
                Ver más detalles
              </a>
            </div>
            ` : ''}
            <hr style="border: none; border-top: 1px solid #ddd; margin: 20px 0;">
            <p style="font-size: 12px; color: #666;">
              Este es un mensaje automático. Por favor, no responda a este correo.
            </p>
          </div>
        </div>
      `;

      // Enviar correos en lotes (para no sobrecargar)
      const lotes = [];
      for (let i = 0; i < usuariosParaCorreo.length; i += 10) {
        lotes.push(usuariosParaCorreo.slice(i, i + 10));
      }

      for (const lote of lotes) {
        try {
          const emails = lote.map(u => u.mail).filter(email => email);

          const respuesta = await fetch('https://back-vercel-iota.vercel.app/api/mail/send', {
            method: 'POST',
            headers: {
              'Content-Type': 'application/json',
            },
            body: JSON.stringify({
              accessKey: process.env.MAIL_KEY,
              to: emails,
              subject: `[Anuncio] ${titulo}`,
              html: htmlCorreo,
              from: 'notificaciones@tuempresa.cl'
            })
          });

          if (respuesta.ok) {
            resultadoCorreos.enviados += emails.length;
            console.log(`Correo enviado a ${emails.length} usuarios`);
          } else {
            resultadoCorreos.errores += emails.length;
            console.error('Error enviando correo:', await respuesta.text());
          }
        } catch (error) {
          resultadoCorreos.errores += lote.length;
          console.error('Error en lote de correos:', error);
        }
      }

      console.log('Resultado correos:', resultadoCorreos);
    }

    // 3. RESPONDER AL FRONTEND
    const mensajes = [];
    if (enviarNotificacion !== false) {
      mensajes.push(`Notificaciones enviadas a ${resultadoEnvio.modificados} usuario(s)`);
    }
    if (enviarCorreo) {
      mensajes.push(`Correos enviados a ${resultadoCorreos.enviados} usuario(s)`);
    }

    const respuesta = {
      success: true,
      message: mensajes.join(' y '),
      data: {
        titulo,
        fechaEnvio,
        notificacionesEnviadas: enviarNotificacion !== false ? resultadoEnvio.modificados : 0,
        correosEnviados: enviarCorreo ? resultadoCorreos.enviados : 0,
        totalErrores: (resultadoEnvio.errores || 0) + (resultadoCorreos.errores || 0)
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