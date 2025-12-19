const express = require("express");
const router = express.Router();
const { ObjectId } = require("mongodb");
const multer = require('multer');
const { addNotification } = require("../utils/notificaciones.helper");
const { generarAnexoDesdeRespuesta } = require("../utils/generador.helper");
const { enviarCorreoRespaldo } = require("../utils/mailrespaldo.helper");
const { validarToken } = require("../utils/validarToken.js");
const { createBlindIndex, verifyPassword, decrypt } = require("../utils/seguridad.helper");
const { sendEmail } = require("../utils/mail.helper");

// Función para normalizar nombres de archivos (versión completa y segura)
const normalizeFilename = (filename) => {
  if (typeof filename !== 'string') {
    filename = String(filename || `documento_sin_nombre_${Date.now()}`);
  }

  const lastDotIndex = filename.lastIndexOf('.');
  let extension = '';
  let nameWithoutExt = filename;

  if (lastDotIndex > 0 && lastDotIndex < filename.length - 1) {
    extension = filename.substring(lastDotIndex + 1);
    nameWithoutExt = filename.substring(0, lastDotIndex);
  }

  if (extension) {
    extension = extension
      .replace(/[^a-zA-Z0-9]/g, '')
      .substring(0, 10)
      .toLowerCase();
  }

  if (!extension) extension = 'bin';

  let normalized = nameWithoutExt
    .replace(/á/g, 'a').replace(/é/g, 'e').replace(/í/g, 'i')
    .replace(/ó/g, 'o').replace(/ú/g, 'u').replace(/ü/g, 'u')
    .replace(/Á/g, 'A').replace(/É/g, 'E').replace(/Í/g, 'I')
    .replace(/Ó/g, 'O').replace(/Ú/g, 'U').replace(/Ü/g, 'U')
    .replace(/ñ/g, 'n').replace(/Ñ/g, 'N').replace(/ç/g, 'c').replace(/Ç/g, 'C')
    .replace(/[^a-zA-Z0-9\s._-]/g, '')
    .replace(/\s+/g, '_')
    .substring(0, 100)
    .replace(/^_+|_+$/g, '');

  if (!normalized || normalized.length === 0) {
    normalized = `documento_${Date.now()}`;
  }

  return `${normalized}.${extension}`;
};

// Configurar Multer para almacenar en memoria (buffer)
const upload = multer({
  storage: multer.memoryStorage(),
  fileFilter: function (req, file, cb) {
    if (file.mimetype === 'application/pdf') {
      cb(null, true);
    } else {
      cb(new Error('Solo se permiten archivos PDF'), false);
    }
  },
  limits: {
    fileSize: 10 * 1024 * 1024 // 10MB límite por archivo
  }
});

// Configurar Multer para múltiples archivos
const uploadMultiple = multer({
  storage: multer.memoryStorage(),
  fileFilter: function (req, file, cb) {
    if (file.mimetype === 'application/pdf') {
      cb(null, true);
    } else {
      cb(new Error('Solo se permiten archivos PDF'), false);
    }
  },
  limits: {
    fileSize: 10 * 1024 * 1024, // 10MB límite por archivo
    files: 10 // Máximo 10 archivos
  }
});

router.use(express.json({ limit: '4mb' }));

// En el endpoint POST principal (/) - SOLO FORMATO ESPECÍFICO
router.post("/", async (req, res) => {
  try {
    const { formId, user, responses, formTitle, adjuntos = [], mail: correoRespaldo } = req.body;
    
    // El usuario que viene del frontend ya debería estar descifrado en su sesión, 
    // pero para la lógica interna usamos sus datos.
    const usuario = user?.nombre; 
    const empresa = user?.empresa;
    const userId = user?.uid;
    const token = user?.token;

    console.log("=== INICIO GUARDAR RESPUESTA ===");

    const tokenValido = await validarToken(req.db, token);
    if (!tokenValido.ok) {
      return res.status(401).json({ error: tokenValido.reason });
    }

    const form = await req.db.collection("forms").findOne({ _id: new ObjectId(formId) });
    if (!form) return res.status(404).json({ error: "Formulario no encontrado" });

    const empresaAutorizada = form.companies?.includes(empresa) || form.companies?.includes("Todas");
    if (!empresaAutorizada) {
      return res.status(403).json({ error: `La empresa ${empresa} no está autorizada.` });
    }

    // Insertar respuesta principal. 
    // Nota: El objeto 'user' aquí se guarda como viene, pero el mail se busca por Blind Index si fuera necesario.
    const result = await req.db.collection("respuestas").insertOne({
      formId,
      user, 
      responses,
      formTitle,
      mail: correoRespaldo,
      status: "pendiente",
      createdAt: new Date()
    });

    if (adjuntos.length > 0) {
      await req.db.collection("adjuntos").insertOne({
        responseId: result.insertedId,
        submittedAt: new Date().toISOString(),
        adjuntos: []
      });
    }

    // Enviar correo de respaldo
    if (correoRespaldo && correoRespaldo.trim() !== '') {
      await enviarCorreoRespaldo(correoRespaldo, formTitle, user, responses, form.questions);
    }

    // Notificaciones (RRHH y Admin)
    const notifData = {
      titulo: `${usuario} de la empresa ${empresa} ha respondido el formulario ${formTitle}`,
      descripcion: adjuntos.length > 0 ? `Incluye ${adjuntos.length} archivo(s)` : "Revisar en panel.",
      prioridad: 2,
      color: "#bb8900ff",
      icono: "form",
      actionUrl: `/RespuestasForms?id=${result.insertedId}`,
    };
    await addNotification(req.db, { filtro: { cargo: "RRHH" }, ...notifData });
    await addNotification(req.db, { filtro: { cargo: "admin" }, ...notifData });

    // Notificación al usuario
    await addNotification(req.db, {
      userId,
      titulo: "Formulario completado",
      descripcion: `El formulario ${formTitle} fue completado correctamente.`,
      prioridad: 2,
      icono: "CheckCircle",
      color: "#006e13ff",
      actionUrl: `/?id=${result.insertedId}`,
    });

    try {
      await generarAnexoDesdeRespuesta(responses, result.insertedId.toString(), req.db, form.section, {
        nombre: usuario,
        empresa: empresa,
        uid: userId,
      }, formId, formTitle);
    } catch (error) {
      console.error("Error generando documento:", error.message);
    }

    res.json({ _id: result.insertedId, formId, user, responses, formTitle, mail: correoRespaldo });

  } catch (err) {
    res.status(500).json({ error: "Error al guardar respuesta: " + err.message });
  }
});

router.post("/admin", async (req, res) => {
  try {
    const { formId, user: adminUser, responses, formTitle, adjuntos = [], mail: correoRespaldo } = req.body;

    const destinatarioNombre = responses?.Destinatario;
    const destinatarioEmpresa = responses?.EmpresaDestino;

    if (!destinatarioNombre || !destinatarioEmpresa) {
      return res.status(400).json({ error: "Destinatario y empresa requeridos." });
    }

    const tokenValido = await validarToken(req.db, adminUser?.token);
    if (!tokenValido.ok) return res.status(401).json({ error: tokenValido.reason });

    // --- BÚSQUEDA PQC DEL USUARIO DESTINATARIO ---
    // Buscamos por mail_index porque el mail original está cifrado
    const userDestinatario = await req.db.collection("usuarios").findOne({
      mail_index: createBlindIndex(correoRespaldo),
    });

    if (!userDestinatario) {
      return res.status(404).json({ error: `Destinatario no encontrado con el correo: ${correoRespaldo}` });
    }

    // Desciframos los datos para construir el objeto de respuesta correctamente
    const destinatarioUserObject = {
      uid: userDestinatario._id.toString(),
      nombre: decrypt(userDestinatario.nombre),
      empresa: userDestinatario.empresa, // Si empresa no está cifrada
      mail: correoRespaldo,
    };

    const form = await req.db.collection("forms").findOne({ _id: new ObjectId(formId) });
    if (!form) return res.status(404).json({ error: "Formulario no encontrado" });

    const now = new Date();
    const result = await req.db.collection("respuestas").insertOne({
      formId,
      user: destinatarioUserObject,
      responses,
      formTitle,
      mail: correoRespaldo,
      status: "pendiente",
      createdAt: now,
      updatedAt: now,
      injectedBy: adminUser?.uid,
    });

    if (adjuntos.length > 0) {
      await req.db.collection("adjuntos").insertOne({
        responseId: result.insertedId,
        submittedAt: now.toISOString(),
        adjuntos: []
      });
    }

    if (correoRespaldo) {
      await enviarCorreoRespaldo(correoRespaldo, formTitle, destinatarioUserObject, responses, form.questions);
    }

    // Notificaciones
    await addNotification(req.db, {
      filtro: { cargo: "RRHH" },
      titulo: `Solicitud creada para ${destinatarioNombre}`,
      descripcion: `El administrador ${adminUser?.nombre} creó "${formTitle}".`,
      prioridad: 2, color: "#bb8900ff", icono: "form",
      actionUrl: `/RespuestasForms?id=${result.insertedId}`,
    });

    await addNotification(req.db, {
      userId: destinatarioUserObject.uid,
      titulo: "Nueva Solicitud Administrativa",
      descripcion: `Tienes una nueva solicitud pendiente: ${formTitle}.`,
      prioridad: 2, icono: "Warning", color: "#ff8c00ff",
      actionUrl: `/?id=${result.insertedId}`,
    });

    try {
      await generarAnexoDesdeRespuesta(responses, result.insertedId.toString(), req.db, form.section, destinatarioUserObject, formId, formTitle);
    } catch (error) {
      console.error("Error generando documento:", error.message);
    }

    res.json({ _id: result.insertedId, formId, user: destinatarioUserObject, responses, formTitle, mail: correoRespaldo });

  } catch (err) {
    res.status(500).json({ error: "Error Admin: " + err.message });
  }
});

// Obtener adjuntos de una respuesta específica
router.get("/:id/adjuntos", async (req, res) => {
  try {
    const { id } = req.params;

    const adjuntos = await req.db.collection("adjuntos")
      .findOne({ responseId: new ObjectId(id) });

    res.json(adjuntos);

  } catch (err) {
    console.error("Error obteniendo adjuntos:", err);
    res.status(500).json({ error: "Error obteniendo adjuntos" });
  }
});

// Subir adjunto individual - MISMO NOMBRE PARA FRONTEND
router.post("/:id/adjuntos", async (req, res) => {
  try {
    const { id } = req.params;
    const { adjunto, index, total } = req.body;

    console.log(`Subiendo adjunto ${index + 1} de ${total} para respuesta:`, id);

    if (!adjunto || typeof index === 'undefined' || !total) {
      return res.status(400).json({
        error: "Faltan campos: adjunto, index o total"
      });
    }

    // Verificar que la respuesta existe
    const respuestaExistente = await req.db.collection("respuestas").findOne({
      _id: new ObjectId(id)
    });

    if (!respuestaExistente) {
      return res.status(404).json({ error: "Respuesta no encontrada" });
    }

    // Crear el objeto adjunto con el formato específico
    const adjuntoNormalizado = {
      pregunta: adjunto.pregunta || "Adjuntar documento aquí",
      fileName: normalizeFilename(adjunto.fileName),
      fileData: adjunto.fileData,
      mimeType: adjunto.mimeType || 'application/pdf',
      size: adjunto.size || 0,
      uploadedAt: new Date().toISOString()
    };

    console.log(`Procesando adjunto ${index + 1}:`, {
      fileName: adjuntoNormalizado.fileName,
      size: adjuntoNormalizado.size
    });

    // Buscar el documento de adjuntos
    const documentoAdjuntos = await req.db.collection("adjuntos").findOne({
      responseId: new ObjectId(id)
    });

    if (!documentoAdjuntos) {
      // Si no existe, crear uno nuevo con el formato específico
      const nuevoDocumento = {
        responseId: new ObjectId(id),
        submittedAt: new Date().toISOString(),
        adjuntos: [adjuntoNormalizado]
      };

      await req.db.collection("adjuntos").insertOne(nuevoDocumento);
      console.log(`Creado nuevo documento con primer adjunto`);
    } else {
      // Si existe, agregar al array manteniendo el formato
      await req.db.collection("adjuntos").updateOne(
        { responseId: new ObjectId(id) },
        {
          $push: { adjuntos: adjuntoNormalizado }
        }
      );
      console.log(`Adjunto ${index + 1} agregado al documento existente`);
    }

    res.json({
      success: true,
      message: `Adjunto ${index + 1} de ${total} subido exitosamente`,
      fileName: adjuntoNormalizado.fileName
    });

  } catch (error) {
    console.error('Error subiendo adjunto individual:', error);
    res.status(500).json({
      error: `Error subiendo adjunto: ${error.message}`
    });
  }
});

router.get("/:id/adjuntos/:index", async (req, res) => {
  try {
    const { id, index } = req.params;

    console.log("Descargando adjunto:", { id, index });

    let query = {};

    if (ObjectId.isValid(id)) {
      query.responseId = new ObjectId(id);
    } else {
      return res.status(400).json({ error: "ID de respuesta inválido" });
    }

    const documentoAdjunto = await req.db.collection("adjuntos").findOne(query);

    if (!documentoAdjunto) {
      console.log("Adjunto no encontrado con query:", query);
      return res.status(404).json({ error: "Archivo adjunto no encontrado" });
    }

    let archivoAdjunto;

    if (documentoAdjunto.adjuntos && documentoAdjunto.adjuntos.length > 0) {
      archivoAdjunto = documentoAdjunto.adjuntos[parseInt(index)];
    } else if (documentoAdjunto.fileData) {
      archivoAdjunto = documentoAdjunto;
    } else {
      return res.status(404).json({ error: "Estructura de archivo no válida" });
    }

    if (!archivoAdjunto.fileData) {
      return res.status(404).json({ error: "Datos de archivo no disponibles" });
    }

    // Extraer datos base64
    const base64Data = archivoAdjunto.fileData.replace(/^data:[^;]+;base64,/, '');
    const buffer = Buffer.from(base64Data, 'base64');

    // Configurar headers para descarga
    res.set({
      'Content-Type': archivoAdjunto.mimeType || 'application/pdf',
      'Content-Disposition': `attachment; filename="${archivoAdjunto.fileName}"`,
      'Content-Length': buffer.length,
      'Cache-Control': 'no-cache'
    });

    res.send(buffer);

  } catch (err) {
    console.error("Error descargando archivo adjunto:", err);
    res.status(500).json({ error: "Error descargando archivo adjunto: " + err.message });
  }
});

router.get("/", async (req, res) => {
  try {
    const answers = await req.db.collection("respuestas").find().toArray();
    res.json(answers);
  } catch (err) {
    res.status(500).json({ error: "Error al obtener formularios" });
  }
});

router.get("/mail/:mail", async (req, res) => {
  try {
    const cleanMail = req.params.mail.toLowerCase().trim();
    // No buscamos por "user.mail" directo porque ese valor en respuestas 
    // podría ser plano o cifrado según cuando se guardó, pero el Blind Index 
    // en la colección de usuarios es nuestra fuente de verdad.
    
    // Primero validamos si el usuario existe para obtener su UID
    const user = await req.db.collection("usuarios").findOne({ mail_index: createBlindIndex(cleanMail) });
    
    if (!user) return res.status(404).json({ error: "Usuario no encontrado" });

    // Ahora buscamos en respuestas por el UID del usuario (que es inmutable)
    const answers = await req.db.collection("respuestas").find({ "user.uid": user._id.toString() }).toArray();

    if (!answers || answers.length === 0) {
      return res.status(404).json({ error: "No se encontraron formularios" });
    }

    if (!answers || answers.length === 0) {
      return res.status(404).json({ error: "No se encontraron formularios para este email" });
    }

    // Procesar las respuestas en JavaScript
    const answersProcessed = answers.map(answer => {
      let trabajador = "No especificado";

      if (answer.responses) {
        trabajador = answer.responses["Nombre del trabajador"] ||
          answer.responses["NOMBRE DEL TRABAJADOR"] ||
          answer.responses["nombre del trabajador"]
      }

      return {
        _id: answer._id,
        formId: answer.formId,
        formTitle: answer.formTitle,
        trabajador: trabajador,
        user: answer.user,
        status: answer.status,
        createdAt: answer.createdAt,
        approvedAt: answer.approvedAt,
        updatedAt: answer.updatedAt
      };
    });

    res.json(answersProcessed);
  } catch (err) {
    res.status(500).json({ error: "Error al obtener por email" });
  }
});

router.get("/mini", async (req, res) => {
  try {
    const answers = await req.db.collection("respuestas")
      .find({})
      .project({
        _id: 1,
        formId: 1,
        formTitle: 1,
        "responses": 1,
        submittedAt: 1,
        "user.nombre": 1,
        "user.empresa": 1,
        status: 1,
        createdAt: 1,
        adjuntosCount: 1
      })
      .toArray();

    // Procesar las respuestas en JavaScript
    const answersProcessed = answers.map(answer => {
      let trabajador = "No especificado";

      if (answer.responses) {
        trabajador = answer.responses["Nombre del trabajador"] ||
          answer.responses["NOMBRE DEL TRABAJADOR"] ||
          answer.responses["nombre del trabajador"] ||
          answer.responses["Nombre del Trabajador"] ||
          answer.responses["Nombre Del trabajador "] ||
          "No especificado";
      }

      let rutTrabajador = "No especificado";

      if (answer.responses) {
        rutTrabajador = answer.responses["RUT del trabajador"] ||
          answer.responses["RUT DEL TRABAJADOR"] ||
          answer.responses["rut del trabajador"] ||
          answer.responses["Rut del Trabajador"] ||
          answer.responses["Rut Del trabajador "] ||
          "No especificado";
      }

      return {
        _id: answer._id,
        formId: answer.formId,
        formTitle: answer.formTitle,
        trabajador: trabajador,
        rutTrabajador: rutTrabajador,
        submittedAt: answer.submittedAt,
        user: answer.user,
        status: answer.status,
        createdAt: answer.createdAt,
        adjuntosCount: answer.adjuntosCount || 0
      };
    });

    res.json(answersProcessed);
  } catch (err) {
    console.error("Error en /mini:", err);
    res.status(500).json({ error: "Error al obtener formularios" });
  }
});

router.get("/:id", async (req, res) => {
  try {
    const form = await req.db.collection("respuestas")
      .findOne({ _id: new ObjectId(req.params.id) });

    if (!form) return res.status(404).json({ error: "Formulario no encontrado" });

    res.json(form);

  } catch (err) {
    res.status(500).json({ error: "Error al obtener formulario" });
  }
});

router.get("/section/:section", async (req, res) => {
  try {
    const forms = await req.db
      .collection("respuestas")
      .find({ section: req.params.section })
      .toArray();

    if (!forms.length)
      return res.status(404).json({ error: "No se encontraron formularios en esta sección" });

    res.status(200).json(forms);
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: "Error al obtener formularios por sección" });
  }
});

//actualizar respuesta
router.put("/:id", async (req, res) => {
  try {
    const result = await req.db.collection("respuestas").findOneAndUpdate(
      { _id: new ObjectId(req.params.id) },
      { $set: { ...req.body, updatedAt: new Date() } },
      { returnDocument: "after" }
    );

    if (!result.value) return res.status(404).json({ error: "Formulario no encontrado" });
    res.json(result.value);
  } catch (err) {
    res.status(500).json({ error: "Error al actualizar formulario" });
  }
});

//publicar formulario
router.put("/public/:id", async (req, res) => {
  try {
    const result = await req.db.collection("respuestas").findOneAndUpdate(
      { _id: new ObjectId(req.params.id) },
      {
        $set: {
          status: "publicado",
          updatedAt: new Date()
        }
      },
      { returnDocument: "after" }
    );

    if (!result.value)
      return res.status(404).json({ error: "Formulario no encontrado" });

    res.status(200).json(result.value);
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: "Error al publicar formulario" });
  }
});

//eliminar respuesta
router.delete("/:id", async (req, res) => {
  try {
    const responseId = req.params.id;

    // Eliminar de todas las colecciones relacionadas
    const [resultRespuestas, resultDocxs, resultAprobados, resultFirmados, resultAdjuntos] = await Promise.all([
      // Eliminar de respuestas
      req.db.collection("respuestas").deleteOne({ _id: new ObjectId(responseId) }),

      // Eliminar de docxs (si existe)
      req.db.collection("docxs").deleteOne({ responseId: responseId }),

      // Eliminar de aprobados (si existe)
      req.db.collection("aprobados").deleteOne({ responseId: responseId }),

      // Eliminar de firmados (si existe)
      req.db.collection("firmados").deleteOne({ responseId: responseId }),

      // Eliminar adjuntos (si existen)
      req.db.collection("adjuntos").deleteOne({ responseId: new ObjectId(responseId) })
    ]);

    // Verificar si al menos se eliminó la respuesta principal
    if (resultRespuestas.deletedCount === 0) {
      return res.status(404).json({ error: "Respuesta no encontrada" });
    }

    res.status(200).json({
      message: "Formulario y todos los datos relacionados eliminados",
      deleted: {
        respuestas: resultRespuestas.deletedCount,
        docxs: resultDocxs.deletedCount,
        aprobados: resultAprobados.deletedCount,
        firmados: resultFirmados.deletedCount,
        adjuntos: resultAdjuntos.deletedCount
      }
    });
  } catch (err) {
    console.error("Error eliminando respuesta y datos relacionados:", err);
    res.status(500).json({ error: "Error al eliminar formulario" });
  }
});

//solicitar de mensajes
router.get("/:formId/chat/admin", async (req, res) => {
  try {
    const { formId } = req.params;

    let query;
    if (ObjectId.isValid(formId)) {
      query = { $or: [{ _id: new ObjectId(formId) }, { formId }] };
    } else {
      query = { formId };
    }

    const respuesta = await req.db
      .collection("respuestas")
      .findOne(query, { projection: { mensajes: 1 } });

    if (!respuesta) {
      return res.status(404).json({ error: "No se encontró la respuesta con ese formId o _id" });
    }

    res.json(respuesta.mensajes || []);
  } catch (err) {
    console.error("Error obteniendo chat:", err);
    res.status(500).json({ error: "Error al obtener chat" });
  }
});

router.get("/:formId/chat/", async (req, res) => {
  try {
    const { formId } = req.params;

    let query;
    if (ObjectId.isValid(formId)) {
      query = { $or: [{ _id: new ObjectId(formId) }, { formId }] };
    } else {
      query = { formId };
    }

    const respuesta = await req.db
      .collection("respuestas")
      .findOne(query, { projection: { mensajes: 1 } });

    if (!respuesta) {
      return res.status(404).json({ error: "No se encontró la respuesta con ese formId o _id" });
    }

    const todosLosMensajes = respuesta.mensajes || [];

    const mensajesGenerales = todosLosMensajes.filter(msg => !msg.admin);

    res.json(mensajesGenerales);

  } catch (err) {
    console.error("Error obteniendo chat general:", err);
    res.status(500).json({ error: "Error al obtener chat general" });
  }
});

//enviar mensaje
router.post("/chat", async (req, res) => {
    try {
      const { formId, autor, mensaje, admin } = req.body;
      if (!autor || !mensaje || !formId) return res.status(400).json({ error: "Faltan campos" });
  
      const nuevoMensaje = { autor, mensaje, leido: false, fecha: new Date(), admin: admin || false };
  
      let query = ObjectId.isValid(formId) ? { $or: [{ _id: new ObjectId(formId) }, { formId }] } : { formId };
      const respuesta = await req.db.collection("respuestas").findOne(query);
      if (!respuesta) return res.status(404).json({ error: "Respuesta no encontrada" });
  
      await req.db.collection("respuestas").updateOne({ _id: respuesta._id }, { $push: { mensajes: nuevoMensaje } });
  
      if (respuesta?.user?.nombre === autor) {
        const notifChat = {
          filtro: { cargo: "RRHH" },
          titulo: "Nuevo mensaje en formulario",
          descripcion: `${autor} ha enviado un mensaje.`,
          icono: "Edit", color: "#45577eff",
          actionUrl: `/RespuestasForms?id=${respuesta._id}`,
        };
        await addNotification(req.db, notifChat);
        await addNotification(req.db, { ...notifChat, filtro: { cargo: "admin" } });
      } else {
        await addNotification(req.db, {
          userId: respuesta.user.uid,
          titulo: "Nuevo mensaje recibido",
          descripcion: `${autor} le ha enviado un mensaje.`,
          icono: "MessageCircle", color: "#45577eff",
          actionUrl: `/?id=${respuesta._id}`,
        });
      }
      res.json({ message: "Mensaje enviado", data: nuevoMensaje });
    } catch (err) {
      res.status(500).json({ error: "Error en chat" });
    }
});

router.put("/chat/marcar-leidos", async (req, res) => {
  try {
    const result = await req.db.collection("respuestas").updateMany(
      { "mensajes.leido": false },
      { $set: { "mensajes.$[].leido": true } }
    );

    res.json({
      message: "Todos los mensajes fueron marcados como leídos",
      result,
    });
  } catch (err) {
    console.error("Error al marcar mensajes como leídos:", err);
    res.status(500).json({ error: "Error al marcar mensajes como leídos" });
  }
});

// Subir corrección PDF (se mantiene por compatibilidad)
router.post("/:id/upload-correction", upload.single('correctedFile'), async (req, res) => {
  try {
    if (!req.file) return res.status(400).json({ error: "No se subió ningún archivo" });

    const respuesta = await req.db.collection("respuestas").findOne({ _id: new ObjectId(req.params.id) });
    if (!respuesta) return res.status(404).json({ error: "Respuesta no encontrada" });

    // Buscar usuario por el UID guardado en la respuesta
    const user = await req.db.collection("usuarios").findOne({ _id: new ObjectId(respuesta.user.uid) });

    const normalizedFileName = normalizeFilename(req.file.originalname);

    const result = await req.db.collection("respuestas").updateOne(
      { _id: new ObjectId(req.params.id) },
      {
        $set: {
          hasCorrection: true,
          correctionFileName: normalizedFileName,
          fileData: req.file.buffer, // Considerar cifrar aquí si el PDF es sensible
          updatedAt: new Date()
        }
      }
    );

    if (user) {
      const userNombre = decrypt(user.nombre);
      const userMail = decrypt(user.mail);

      const htmlContent = `
          <div style="font-family: sans-serif; color: #333;">
              <h2 style="color: #f97316;">Nueva Corrección Disponible</h2>
              <p>Hola <strong>${userNombre}</strong>,</p>
              <p>Se ha subido una corrección para: <strong>${respuesta.formTitle}</strong>.</p>
              <p>Archivo: ${normalizedFileName}</p>
              <p>Saludos, Equipo Acciona</p>
          </div>`;

      try {
        await sendEmail({ to: userMail, subject: 'Notificación de Corrección', html: htmlContent });
      } catch (e) { console.error("Error mail:", e); }
    }

    res.json({ success: true, message: "Corrección subida", fileName: normalizedFileName });
  } catch (err) {
    res.status(500).json({ error: "Error subiendo corrección" });
  }
});

router.get("/:id/finalized", async (req, res) => {
  try {
    const { id } = req.params;

    if (!ObjectId.isValid(id)) {
      return res.status(400).json({ error: "ID de respuesta inválido" });
    }

    const respuesta = await req.db.collection("respuestas").findOne({
      _id: new ObjectId(id)
    });

    if (!respuesta) {
      console.log("Respuesta no encontrada para ID:", id);
      return res.status(404).json({ error: "Respuesta no encontrada" });
    }

    const updateResult = await req.db.collection("respuestas").updateOne(
      { _id: new ObjectId(id) },
      {
        $set: {
          status: "finalizado",
          finalizedAt: new Date(),
          updatedAt: new Date()
        }
      }
    );

    if (updateResult.matchedCount === 0) {
      return res.status(404).json({ error: "No se pudo actualizar la respuesta" });
    }

    console.log(`Respuesta ${id} actualizada a estado: finalizado`);

    res.json({
      success: true,
      message: "Respuesta finalizada correctamente",
      status: "finalizado",
      responseId: id
    });

  } catch (err) {
    console.error("Error finalizando respuesta:", err);
    res.status(500).json({ error: "Error finalizando respuesta: " + err.message });
  }
});

router.get("/:id/archived", async (req, res) => {
  try {
    const { id } = req.params;

    if (!ObjectId.isValid(id)) {
      return res.status(400).json({ error: "ID de respuesta inválido" });
    }

    const respuesta = await req.db.collection("respuestas").findOne({
      _id: new ObjectId(id)
    });

    if (!respuesta) {
      console.log("Respuesta no encontrada para ID:", id);
      return res.status(404).json({ error: "Respuesta no encontrada" });
    }

    const updateResult = await req.db.collection("respuestas").updateOne(
      { _id: new ObjectId(id) },
      {
        $set: {
          status: "archivado",
          archivedAt: new Date(),
          updatedAt: new Date()
        }
      }
    );

    if (updateResult.matchedCount === 0) {
      return res.status(404).json({ error: "No se pudo actualizar la respuesta" });
    }

    console.log(`Respuesta ${id} actualizada a estado: archivado`);

    res.json({
      success: true,
      message: "Respuesta archivada correctamente",
      status: "archivado",
      responseId: id
    });

  } catch (err) {
    console.error("Error archivando respuesta:", err);
    res.status(500).json({ error: "Error archivando respuesta: " + err.message });
  }
});

// ============ NUEVOS ENDPOINTS PARA MÚLTIPLES ARCHIVOS ============

// 1. SUBIR MÚLTIPLES ARCHIVOS CORREGIDOS
// Cambia el endpoint para recibir archivos uno por uno
router.post("/upload-corrected-files", async (req, res) => {
  try {
    console.log("=== DEBUG BACKEND - HEADERS ===");
    console.log("Content-Type:", req.headers['content-type']);

    uploadMultiple.array('files', 10)(req, res, async (err) => {
      if (err) {
        console.error("Error en uploadMultiple:", err);
        return res.status(400).json({ error: err.message });
      }

      // VERIFICAR SI SE RECIBIERON FILES
      console.log("Files recibidos:", req.files ? req.files.length : 'NONE');
      console.log("Body fields:", Object.keys(req.body));
      console.log("responseId:", req.body.responseId);
      console.log("index:", req.body.index, "type:", typeof req.body.index);
      console.log("total:", req.body.total, "type:", typeof req.body.total);

      const { responseId, index, total } = req.body;
      const files = req.files;

      // VALIDACIONES MEJORADAS
      if (!responseId) {
        return res.status(400).json({ error: 'responseId es requerido' });
      }

      if (!files || !Array.isArray(files) || files.length === 0) {
        return res.status(400).json({
          error: 'No se subió ningún archivo',
          filesReceived: files ? files.length : 0
        });
      }

      // PROCESAR CADA ARCHIVO (por si llegan múltiples en una petición)
      for (const file of files) {
        console.log(`Procesando archivo: ${file.originalname}, size: ${file.size}`);

        const correctedFile = {
          fileName: normalizeFilename(file.originalname),
          tipo: 'pdf',
          fileData: file.buffer,
          fileSize: file.size,
          mimeType: file.mimetype,
          uploadedAt: new Date(),
          order: parseInt(index) + 1 || 1
        };

        // BUSCAR O CREAR DOCUMENTO
        const existingApproval = await req.db.collection("aprobados").findOne({
          responseId: responseId
        });

        if (existingApproval) {
          // USAR findOneAndUpdate para retornar el documento actualizado
          const result = await req.db.collection("aprobados").findOneAndUpdate(
            { responseId: responseId },
            {
              $push: { correctedFiles: correctedFile },
              $set: { updatedAt: new Date() }
            },
            { returnDocument: 'after' }
          );
          console.log(`Archivo agregado. Total ahora:`, result.value?.correctedFiles?.length);
        } else {
          await req.db.collection("aprobados").insertOne({
            responseId: responseId,
            correctedFiles: [correctedFile],
            createdAt: new Date(),
            updatedAt: new Date(),
            approvedAt: null,
            approvedBy: null
          });
          console.log(`Nuevo documento creado con 1 archivo`);
        }
      }

      res.json({
        success: true,
        message: `Archivo(s) subido(s) exitosamente`,
        filesProcessed: files.length
      });
    });
  } catch (error) {
    console.error('Error completo:', error);
    res.status(500).json({ error: `Error: ${error.message}` });
  }
});

// 2. OBTENER TODOS LOS ARCHIVOS CORREGIDOS DE UNA RESPUESTA
router.get("/corrected-files/:responseId", async (req, res) => {
  try {
    const { responseId } = req.params;

    const approvedDoc = await req.db.collection("aprobados").findOne({
      responseId: responseId
    }, {
      projection: {
        correctedFiles: 1,
        formTitle: 1
      }
    });

    if (!approvedDoc || !approvedDoc.correctedFiles) {
      return res.json({
        correctedFiles: [],
        formTitle: null
      });
    }

    // Ordenar archivos por order si existe, sino por uploadedAt
    const sortedFiles = approvedDoc.correctedFiles.sort((a, b) => {
      if (a.order && b.order) return a.order - b.order;
      return new Date(a.uploadedAt) - new Date(b.uploadedAt);
    });

    // Retornar información sin los datos binarios
    const filesInfo = sortedFiles.map(file => ({
      fileName: file.fileName,
      fileSize: file.fileSize,
      mimeType: file.mimeType,
      uploadedAt: file.uploadedAt,
      order: file.order || 1,
      tipo: file.tipo
    }));

    res.json({
      correctedFiles: filesInfo,
      formTitle: approvedDoc.formTitle,
      totalFiles: filesInfo.length
    });

  } catch (error) {
    console.error('Error obteniendo archivos corregidos:', error);
    res.status(500).json({ error: `Error obteniendo archivos: ${error.message}` });
  }
});

// 3. DESCARGAR ARCHIVO CORREGIDO ESPECÍFICO
router.get("/download-corrected-file/:responseId", async (req, res) => {
  try {
    const { responseId } = req.params;
    const { fileName, index } = req.query;

    const approvedDoc = await req.db.collection("aprobados").findOne({
      responseId: responseId
    });

    if (!approvedDoc || !approvedDoc.correctedFiles || approvedDoc.correctedFiles.length === 0) {
      return res.status(404).json({ error: "No se encontraron archivos corregidos" });
    }

    let file;

    if (fileName) {
      file = approvedDoc.correctedFiles.find(f => f.fileName === fileName);
    } else if (index !== undefined) {
      const fileIndex = parseInt(index);
      if (isNaN(fileIndex) || fileIndex < 0 || fileIndex >= approvedDoc.correctedFiles.length) {
        return res.status(400).json({ error: "Índice de archivo inválido" });
      }
      file = approvedDoc.correctedFiles[fileIndex];
    } else {
      return res.status(400).json({ error: "Se requiere fileName o index" });
    }

    if (!file) {
      return res.status(404).json({ error: "Archivo no encontrado" });
    }

    res.setHeader('Content-Type', file.mimeType || 'application/pdf');
    res.setHeader('Content-Disposition', `attachment; filename="${file.fileName}"`);
    res.setHeader('Content-Length', file.fileSize);
    res.setHeader('Cache-Control', 'no-cache');

    res.send(file.fileData.buffer || file.fileData);

  } catch (err) {
    console.error("Error descargando archivo corregido:", err);
    res.status(500).json({ error: "Error descargando archivo: " + err.message });
  }
});

// 4. ELIMINAR ARCHIVO CORREGIDO ESPECÍFICO
router.delete("/delete-corrected-file/:responseId", async (req, res) => {
  try {
    const { responseId } = req.params;
    const { fileName } = req.body;

    if (!fileName) {
      return res.status(400).json({ error: "fileName es requerido" });
    }

    const approvedDoc = await req.db.collection("aprobados").findOne({
      responseId: responseId
    });

    if (!approvedDoc || !approvedDoc.correctedFiles) {
      return res.status(404).json({ error: "No se encontraron archivos corregidos" });
    }

    const fileExists = approvedDoc.correctedFiles.some(f => f.fileName === fileName);
    if (!fileExists) {
      return res.status(404).json({ error: "Archivo no encontrado" });
    }

    // Guardar información del estado actual antes de eliminar
    const respuestaActual = await req.db.collection("respuestas").findOne({
      _id: new ObjectId(responseId)
    });

    const estadoActual = respuestaActual?.status;
    const tieneFirma = await req.db.collection("firmados").findOne({
      responseId: responseId
    });

    // Eliminar el archivo específico del array
    const result = await req.db.collection("aprobados").updateOne(
      { responseId: responseId },
      {
        $pull: {
          correctedFiles: { fileName: fileName }
        },
        $set: { updatedAt: new Date() }
      }
    );

    if (result.modifiedCount === 0) {
      return res.status(404).json({ error: "No se pudo eliminar el archivo" });
    }

    // Verificar si quedan archivos después de eliminar
    const updatedDoc = await req.db.collection("aprobados").findOne({
      responseId: responseId
    });

    // Si no quedan archivos, eliminar el documento completo y cambiar estado
    if (!updatedDoc.correctedFiles || updatedDoc.correctedFiles.length === 0) {
      await req.db.collection("aprobados").deleteOne({ responseId: responseId });

      // Determinar el nuevo estado
      let nuevoEstado = "en_revision";

      // Solo cambiar a 'en_revision' si actualmente está en 'aprobado' o 'firmado'
      // y NO hay firma existente
      if ((estadoActual === 'aprobado' || estadoActual === 'firmado') && !tieneFirma) {
        nuevoEstado = "en_revision";
      } else if (estadoActual === 'firmado' && tieneFirma) {
        // Si hay firma, mantener en 'firmado' pero sin correcciones
        nuevoEstado = "firmado";
      } else if (estadoActual === 'finalizado' || estadoActual === 'archivado') {
        // No cambiar estados finales
        nuevoEstado = estadoActual;
      }

      await req.db.collection("respuestas").updateOne(
        { _id: new ObjectId(responseId) },
        {
          $set: {
            hasCorrection: false,
            status: nuevoEstado,
            updatedAt: new Date()
          }
        }
      );

      // Enviar notificación si cambió el estado
      if (nuevoEstado === 'en_revision' && estadoActual !== 'en_revision') {
        await addNotification(req.db, {
          filtro: { cargo: "RRHH" },
          titulo: `Correcciones eliminadas - Volviendo a revisión`,
          descripcion: `Se eliminaron todas las correcciones del formulario ${respuestaActual?.formTitle}. El estado ha vuelto a 'en_revision'.`,
          prioridad: 2,
          icono: 'RefreshCw',
          color: '#ff9800',
          actionUrl: `/RespuestasForms?id=${responseId}`,
        });

        await addNotification(req.db, {
          userId: respuestaActual?.user?.uid,
          titulo: "Documento vuelve a revisión",
          descripcion: `Las correcciones del formulario ${respuestaActual?.formTitle} han sido eliminadas. El documento está nuevamente en revisión.`,
          prioridad: 2,
          icono: 'RefreshCw',
          color: '#ff9800',
          actionUrl: `/?id=${responseId}`,
        });
      }

      res.json({
        success: true,
        message: "Archivo eliminado exitosamente. No quedan archivos corregidos.",
        deletedFile: fileName,
        statusChanged: nuevoEstado !== estadoActual,
        newStatus: nuevoEstado,
        hadFiles: false
      });

    } else {
      // Si aún quedan archivos, solo actualizar la fecha
      await req.db.collection("respuestas").updateOne(
        { _id: new ObjectId(responseId) },
        {
          $set: {
            updatedAt: new Date()
          }
        }
      );

      res.json({
        success: true,
        message: "Archivo eliminado exitosamente",
        deletedFile: fileName,
        remainingFiles: updatedDoc.correctedFiles.length,
        hadFiles: true
      });
    }

  } catch (err) {
    console.error("Error eliminando archivo corregido:", err);
    res.status(500).json({ error: "Error eliminando archivo: " + err.message });
  }
});

// 5. APROBAR FORMULARIO CON MÚLTIPLES ARCHIVOS (MODIFICADO)
router.post("/:id/approve", async (req, res) => {
  try {
    const responseId = req.params.id;
    console.log("=== INICIO APPROVE CON MÚLTIPLES ARCHIVOS ===", responseId);

    const respuesta = await req.db.collection("respuestas").findOne({
      _id: new ObjectId(responseId)
    });

    if (!respuesta) {
      console.log("Respuesta no encontrada para ID:", responseId);
      return res.status(404).json({ error: "Respuesta no encontrada" });
    }

    // Verificar que existan archivos corregidos en la colección 'aprobados'
    const approvedDoc = await req.db.collection("aprobados").findOne({
      responseId: responseId
    });

    if (!approvedDoc || !approvedDoc.correctedFiles || approvedDoc.correctedFiles.length === 0) {
      console.log("No hay archivos corregidos para aprobar:", responseId);
      return res.status(400).json({
        error: "No hay archivos corregidos para aprobar. Debe subir al menos un archivo PDF primero."
      });
    }

    console.log(`Aprobando respuesta ${responseId} con ${approvedDoc.correctedFiles.length} archivo(s)`);

    const existingSignature = await req.db.collection("firmados").findOne({
      responseId: responseId
    });

    let nuevoEstado = "aprobado";
    if (existingSignature) {
      console.log("Existe documento firmado, saltando directamente a estado 'firmado'");
      nuevoEstado = "firmado";
    }

    // Actualizar el documento en 'aprobados' con la información de aprobación
    await req.db.collection("aprobados").updateOne(
      { responseId: responseId },
      {
        $set: {
          approvedAt: new Date(),
          approvedBy: req.user?.id,
          updatedAt: new Date()
        }
      }
    );

    // Actualizar la respuesta principal
    const updateResult = await req.db.collection("respuestas").updateOne(
      { _id: new ObjectId(responseId) },
      {
        $set: {
          status: nuevoEstado,
          approvedAt: new Date(),
          updatedAt: new Date()
        },
        $unset: {
          correctedFile: ""
        }
      }
    );

    // Enviar notificación al usuario
    await addNotification(req.db, {
      userId: respuesta.user?.uid,
      titulo: "Documento Aprobado",
      descripcion: `Se ha aprobado el documento asociado al formulario ${respuesta.formTitle} con ${approvedDoc.correctedFiles.length} archivo(s)`,
      prioridad: 2,
      icono: 'file-text',
      color: '#47db34ff',
      actionUrl: `/?id=${responseId}`,
    });

    res.json({
      message: existingSignature
        ? `Formulario aprobado y restaurado a estado firmado (existía firma previa) con ${approvedDoc.correctedFiles.length} archivo(s)`
        : `Formulario aprobado correctamente con ${approvedDoc.correctedFiles.length} archivo(s)`,
      approved: true,
      status: nuevoEstado,
      hadExistingSignature: !!existingSignature,
      totalFiles: approvedDoc.correctedFiles.length
    });

  } catch (err) {
    console.error("Error aprobando formulario:", err);
    res.status(500).json({ error: "Error aprobando formulario: " + err.message });
  }
});

// 6. OBTENER DATOS DE ARCHIVOS APROBADOS (MODIFICADO)
router.get("/data-approved/:responseId", async (req, res) => {
  try {
    const { responseId } = req.params;

    console.log("Obteniendo datos de archivos aprobados para:", responseId);

    const approvedDoc = await req.db.collection("aprobados").findOne({
      responseId: responseId
    });

    if (!approvedDoc) {
      console.log("No se encontró documento aprobado para responseId:", responseId);
      return res.status(404).json({ error: "Documento aprobado no encontrado" });
    }

    if (!approvedDoc.correctedFiles || approvedDoc.correctedFiles.length === 0) {
      console.log("No hay archivos corregidos en el documento aprobado:", responseId);
      return res.status(404).json({ error: "Archivos corregidos no disponibles" });
    }

    // Retornar información de todos los archivos
    const filesInfo = approvedDoc.correctedFiles.map(file => ({
      fileName: file.fileName,
      fileSize: file.fileSize,
      mimeType: file.mimeType,
      uploadedAt: file.uploadedAt,
      order: file.order || 1,
      tipo: file.tipo
    }));

    const responseData = {
      correctedFiles: filesInfo,
      approvedAt: approvedDoc.approvedAt,
      formTitle: approvedDoc.formTitle,
      totalFiles: filesInfo.length
    };

    console.log("Datos retornados para responseId:", responseId, responseData);

    res.json(responseData);

  } catch (err) {
    console.error("Error obteniendo datos de archivos aprobados:", err);
    res.status(500).json({ error: "Error obteniendo datos de archivos aprobados: " + err.message });
  }
});

// 7. DESCARGAR PDF APROBADO - CORREGIDO
router.get("/download-approved-pdf/:responseId", async (req, res) => {
  try {
    const { responseId } = req.params;
    const { index } = req.query;

    console.log("Descargando PDF aprobado para:", responseId, "index:", index);

    const approvedDoc = await req.db.collection("aprobados").findOne({
      responseId: responseId
    });

    if (!approvedDoc) {
      return res.status(404).json({ error: "Documento aprobado no encontrado" });
    }

    if (!approvedDoc.correctedFiles || approvedDoc.correctedFiles.length === 0) {
      return res.status(404).json({ error: "Archivos PDF no disponibles" });
    }

    let file;
    if (index !== undefined) {
      const fileIndex = parseInt(index);
      if (isNaN(fileIndex) || fileIndex < 0 || fileIndex >= approvedDoc.correctedFiles.length) {
        return res.status(400).json({ error: "Índice de archivo inválido" });
      }
      file = approvedDoc.correctedFiles[fileIndex];
    } else {
      file = approvedDoc.correctedFiles[0];
    }

    if (!file || !file.fileData) {
      return res.status(404).json({ error: "Archivo PDF no disponible" });
    }

    // DEPURACIÓN: Ver qué datos tenemos realmente
    console.log("DEBUG - File object:", {
      hasFileName: !!file.fileName,
      fileName: file.fileName,
      fileSize: file.fileSize,
      mimeType: file.mimeType,
      tipo: file.tipo
    });

    // CORREGIDO: Asegurar que fileName existe
    const fileName = file.fileName || `documento_aprobado_${responseId}.pdf`;

    res.setHeader('Content-Type', file.mimeType || 'application/pdf');
    res.setHeader('Content-Disposition', `attachment; filename="${fileName}"`);
    res.setHeader('Content-Length', file.fileSize || (file.fileData.buffer ? file.fileData.buffer.length : file.fileData.length));
    res.setHeader('Cache-Control', 'no-cache');

    // Enviar los datos correctamente
    const fileBuffer = file.fileData.buffer || file.fileData;
    res.send(fileBuffer);

    console.log(`PDF aprobado enviado: ${fileName}`);

  } catch (err) {
    console.error("Error descargando PDF aprobado:", err);
    res.status(500).json({ error: "Error descargando PDF aprobado: " + err.message });
  }
});

// 8. ELIMINAR CORRECCIÓN (MODIFICADO)
router.delete("/:id/remove-correction", async (req, res) => {
  try {
    const responseId = req.params.id;
    console.log("=== INICIO REMOVE-CORRECTION PARA MÚLTIPLES ARCHIVOS ===", responseId);

    const existingSignature = await req.db.collection("firmados").findOne({
      responseId: responseId
    });

    const respuestaActual = await req.db.collection("respuestas").findOne({
      _id: new ObjectId(responseId)
    });

    let nuevoEstado = "en_revision";

    // Determinar nuevo estado según si hay firma
    if (existingSignature) {
      nuevoEstado = "firmado";
      console.log("Existe documento firmado, manteniendo estado 'firmado'");
    } else if (respuestaActual?.status === 'finalizado' || respuestaActual?.status === 'archivado') {
      nuevoEstado = respuestaActual.status;
    }

    // Eliminar el documento completo de 'aprobados'
    const deleteResult = await req.db.collection("aprobados").deleteOne({
      responseId: responseId
    });

    console.log("Resultado de la eliminación en aprobados:", deleteResult);

    // Actualizar la respuesta principal
    const updateResult = await req.db.collection("respuestas").updateOne(
      { _id: new ObjectId(responseId) },
      {
        $set: {
          status: nuevoEstado,
          updatedAt: new Date()
        },
        $unset: {
          correctedFile: "",
          hasCorrection: ""
        }
      }
    );

    console.log("Resultado de actualización en respuestas:", updateResult);

    if (updateResult.matchedCount === 0) {
      console.log("No se encontró la respuesta con ID:", responseId);
      return res.status(404).json({ error: "Respuesta no encontrada" });
    }

    const updatedResponse = await req.db.collection("respuestas").findOne({
      _id: new ObjectId(responseId)
    });

    res.json({
      message: "Corrección eliminada exitosamente",
      updatedRequest: updatedResponse,
      hasExistingSignature: !!existingSignature,
      deletedFiles: deleteResult.deletedCount > 0 ? "Todos los archivos fueron eliminados" : "No había archivos para eliminar",
      newStatus: nuevoEstado
    });

  } catch (err) {
    console.error("Error eliminando corrección:", err);
    res.status(500).json({ error: "Error eliminando corrección: " + err.message });
  }
});

// 9. Subir PDF firmado por cliente a colección firmados y cambiar estado de respuesta a 'firmado'
router.post("/:responseId/upload-client-signature", upload.single('signedPdf'), async (req, res) => {
  try {
    const { responseId } = req.params;

    if (!req.file) {
      return res.status(400).json({ error: "No se subió ningún archivo" });
    }

    const respuesta = await req.db.collection("respuestas").findOne({
      _id: new ObjectId(responseId)
    });

    if (!respuesta) {
      return res.status(404).json({ error: "Formulario no encontrado" });
    }

    const existingSignature = await req.db.collection("firmados").findOne({
      responseId: responseId
    });

    if (existingSignature) {
      return res.status(400).json({ error: "Ya existe un documento firmado para este formulario" });
    }

    const normalizedFileName = normalizeFilename(req.file.originalname);

    const signatureData = {
      fileName: normalizedFileName,
      fileData: req.file.buffer,
      fileSize: req.file.size,
      mimeType: req.file.mimetype,
      uploadedAt: new Date(),
      signedBy: respuesta.responses['Nombre del trabajador'],
      clientName: respuesta.submittedBy || respuesta.user?.nombre,
      clientEmail: respuesta.userEmail || respuesta.user?.mail
    };

    const result = await req.db.collection("firmados").insertOne({
      responseId: responseId,
      formId: respuesta.formId,
      formTitle: respuesta.formTitle,
      clientSignedPdf: signatureData,
      status: "uploaded",
      uploadedAt: new Date(),
      createdAt: new Date(),
      updatedAt: new Date(),
      company: respuesta.company
    });

    const updateResult = await req.db.collection("respuestas").updateOne(
      { _id: new ObjectId(responseId) },
      {
        $set: {
          status: "firmado",
          signedAt: new Date()
        }
      }
    );

    await addNotification(req.db, {
      filtro: { cargo: "RRHH" },
      titulo: `Documento ${respuesta.formTitle} Firmado`,
      descripcion: `se ha recibido el Documento Firmado asociado al Formulario ${respuesta.formTitle} ${respuesta.responses['Nombre del trabajador']}`,
      prioridad: 2,
      icono: 'Pen',
      color: '#dbca34ff',
      actionUrl: `/RespuestasForms?id=${respuesta._id}`,
    });

    res.json({
      success: true,
      message: "Documento firmado subido exitosamente",
      signatureId: result.insertedId
    });

  } catch (err) {
    console.error("Error subiendo firma del cliente:", err);
    res.status(500).json({ error: "Error subiendo firma del cliente" });
  }
});

// 10. Obtener PDF firmado por cliente SIN cambiar estado - CORREGIDO
router.get("/:responseId/client-signature", async (req, res) => {
  try {
    const { responseId } = req.params;

    console.log(`Descargando documento firmado para: ${responseId}`);

    const signature = await req.db.collection("firmados").findOne({
      responseId: responseId
    });

    if (!signature) {
      console.log(`No se encontró documento firmado para responseId: ${responseId}`);
      return res.status(404).json({ error: "Documento firmado no encontrado" });
    }

    const pdfData = signature.clientSignedPdf;

    if (!pdfData || !pdfData.fileData) {
      console.log(`Documento firmado sin datos para responseId: ${responseId}`);
      return res.status(404).json({ error: "Archivo PDF no disponible" });
    }

    // DEPURACIÓN: Ver qué datos tenemos realmente
    console.log("DEBUG - PDF Data:", {
      hasFileName: !!pdfData.fileName,
      fileName: pdfData.fileName,
      fileSize: pdfData.fileSize,
      mimeType: pdfData.mimeType
    });

    // Obtener el buffer de datos
    const fileBuffer = pdfData.fileData.buffer || pdfData.fileData;

    if (!fileBuffer || fileBuffer.length === 0) {
      console.log(`Buffer de archivo vacío para responseId: ${responseId}`);
      return res.status(404).json({ error: "Datos del archivo no disponibles" });
    }

    // CORREGIDO: Usar el fileName real, no el por defecto
    const fileName = pdfData.fileName || `documento_firmado_${responseId}.pdf`;
    const encodedFileName = encodeURIComponent(fileName);

    res.setHeader('Content-Type', pdfData.mimeType || 'application/pdf');
    res.setHeader('Content-Disposition', `attachment; filename="${fileName}"; filename*=UTF-8''${encodedFileName}`);
    res.setHeader('Content-Length', pdfData.fileSize || fileBuffer.length);
    res.setHeader('Cache-Control', 'no-cache, no-store, must-revalidate');
    res.setHeader('Pragma', 'no-cache');
    res.setHeader('Expires', '0');

    console.log(`Enviando documento firmado: ${fileName}, tamaño: ${pdfData.fileSize || fileBuffer.length} bytes`);

    res.send(fileBuffer);

  } catch (err) {
    console.error("Error descargando documento firmado:", err);
    res.status(500).json({
      error: "Error descargando documento firmado: " + err.message
    });
  }
});

// 11. Eliminar PDF firmado por cliente y volver al estado 'aprobado'
router.delete("/:responseId/client-signature", async (req, res) => {
  try {
    const { responseId } = req.params;

    const deleteResult = await req.db.collection("firmados").deleteOne({
      responseId: responseId
    });

    if (deleteResult.deletedCount === 0) {
      return res.status(404).json({ error: "Documento firmado no encontrado" });
    }

    const updateResult = await req.db.collection("respuestas").updateOne(
      { _id: new ObjectId(responseId) },
      {
        $set: {
          status: "aprobado",
          updatedAt: new Date()
        }
      }
    );

    res.json({
      success: true,
      message: "Documento firmado eliminado exitosamente"
    });

  } catch (err) {
    console.error("Error eliminando firma del cliente:", err);
    res.status(500).json({ error: "Error eliminando firma del cliente" });
  }
});

// 12. Verificar si existe PDF firmado para una respuesta específica
router.get("/:responseId/has-client-signature", async (req, res) => {
  try {
    const { responseId } = req.params;

    const signature = await req.db.collection("firmados").findOne({
      responseId: responseId
    }, {
      projection: {
        "clientSignedPdf.fileName": 1,
        "clientSignedPdf.uploadedAt": 1,
        "clientSignedPdf.fileSize": 1,
        status: 1
      }
    });

    if (!signature) {
      return res.json({ exists: false });
    }

    res.json({
      exists: true,
      signature: {
        fileName: signature.clientSignedPdf.fileName,
        uploadedAt: signature.clientSignedPdf.uploadedAt,
        fileSize: signature.clientSignedPdf.fileSize,
        status: signature.status
      }
    });

  } catch (err) {
    console.error("Error verificando firma del cliente:", err);
    res.status(500).json({ error: "Error verificando documento firmado" });
  }
});

// 13. Endpoint para regenerar documento desde respuestas existentes
router.post("/:id/regenerate-document", async (req, res) => {
  try {
    const { id } = req.params;

    console.log(`Regenerando documento para respuesta: ${id}`);

    const respuesta = await req.db.collection("respuestas").findOne({
      _id: new ObjectId(id)
    });

    if (!respuesta) {
      return res.status(404).json({ error: "Respuesta no encontrada" });
    }

    const form = await req.db.collection("forms").findOne({
      _id: new ObjectId(respuesta.formId)
    });

    if (!form) {
      return res.status(404).json({ error: "Formulario original no encontrado" });
    }

    console.log(`Regenerando documento para formulario: ${form.title}`);

    try {
      await generarAnexoDesdeRespuesta(
        respuesta.responses,
        respuesta._id.toString(),
        req.db,
        form.section,
        {
          nombre: respuesta.user?.nombre,
          empresa: respuesta.user?.empresa,
          uid: respuesta.user?.uid
        },
        respuesta.formId,
        respuesta.formTitle
      );

      console.log(`Documento regenerado exitosamente para respuesta: ${id}`);

      res.json({
        success: true,
        message: "Documento regenerado exitosamente",
        responseId: id,
        formTitle: respuesta.formTitle
      });

    } catch (generationError) {
      console.error("Error en generación de documento:", generationError);
      return res.status(500).json({
        error: "Error regenerando documento: " + generationError.message
      });
    }

  } catch (error) {
    console.error('Error regenerando documento:', error);
    res.status(500).json({ error: error.message });
  }
});

// 14. Cambiar estado de respuesta (avanzar o retroceder)
router.put("/:id/status", async (req, res) => {
  try {
    const { id } = req.params;
    const { status } = req.body;

    if (!ObjectId.isValid(id)) {
      return res.status(400).json({ error: "ID de respuesta inválido" });
    }

    if (!status) {
      return res.status(400).json({ error: "Estado requerido" });
    }

    // Validar estados permitidos
    const estadosPermitidos = ['pendiente', 'en_revision', 'aprobado', 'firmado', 'finalizado', 'archivado'];
    if (!estadosPermitidos.includes(status)) {
      return res.status(400).json({ error: "Estado no válido" });
    }

    const respuesta = await req.db.collection("respuestas").findOne({
      _id: new ObjectId(id)
    });

    if (!respuesta) {
      return res.status(404).json({ error: "Respuesta no encontrada" });
    }

    // Configurar campos según el estado
    const updateData = {
      status: status,
      updatedAt: new Date()
    };

    // Agregar timestamp específico según el estado
    if (status === 'en_revision') {
      updateData.reviewedAt = new Date();
    } else if (status === 'aprobado') {
      updateData.approvedAt = new Date();
    } else if (status === 'firmado') {
      updateData.signedAt = new Date();
    } else if (status === 'finalizado') {
      updateData.finalizedAt = new Date();
    } else if (status === 'archivado') {
      updateData.archivedAt = new Date();
    }

    const updateResult = await req.db.collection("respuestas").updateOne(
      { _id: new ObjectId(id) },
      { $set: updateData }
    );

    if (updateResult.matchedCount === 0) {
      return res.status(404).json({ error: "No se pudo actualizar la respuesta" });
    }

    const updatedResponse = await req.db.collection("respuestas").findOne({
      _id: new ObjectId(id)
    });

    // Enviar notificación al usuario si aplica
    if (status === 'en_revision') {
      await addNotification(req.db, {
        userId: respuesta?.user?.uid,
        titulo: "Respuestas En Revisión",
        descripcion: `Formulario ${respuesta.formTitle} ha cambiado su estado a En Revisión.`,
        prioridad: 2,
        icono: 'FileText',
        color: '#00c6f8ff',
        actionUrl: `/?id=${id}`,
      });
    }

    res.json({
      success: true,
      message: `Estado cambiado a '${status}'`,
      updatedRequest: updatedResponse
    });

  } catch (err) {
    console.error("Error cambiando estado:", err);
    res.status(500).json({ error: "Error cambiando estado: " + err.message });
  }
});

module.exports = router;