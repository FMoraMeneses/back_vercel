const express = require("express");
const router = express.Router();
const { ObjectId } = require("mongodb");
const { addNotification } = require("../utils/notificaciones.helper");
const { createBlindIndex, verifyPassword, decrypt } = require("../utils/seguridad.helper");
const { sendEmail } = require("../utils/mail.helper");

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
      destinatarios,
      enviarCorreo = false,
      enviarNotificacion = true
    } = req.body;

    const urlNotificaciones = actionUrl || "https://infoacciona.cl/";

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

    if (!enviarCorreo && !enviarNotificacion) {
      console.log('Validación fallida: ningún método de envío seleccionado');
      return res.status(400).json({
        success: false,
        error: 'Debe seleccionar al menos un método de envío (notificación o correo)'
      });
    }

    console.log('Enviar correo:', enviarCorreo);
    console.log('Enviar notificación:', enviarNotificacion);
    console.log('Procesando destinatarios tipo:', destinatarios.tipo);

    let resultadoEnvio;
    const fechaEnvio = new Date();

    if (destinatarios.tipo === 'todos') {
      console.log('Enviando a TODOS los usuarios activos');

      resultadoEnvio = await addNotification(db, {
        filtro: { estado: 'activo' },
        titulo,
        descripcion,
        prioridad,
        color,
        icono,
        actionUrl
      });

      if (enviarCorreo) {
        const usuarios = await db
          .collection("usuarios")
          .find({ estado: "activo", mail: { $exists: true } })
          .project({ mail: 1 })
          .toArray();
    
        console.log('Usuarios encontrados para correo:', usuarios.length);
        
        for (const user of usuarios) {
          if (user.mail) {
            try {
              const emailDecrypted = decrypt(user.mail);
              console.log('Email desencriptado:', emailDecrypted);
              
              if (emailDecrypted && emailDecrypted.includes('@')) {
                await sendEmail({
                  to: emailDecrypted,
                  subject: titulo,
                  html: `
                    <p>${descripcion}</p>
                    <br/>
                    <a 
                      href="${urlNotificaciones}" 
                      style="display:inline-block;padding:10px 16px;background:#2563eb;color:#fff;text-decoration:none;border-radius:6px;"
                    >
                      Ver notificación en la plataforma
                    </a>
                  `
                });
                console.log('Correo enviado a:', emailDecrypted);
              }
            } catch (emailError) {
              console.error("Error enviando correo:", emailError.message);
            }
          }
        }
      }

      console.log('Notificación enviada a todos:', resultadoEnvio);

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

      console.log('Filtro construido:', condicionesFiltro);

      resultadoEnvio = await addNotification(db, {
        filtro: condicionesFiltro,
        titulo,
        descripcion,
        prioridad,
        color,
        icono,
        actionUrl
      });

      if (enviarCorreo) {
        const usuarios = await db
          .collection("usuarios")
          .find(condicionesFiltro)
          .project({ mail: 1 })
          .toArray();

        console.log('Usuarios encontrados por filtro:', usuarios.length);

        for (const user of usuarios) {
          if (user.mail) {
            try {
              const emailDecrypted = decrypt(user.mail);
              
              if (emailDecrypted && emailDecrypted.includes('@')) {
                await sendEmail({
                  to: emailDecrypted,
                  subject: titulo,
                  html: `
                    <p>${descripcion}</p>
                    <br/>
                    <a 
                      href="${urlNotificaciones}" 
                      style="display:inline-block;padding:10px 16px;background:#2563eb;color:#fff;text-decoration:none;border-radius:6px;"
                    >
                      Ver notificación en la plataforma
                    </a>
                  `
                });
                console.log('Correo enviado a:', emailDecrypted);
              }
            } catch (emailError) {
              console.error("Error enviando correo:", emailError.message);
            }
          }
        }
      }

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

          if (enviarCorreo === true) {
            const user = await db
              .collection("usuarios")
              .findOne({ _id: new ObjectId(userId) });
          
            if (user?.mail) {
              try {
                const emailDecrypted = decrypt(user.mail);
                
                if (emailDecrypted && emailDecrypted.includes('@')) {
                  await sendEmail({
                    to: emailDecrypted,
                    subject: titulo,
                    html: `
                      <p>${descripcion}</p>
                      <br/>
                      <a 
                        href="${urlNotificaciones}" 
                        style="display:inline-block;padding:10px 16px;background:#2563eb;color:#fff;text-decoration:none;border-radius:6px;"
                      >
                        Ver notificación en la plataforma
                      </a>
                    `
                  });
                  console.log('Correo enviado a:', emailDecrypted);
                }
              } catch (emailError) {
                console.error("Error enviando correo:", emailError.message);
              }
            }
          }

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

router.get('/', async (req, res) => {
  console.log('GET /api/anuncios - Sin almacenamiento histórico');

  try {
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

router.get('/test', (req, res) => {
  console.log('GET /api/anuncios/test - Prueba de conexión');
  res.json({
    success: true,
    message: 'Endpoint de anuncios funcionando',
    timestamp: new Date().toISOString()
  });
});

module.exports = router;