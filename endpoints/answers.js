const express = require("express");
const router = express.Router();
const { ObjectId } = require("mongodb");
const multer = require('multer');
const { addNotification } = require("../utils/notificaciones.helper");
const { generarAnexoDesdeRespuesta } = require("../utils/generador.helper");
const { enviarCorreoRespaldo } = require("../utils/mailrespaldo.helper");
const { validarToken } = require("../utils/validarToken.js");


// Función para normalizar nombres de archivos (con mapeo de caracteres)
// Función para normalizar nombres de archivos (versión completa y segura)
const normalizeFilename = (filename) => {
  // Asegurarse de que filename sea siempre un string
  if (typeof filename !== 'string') {
    filename = String(filename || `documento_sin_nombre_${Date.now()}`);
  }

  // Manejo seguro de la extensión
  const lastDotIndex = filename.lastIndexOf('.');
  let extension = '';
  let nameWithoutExt = filename;

  if (lastDotIndex > 0 && lastDotIndex < filename.length - 1) {
    extension = filename.substring(lastDotIndex + 1);
    nameWithoutExt = filename.substring(0, lastDotIndex);
  }

  // Limpiar la extensión (solo letras y números, máximo 10 caracteres)
  if (extension) {
    extension = extension
      .replace(/[^a-zA-Z0-9]/g, '')
      .substring(0, 10)
      .toLowerCase();
  }

  // Si no hay extensión válida, usar 'bin'
  if (!extension) extension = 'bin';

  // Normalizar el nombre del archivo manteniendo mayúsculas
  let normalized = nameWithoutExt
    // Vocales con tilde (minúsculas)
    .replace(/á/g, 'a')
    .replace(/é/g, 'e')
    .replace(/í/g, 'i')
    .replace(/ó/g, 'o')
    .replace(/ú/g, 'u')
    .replace(/ü/g, 'u')
    // Vocales con tilde (mayúsculas)  
    .replace(/Á/g, 'A')
    .replace(/É/g, 'E')
    .replace(/Í/g, 'I')
    .replace(/Ó/g, 'O')
    .replace(/Ú/g, 'U')
    .replace(/Ü/g, 'U')
    // Caracteres especiales
    .replace(/ñ/g, 'n')
    .replace(/Ñ/g, 'N')
    .replace(/ç/g, 'c')
    .replace(/Ç/g, 'C')
    // Eliminar cualquier otro carácter especial (excepto letras, números, espacios, guiones, puntos)
    .replace(/[^a-zA-Z0-9\s._-]/g, '')
    // Reemplazar espacios múltiples por un solo guión bajo
    .replace(/\s+/g, '_')
    // Limitar longitud del nombre (sin contar extensión)
    .substring(0, 100)
    // Eliminar guiones bajos al inicio/final
    .replace(/^_+|_+$/g, '');

  // Si después de normalizar queda vacío, usar nombre por defecto
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
    fileSize: 10 * 1024 * 1024
  }
});

// NUEVO: Configuración para múltiples archivos
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
    fileSize: 10 * 1024 * 1024,
    files: 10 // Máximo 10 archivos
  }
});

router.use(express.json({ limit: '4mb' }));

// En el endpoint POST principal (/) - SOLO FORMATO ESPECÍFICO
router.post("/", async (req, res) => {
  try {
    const { formId, user, responses, formTitle, adjuntos = [], mail: correoRespaldo } = req.body;
    const usuario = user?.nombre;
    const empresa = user?.empresa;
    const userId = user?.uid;
    const token = user?.token;

    console.log("=== INICIO GUARDAR RESPUESTA ===");
    console.log("Cantidad de adjuntos a procesar:", adjuntos.length);

    const tokenValido = await validarToken(req.db, token);
    if (!tokenValido.ok) {
      return res.status(401).json({ error: tokenValido.reason });
    }

    const form = await req.db
      .collection("forms")
      .findOne({ _id: new ObjectId(formId) });

    if (!form) {
      return res.status(404).json({ error: "Formulario no encontrado" });
    }

    const empresaAutorizada = form.companies?.includes(empresa) || form.companies?.includes("Todas");
    if (!empresaAutorizada) {
      return res.status(403).json({
        error: `La empresa ${empresa} no está autorizada para responder este formulario.`,
      });
    }

    // Insertar respuesta principal SIN adjuntos
    const result = await req.db.collection("respuestas").insertOne({
      formId,
      user,
      responses,
      formTitle,
      mail: correoRespaldo,
      status: "pendiente",
      createdAt: new Date()
    });

    console.log("Respuesta principal guardada con ID:", result.insertedId);

    // Crear documento para adjuntos con el formato específico
    if (adjuntos.length > 0) {
      const documentoAdjuntos = {
        responseId: result.insertedId,
        submittedAt: new Date().toISOString(),
        adjuntos: []
      };

      await req.db.collection("adjuntos").insertOne(documentoAdjuntos);
      console.log("Documento de adjuntos creado (vacío)");
    }

    // El resto del código (notificaciones, generación de documento, etc.)
    let resultadoCorreo = { enviado: false };
    if (correoRespaldo && correoRespaldo.trim() !== '') {
      resultadoCorreo = await enviarCorreoRespaldo(
        correoRespaldo,
        formTitle,
        user,
        responses,
        form.questions
      );
    }

    await addNotification(req.db, {
      filtro: { cargo: "RRHH" },
      titulo: `El usuario ${usuario} de la empresa ${empresa} ha respondido el formulario ${formTitle}`,
      descripcion: adjuntos.length > 0
        ? `Incluye ${adjuntos.length} archivo(s) adjunto(s) - Procesando...`
        : "Puedes revisar los detalles en el panel de respuestas.",
      prioridad: 2,
      color: "#bb8900ff",
      icono: "form",
      actionUrl: `/RespuestasForms?id=${result.insertedId}`,
    });

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
      await generarAnexoDesdeRespuesta(
        responses,
        result.insertedId.toString(),
        req.db,
        form.section,
        {
          nombre: usuario,
          empresa: empresa,
          uid: userId
        },
        formId,
        formTitle
      );
      console.log("Documento generado automáticamente:", result.insertedId);
    } catch (error) {
      console.error("Error generando documento:", error.message);
    }

    console.log("=== FIN GUARDAR RESPUESTA PRINCIPAL ===");

    // Retornar el ID para que el frontend pueda enviar los adjuntos
    res.json({
      _id: result.insertedId,
      formId,
      user,
      responses,
      formTitle,
      mail: correoRespaldo
    });

  } catch (err) {
    console.error("Error general al guardar respuesta:", err);
    res.status(500).json({ error: "Error al guardar respuesta: " + err.message });
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
    const answers = await req.db
      .collection("respuestas")
      .find({ "user.mail": req.params.mail })
      .project({
        _id: 1,
        formId: 1,
        formTitle: 1,
        "responses": 1,
        "user.nombre": 1,
        "user.empresa": 1,
        "user.uid": 1,
        status: 1,
        createdAt: 1,
        approvedAt: 1,
        updatedAt: 1
      })
      .toArray();

    console.log("Consulta para mail:", req.params.mail);

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
    console.error("Error en /mail/:mail:", err);
    res.status(500).json({ error: "Error al obtener formularios por email" });
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

    // Obtenemos todos los mensajes primero
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

    if (!autor || !mensaje || !formId) {
      return res.status(400).json({ error: "Faltan campos: formId, autor o mensaje" });
    }

    const nuevoMensaje = {
      autor,
      mensaje,
      leido: false,
      fecha: new Date(),
      admin: admin || false
    };

    let query;
    if (ObjectId.isValid(formId)) {
      query = { $or: [{ _id: new ObjectId(formId) }, { formId }] };
    } else {
      query = { formId };
    }

    const respuesta = await req.db.collection("respuestas").findOne(query);
    if (!respuesta) {
      return res.status(404).json({ error: "No se encontró la respuesta para agregar el mensaje" });
    }

    await req.db.collection("respuestas").updateOne(
      { _id: respuesta._id },
      { $push: { mensajes: nuevoMensaje } }
    );

    if (respuesta?.user?.nombre === autor) {
      await addNotification(req.db, {
        filtro: { cargo: "RRHH" },
        titulo: "Nuevo mensaje en tu formulario",
        descripcion: `${autor} le ha enviado un mensaje respecto a un formulario.`,
        icono: "Edit",
        color: "#45577eff",
        actionUrl: `/RespuestasForms?id=${respuesta._id}`,
      });

      await addNotification(req.db, {
        filtro: { cargo: "admin" },
        titulo: "Nuevo mensaje en tu formulario",
        descripcion: `${autor} le ha enviado un mensaje respecto a un formulario.`,
        icono: "Edit",
        color: "#45577eff",
        actionUrl: `/RespuestasForms?id=${respuesta._id}`,
      });
    } else {
      await addNotification(req.db, {
        userId: respuesta.user.uid,
        titulo: "Nuevo mensaje recibido",
        descripcion: `${autor} le ha enviado un mensaje respecto a un formulario.`,
        icono: "MessageCircle",
        color: "#45577eff",
        actionUrl: `/?id=${respuesta._id}`,
      });
    }

    res.json({
      message: "Mensaje agregado correctamente y notificación enviada",
      data: nuevoMensaje,
    });
  } catch (err) {
    console.error("Error al agregar mensaje:", err);
    res.status(500).json({ error: "Error al agregar mensaje" });
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

// Subir corrección PDF
router.post("/:id/upload-correction", upload.single('correctedFile'), async (req, res) => {
  try {
    console.log("Debug: Iniciando upload-correction para ID:", req.params.id);

    if (!req.file) {
      console.log("Debug: No se subió ningún archivo");
      return res.status(400).json({ error: "No se subió ningún archivo" });
    }

    console.log("Debug: Archivo recibido:", req.file.originalname, "Tamaño:", req.file.size);

    const normalizedFileName = normalizeFilename(req.file.originalname);

    const correctionData = {
      fileName: normalizedFileName,
      tipo: 'pdf',
      fileData: req.file.buffer,
      fileSize: req.file.size,
      mimeType: req.file.mimetype,
      uploadedAt: new Date()
    };

    const result = await req.db.collection("respuestas").updateOne(
      { _id: new ObjectId(req.params.id) },
      {
        $set: {
          hasCorrection: true,
          correctionFileName: normalizedFileName,
          updatedAt: new Date()
        }
      }
    );

    console.log("Debug: Resultado de la actualización en BD:", result);

    if (result.matchedCount === 0) {
      console.log("Debug: No se encontró la respuesta con ID:", req.params.id);
      return res.status(404).json({ error: "Respuesta no encontrada" });
    }

    console.log("Debug: Corrección subida exitosamente para ID:", req.params.id);

    res.json({
      message: "Corrección subida correctamente",
      fileName: correctionData.fileName,
      fileSize: correctionData.fileSize
    });
  } catch (err) {
    console.error("Error subiendo corrección:", err);
    res.status(500).json({ error: "Error subiendo corrección" });
  }
});

router.get("/:id/finalized", async (req, res) => {
  try {
    const { id } = req.params;

    // Verificar que el ID sea válido
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

    // Verificar que el ID sea válido
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

// NUEVA FUNCIÓN HELPER: Para obtener archivos aprobados (compatible con ambos formatos)
const getApprovedFiles = (approvedDoc) => {
  const files = [];
  
  // Si tiene array correctedFiles (formato nuevo)
  if (approvedDoc.correctedFiles && Array.isArray(approvedDoc.correctedFiles)) {
    approvedDoc.correctedFiles.forEach((file, index) => {
      files.push({
        index: index,
        fileName: file.fileName,
        fileSize: file.fileSize,
        mimeType: file.mimeType || 'application/pdf',
        uploadedAt: file.uploadedAt || approvedDoc.approvedAt,
        description: file.description || `Documento ${index + 1}`,
        order: file.order || index,
        isLegacyFormat: false
      });
    });
  } 
  // Si tiene correctedFile (formato antiguo)
  else if (approvedDoc.correctedFile) {
    files.push({
      index: 0,
      fileName: approvedDoc.correctedFile.fileName,
      fileSize: approvedDoc.correctedFile.fileSize,
      mimeType: approvedDoc.correctedFile.mimeType || 'application/pdf',
      uploadedAt: approvedDoc.correctedFile.uploadedAt || approvedDoc.approvedAt,
      description: 'Documento principal',
      order: 0,
      isLegacyFormat: true
    });
  }
  
  return files;
};

// Aprobar formulario y guardar en aprobados - MODIFICADO PARA MÚLTIPLES ARCHIVOS
router.post("/:id/approve", uploadMultiple.array('correctedFiles', 10), async (req, res) => {
  try {
    console.log("Debug: Iniciando approve para ID:", req.params.id);
    console.log("Debug: Archivos recibidos:", req.files?.length || 0);

    const respuesta = await req.db.collection("respuestas").findOne({ 
      _id: new ObjectId(req.params.id) 
    });

    if (!respuesta) {
      console.log("Debug: Respuesta no encontrada para ID:", req.params.id);
      return res.status(404).json({ error: "Respuesta no encontrada" });
    }

    // COMPATIBILIDAD: Si no hay archivos, verificar correctedFile existente
    if ((!req.files || req.files.length === 0) && !respuesta.correctedFile) {
      console.log("Debug: No hay archivos para aprobar");
      return res.status(400).json({ error: "No hay archivos para aprobar" });
    }

    let correctedFilesData = [];

    // Procesar múltiples archivos nuevos
    if (req.files && req.files.length > 0) {
      console.log(`Debug: Procesando ${req.files.length} archivos nuevos`);
      
      correctedFilesData = req.files.map((file, index) => ({
        fileName: normalizeFilename(file.originalname),
        tipo: 'pdf',
        fileData: file.buffer,
        fileSize: file.size,
        mimeType: file.mimetype,
        uploadedAt: new Date(),
        order: index,
        description: req.body.descriptions?.[index] || `Documento ${index + 1}`
      }));
    }
    
    // COMPATIBILIDAD: Si hay un correctedFile existente (formato antiguo)
    // y no hay archivos nuevos, mantener el existente
    if (respuesta.correctedFile && correctedFilesData.length === 0) {
      console.log("Debug: Usando corrección existente (formato antiguo)");
      
      correctedFilesData = [{
        fileName: respuesta.correctedFile.fileName,
        tipo: respuesta.correctedFile.tipo || 'pdf',
        fileData: respuesta.correctedFile.fileData,
        fileSize: respuesta.correctedFile.fileSize,
        mimeType: respuesta.correctedFile.mimeType || 'application/pdf',
        uploadedAt: respuesta.correctedFile.uploadedAt || new Date(),
        order: 0,
        description: 'Documento principal',
        isLegacyFormat: true
      }];
    }

    console.log("Debug: Total de archivos a aprobar:", correctedFilesData.length);

    const existingSignature = await req.db.collection("firmados").findOne({
      responseId: req.params.id
    });

    let nuevoEstado = "aprobado";
    if (existingSignature) {
      console.log("Debug: Existe documento firmado, saltando directamente a estado 'firmado'");
      nuevoEstado = "firmado";
    }

    // Actualizar estado de la respuesta
    const updateResult = await req.db.collection("respuestas").updateOne(
      { _id: new ObjectId(req.params.id) },
      {
        $set: {
          status: nuevoEstado,
          approvedAt: new Date(),
          updatedAt: new Date()
        },
        $unset: {
          correctedFile: "" // Eliminar campo antiguo
        }
      }
    );

    console.log("Debug: Resultado de actualización de estado:", updateResult);

    // Verificar si ya existe un documento aprobado
    const existingApproved = await req.db.collection("aprobados").findOne({
      responseId: req.params.id
    });

    let insertOrUpdateResult;
    
    if (existingApproved) {
      // Si ya existe, ACTUALIZAR manteniendo compatibilidad
      insertOrUpdateResult = await req.db.collection("aprobados").updateOne(
        { responseId: req.params.id },
        {
          $set: {
            correctedFiles: correctedFilesData, // NUEVO: array de archivos
            // MANTENER correctedFile para compatibilidad (primer archivo)
            correctedFile: correctedFilesData[0] || null,
            approvedAt: new Date(),
            approvedBy: req.user?.id,
            updatedAt: new Date()
          }
        }
      );
      console.log("Debug: Documento aprobado actualizado");
    } else {
      // Si no existe, CREAR NUEVO con ambos formatos
      insertOrUpdateResult = await req.db.collection("aprobados").insertOne({
        responseId: req.params.id,
        correctedFiles: correctedFilesData, // NUEVO: array de archivos
        correctedFile: correctedFilesData[0] || null, // COMPATIBILIDAD: primer archivo
        approvedAt: new Date(),
        approvedBy: req.user?.id,
        createdAt: new Date(),
        formTitle: respuesta.formTitle,
        submittedBy: respuesta.submittedBy,
        company: respuesta.company
      });
      console.log("Debug: Nuevo documento aprobado creado");
    }

    // Notificación al usuario
    await addNotification(req.db, {
      userId: respuesta.user?.uid,
      titulo: "Documentos Aprobados",
      descripcion: `Se han aprobado ${correctedFilesData.length} documento(s) para el formulario ${respuesta.formTitle}`,
      prioridad: 2,
      icono: 'file-text',
      color: '#47db34ff',
      actionUrl: `/?id=${respuesta._id}`,
    });

    res.json({
      message: existingSignature
        ? `Formulario aprobado con ${correctedFilesData.length} archivo(s) y restaurado a estado firmado`
        : `Formulario aprobado con ${correctedFilesData.length} archivo(s)`,
      approved: true,
      status: nuevoEstado,
      filesCount: correctedFilesData.length,
      hadExistingSignature: !!existingSignature
    });

  } catch (err) {
    console.error("Error aprobando formulario:", err);
    res.status(500).json({ error: "Error aprobando formulario: " + err.message });
  }
});

// Eliminar corrección de formularios APROBADOS - MODIFICADO PARA MÚLTIPLES ARCHIVOS
router.delete("/:id/remove-correction", async (req, res) => {
  try {
    console.log("Debug: Iniciando remove-correction para ID:", req.params.id);
    console.log("Debug: ID recibido:", req.params.id);

    const existingSignature = await req.db.collection("firmados").findOne({
      responseId: req.params.id
    });

    if (existingSignature) {
      console.log("Debug: Existe documento firmado, procediendo con eliminación de aprobado");
    }

    const deleteResult = await req.db.collection("aprobados").deleteOne({
      responseId: req.params.id
    });

    console.log("Debug: Resultado de la eliminación en aprobados:", deleteResult);

    const updateResult = await req.db.collection("respuestas").updateOne(
      { _id: new ObjectId(req.params.id) },
      {
        $set: {
          status: "en_revision",
          updatedAt: new Date()
        },
        $unset: {
          correctedFile: ""
        }
      }
    );

    console.log("Debug: Resultado de actualización en respuestas:", updateResult);

    if (updateResult.matchedCount === 0) {
      console.log("Debug: No se encontró la respuesta con ID:", req.params.id);
      return res.status(404).json({ error: "Respuesta no encontrada" });
    }

    console.log("Debug: Estado actualizado a 'en_revision' en la base de datos para ID:", req.params.id);

    const updatedResponse = await req.db.collection("respuestas").findOne({
      _id: new ObjectId(req.params.id)
    });

    res.json({
      message: "Corrección eliminada exitosamente",
      updatedRequest: updatedResponse,
      hasExistingSignature: !!existingSignature
    });

  } catch (err) {
    console.error("Error eliminando corrección:", err);
    res.status(500).json({ error: "Error eliminando corrección" });
  }
});

// Obtener datos de archivos aprobados - MODIFICADO PARA MÚLTIPLES ARCHIVOS
router.get("/data-approved/:responseId", async (req, res) => {
  try {
    const { responseId } = req.params;

    console.log("Obteniendo datos de archivo(s) aprobado(s) para:", responseId);

    const approvedDoc = await req.db.collection("aprobados").findOne({
      responseId: responseId
    });

    if (!approvedDoc) {
      console.log("No se encontró documento aprobado para responseId:", responseId);
      return res.status(404).json({ error: "Documento aprobado no encontrado" });
    }

    // Usar helper para obtener archivos (compatible con ambos formatos)
    const files = getApprovedFiles(approvedDoc);

    if (files.length === 0) {
      console.log("No hay archivos aprobados disponibles para responseId:", responseId);
      return res.status(404).json({ error: "No hay archivos aprobados disponibles" });
    }

    // Para compatibilidad con frontend antiguo, también devolver el primer archivo
    const firstFile = files[0];

    const responseData = {
      // Datos del primer archivo (para compatibilidad con frontend antiguo)
      fileName: firstFile.fileName,
      fileSize: firstFile.fileSize,
      mimeType: firstFile.mimeType,
      uploadedAt: firstFile.uploadedAt,
      
      // Nuevos campos para múltiples archivos
      files: files,
      totalFiles: files.length,
      
      // Campos existentes
      approvedAt: approvedDoc.approvedAt,
      formTitle: approvedDoc.formTitle
    };

    console.log(`Retornando ${files.length} archivo(s) para responseId:`, responseId);

    res.json(responseData);

  } catch (err) {
    console.error("Error obteniendo datos de archivos aprobados:", err);
    res.status(500).json({ error: "Error obteniendo datos de archivos aprobados: " + err.message });
  }
});

// Descargar archivo aprobado específico - MODIFICADO PARA MÚLTIPLES ARCHIVOS
router.get("/download-approved-pdf/:responseId/:fileIndex?", async (req, res) => {
  try {
    const { responseId, fileIndex } = req.params;
    const index = fileIndex ? parseInt(fileIndex) : 0; // Por defecto, primer archivo
    
    console.log(`Debug: Descargando archivo ${index} para responseId: ${responseId}`);

    const approvedDoc = await req.db.collection("aprobados").findOne({
      responseId: responseId
    });

    if (!approvedDoc) {
      return res.status(404).json({ error: "Documento aprobado no encontrado" });
    }

    // Usar helper para obtener archivos
    const files = getApprovedFiles(approvedDoc);
    
    if (files.length === 0) {
      return res.status(404).json({ error: "No hay archivos aprobados disponibles" });
    }

    // Validar índice
    if (index < 0 || index >= files.length) {
      console.log(`Debug: Índice ${index} inválido. Total archivos: ${files.length}`);
      return res.status(400).json({ 
        error: `Índice de archivo inválido. Debe estar entre 0 y ${files.length - 1}` 
      });
    }

    const fileToDownload = files[index];
    
    // Determinar de dónde obtener los datos del archivo
    let fileData, fileSize, mimeType;
    
    if (approvedDoc.correctedFiles && Array.isArray(approvedDoc.correctedFiles) && approvedDoc.correctedFiles[index]) {
      // Formato nuevo: array correctedFiles
      fileData = approvedDoc.correctedFiles[index].fileData;
      fileSize = approvedDoc.correctedFiles[index].fileSize;
      mimeType = approvedDoc.correctedFiles[index].mimeType;
    } else if (approvedDoc.correctedFile && index === 0) {
      // Formato antiguo: correctedFile (solo para índice 0)
      fileData = approvedDoc.correctedFile.fileData;
      fileSize = approvedDoc.correctedFile.fileSize;
      mimeType = approvedDoc.correctedFile.mimeType;
    } else {
      return res.status(404).json({ error: "Archivo PDF no disponible" });
    }

    if (!fileData) {
      return res.status(404).json({ error: "Datos del archivo PDF no disponibles" });
    }

    console.log(`Debug: Descargando archivo: ${fileToDownload.fileName} (${fileSize} bytes)`);

    // Configurar headers
    res.setHeader('Content-Type', mimeType || 'application/pdf');
    res.setHeader('Content-Disposition', `attachment; filename="${fileToDownload.fileName}"`);
    res.setHeader('Content-Length', fileSize);
    res.setHeader('Cache-Control', 'no-cache');
    
    // Enviar archivo
    res.send(fileData.buffer || fileData);

  } catch (err) {
    console.error("Error descargando PDF aprobado:", err);
    res.status(500).json({ error: "Error descargando PDF aprobado: " + err.message });
  }
});

// NUEVO ENDPOINT: Obtener lista de archivos aprobados
router.get("/approved-files/:responseId", async (req, res) => {
  try {
    const { responseId } = req.params;
    
    console.log("Obteniendo archivos aprobados para:", responseId);

    const approvedDoc = await req.db.collection("aprobados").findOne({
      responseId: responseId
    });

    // Si no hay documento aprobado, devolver array vacío
    if (!approvedDoc) {
      console.log("No hay documento aprobado para responseId:", responseId);
      return res.json({
        success: true,
        files: [],
        totalFiles: 0,
        responseId: responseId
      });
    }

    // Usar helper para obtener archivos
    const files = getApprovedFiles(approvedDoc);

    res.json({
      success: true,
      files: files,
      totalFiles: files.length,
      responseId: responseId,
      formTitle: approvedDoc.formTitle
    });

  } catch (err) {
    console.error("Error obteniendo archivos aprobados:", err);
    res.status(500).json({ error: "Error obteniendo archivos aprobados: " + err.message });
  }
});

// Subir PDF firmado por cliente a colección firmados y cambiar estado de respuesta a 'firmado'
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
      actionUrl: `/RespuestasForms?id=${respuesta.responseId}`,
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

// Obtener PDF firmado por cliente Y cambiar estado a "finalizado"
router.get("/:responseId/client-signature", async (req, res) => {
  try {
    const { responseId } = req.params;

    const signature = await req.db.collection("firmados").findOne({
      responseId: responseId
    });

    if (!signature) {
      return res.status(404).json({ error: "Documento firmado no encontrado" });
    }

    const pdfData = signature.clientSignedPdf;

    if (!pdfData || !pdfData.fileData) {
      return res.status(404).json({ error: "Archivo PDF no disponible" });
    }

    // PRIMERO: Actualizar el estado a "finalizado"
    const updateResult = await req.db.collection("respuestas").updateOne(
      { _id: new ObjectId(responseId) },
      {
        $set: {
          status: "finalizado",
          finalizedAt: new Date(),
          updatedAt: new Date()
        }
      }
    );

    if (updateResult.matchedCount === 0) {
      console.warn(`No se pudo actualizar estado la para respuesta`);
    } else {
      console.log(`Estado actualizado a "finalizado"`);
    }

    // LUEGO: Enviar el archivo
    res.setHeader('Content-Type', pdfData.mimeType || 'application/pdf');
    res.setHeader('Content-Disposition', `attachment; filename="${pdfData.fileName}"`);
    res.setHeader('Content-Length', pdfData.fileSize);
    res.setHeader('Cache-Control', 'no-cache');

    res.send(pdfData.fileData.buffer || pdfData.fileData);

  } catch (err) {
    console.error("Error descargando firma del cliente:", err);
    res.status(500).json({ error: "Error descargando firma del cliente: " + err.message });
  }
});

// Eliminar PDF firmado por cliente y volver al estado 'aprobado'
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

// Verificar si existe PDF firmado para una respuesta específica
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

// Endpoint para regenerar documento desde respuestas existentes
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

// Cambiar estado de respuesta (avanzar o retroceder)
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