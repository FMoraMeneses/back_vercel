const express = require("express");
const router = express.Router();
const { ObjectId } = require("mongodb");
const multer = require('multer');
const { addNotification } = require("../utils/notificaciones.helper");
const { generarAnexoDesdeRespuesta } = require("../utils/generador.helper");
const { enviarCorreoRespaldo } = require("../utils/mailrespaldo.helper");
const { validarToken } = require("../utils/validarToken.js");


// Función para normalizar nombres de archivos
// Función para normalizar nombres de archivos (versión mejorada)
const normalizeFilename = (filename) => {
  if (!filename) return 'documento_sin_nombre.pdf';

  const extension = filename.split('.').pop() || 'pdf';
  const nameWithoutExt = filename.substring(0, filename.lastIndexOf('.')) || 'documento_sin_nombre';

  const normalized = nameWithoutExt
    .normalize('NFD')
    // Reemplazar caracteres especiales del español
    .replace(/ñ/g, 'n')
    .replace(/Ñ/g, 'N')
    .replace(/á/g, 'a')
    .replace(/é/g, 'e')
    .replace(/í/g, 'i')
    .replace(/ó/g, 'o')
    .replace(/ú/g, 'u')
    .replace(/Á/g, 'A')
    .replace(/É/g, 'E')
    .replace(/Í/g, 'I')
    .replace(/Ó/g, 'O')
    .replace(/Ú/g, 'U')
    .replace(/ü/g, 'u')
    .replace(/Ü/g, 'U')
    // Eliminar cualquier otro diacrítico
    .replace(/[\u0300-\u036f]/g, '')
    // Eliminar caracteres especiales restantes
    .replace(/[^a-zA-Z0-9\s._-]/g, '')
    // Reemplazar espacios múltiples por un solo guión bajo
    .replace(/\s+/g, '_')
    // Limitar longitud
    .substring(0, 100)
    // Eliminar guiones bajos al inicio/final
    .replace(/^_+|_+$/g, '');

  // Si después de normalizar queda vacío, usar nombre por defecto
  if (!normalized || normalized.length === 0) {
    return `documento_${Date.now()}.${extension}`;
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
      // SIN adjuntosCount - solo los campos básicos
    });

    console.log("✅ Respuesta principal guardada con ID:", result.insertedId);

    // Crear documento para adjuntos con el formato específico
    if (adjuntos.length > 0) {
      const documentoAdjuntos = {
        responseId: result.insertedId,
        submittedAt: new Date().toISOString(),
        adjuntos: [] // Array vacío inicial - se llenará con el endpoint individual
      };

      await req.db.collection("adjuntos").insertOne(documentoAdjuntos);
      console.log("✅ Documento de adjuntos creado (vacío)");
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
      await generarAnexoDesdeRespuesta(responses, result.insertedId.toString(), req.db, form.section, {
        nombre: usuario,
        empresa: empresa,
        uid: userId,
      }, formId, formTitle);
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
      // SIN adjuntosCount ni adjuntosPendientes
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
        adjuntos: [adjuntoNormalizado] // Array con el primer adjunto
      };

      await req.db.collection("adjuntos").insertOne(nuevoDocumento);
      console.log(`✅ Creado nuevo documento con primer adjunto`);
    } else {
      // Si existe, agregar al array manteniendo el formato
      await req.db.collection("adjuntos").updateOne(
        { responseId: new ObjectId(id) },
        {
          $push: { adjuntos: adjuntoNormalizado }
        }
      );
      console.log(`✅ Adjunto ${index + 1} agregado al documento existente`);
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

    // CORRECCIÓN: Verificar si los IDs son válidos antes de convertirlos
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

    // CORRECCIÓN: Verificar la estructura real de tus datos
    let archivoAdjunto;

    if (documentoAdjunto.adjuntos && documentoAdjunto.adjuntos.length > 0) {
      // Si usas la nueva estructura con array 'adjuntos'
      archivoAdjunto = documentoAdjunto.adjuntos[parseInt(index)];
    } else if (documentoAdjunto.fileData) {
      // Si usas la estructura antigua con campos directos
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
        "responses": 1, // Incluir todo el objeto responses para procesar después
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
      // Buscar el nombre del trabajador en diferentes formatos
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
        "responses": 1, // Incluir todo el objeto responses para procesar después
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
      // Buscar el nombre del trabajador en diferentes formatos
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
          hasCorrection: true,  // Solo bandera, no el archivo
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




// Aprobar formulario y guardar en aprobados
router.post("/:id/approve", upload.single('correctedFile'), async (req, res) => {
  try {
    console.log("Debug: Iniciando approve para ID:", req.params.id);

    const respuesta = await req.db.collection("respuestas").findOne({ _id: new ObjectId(req.params.id) });

    if (!respuesta) {
      console.log("Debug: Respuesta no encontrada para ID:", req.params.id);
      return res.status(404).json({ error: "Respuesta no encontrada" });
    }

    if (!respuesta) {
      console.log("Debug: Respuesta no encontrada para ID:", req.params.id);
      return res.status(404).json({ error: "Respuesta no encontrada" });
    }

    if (!respuesta.correctedFile && !req.file) {
      console.log("Debug: No hay corrección subida para ID:", req.params.id);
      return res.status(400).json({ error: "No hay corrección subida para aprobar" });
    }

    let correctedFileData;

    if (req.file) {
      console.log("Debug: Subiendo nuevo archivo de corrección:", req.file.originalname);

      const normalizedFileName = normalizeFilename(req.file.originalname);

      correctedFileData = {
        fileName: normalizedFileName,
        tipo: 'pdf',
        fileData: req.file.buffer,
        fileSize: req.file.size,
        mimeType: req.file.mimetype,
        uploadedAt: new Date()
      };
    } else {
      correctedFileData = respuesta.correctedFile;
      console.log("Debug: Usando corrección existente:", correctedFileData.fileName);
    }

    console.log("Debug: Aprobando respuesta con corrección:", correctedFileData.fileName);

    const existingSignature = await req.db.collection("firmados").findOne({
      responseId: req.params.id
    });

    let nuevoEstado = "aprobado";
    if (existingSignature) {
      console.log("Debug: Existe documento firmado, saltando directamente a estado 'firmado'");
      nuevoEstado = "firmado";
    }

    const updateResult = await req.db.collection("respuestas").updateOne(
      { _id: new ObjectId(req.params.id) },
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

    await addNotification(req.db, {
      userId: respuesta.user?.uid,
      titulo: "Documento Generado",
      descripcion: `Se ha generado el documento asociado al formulario ${respuesta.formTitle}`,
      prioridad: 2,
      icono: 'file-text',
      color: '#47db34ff',
      actionUrl: `/?id=${respuesta.responseId}`,
    });

    console.log("Debug: Resultado de actualización de estado:", updateResult);

    const insertResult = await req.db.collection("aprobados").insertOne({
      responseId: req.params.id,
      correctedFile: correctedFileData,
      approvedAt: new Date(),
      approvedBy: req.user?.id,
      createdAt: new Date(),
      formTitle: respuesta.formTitle,
      submittedBy: respuesta.submittedBy,
      company: respuesta.company
    });

    console.log("Debug: Resultado de inserción en aprobados:", insertResult);

    res.json({
      message: existingSignature
        ? "Formulario aprobado y restaurado a estado firmado (existía firma previa)"
        : "Formulario aprobado correctamente",
      approved: true,
      status: nuevoEstado,
      hadExistingSignature: !!existingSignature
    });

  } catch (err) {
    console.error("Error aprobando formulario:", err);
    res.status(500).json({ error: "Error aprobando formulario" });
  }
});

// Eliminar corrección de formularios APROBADOS
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

router.get("/data-approved/:responseId", async (req, res) => {
  try {
    const { responseId } = req.params;

    console.log("Obteniendo datos de archivo aprobado para:", responseId);

    const approvedDoc = await req.db.collection("aprobados").findOne({
      responseId: responseId
    });

    if (!approvedDoc) {
      console.log("No se encontró documento aprobado para responseId:", responseId);
      return res.status(404).json({ error: "Documento aprobado no encontrado" });
    }

    if (!approvedDoc.correctedFile) {
      console.log("No hay correctedFile en el documento aprobado:", responseId);
      return res.status(404).json({ error: "Archivo corregido no disponible" });
    }

    // Retornar solo los datos específicos que necesitas
    const responseData = {
      fileName: approvedDoc.correctedFile.fileName,
      fileSize: approvedDoc.correctedFile.fileSize,
      mimeType: approvedDoc.correctedFile.mimeType,
      uploadedAt: approvedDoc.correctedFile.uploadedAt,
      approvedAt: approvedDoc.approvedAt,
      formTitle: approvedDoc.formTitle
    };

    console.log("Datos retornados para responseId:", responseId, responseData);

    res.json(responseData);

  } catch (err) {
    console.error("Error obteniendo datos de archivo aprobado:", err);
    res.status(500).json({ error: "Error obteniendo datos de archivo aprobado: " + err.message });
  }
});

router.get("/download-approved-pdf/:responseId", async (req, res) => {
  try {
    const approvedDoc = await req.db.collection("aprobados").findOne({
      responseId: req.params.responseId
    });

    if (!approvedDoc) {
      return res.status(404).json({ error: "Documento aprobado no encontrado" });
    }

    if (!approvedDoc.correctedFile || !approvedDoc.correctedFile.fileData) {
      return res.status(404).json({ error: "Archivo PDF no disponible" });
    }

    // Pasar filename explícitamente como query parameter
    const fileName = approvedDoc.correctedFile.fileName;

    res.setHeader('Content-Type', approvedDoc.correctedFile.mimeType || 'application/pdf');
    res.setHeader('Content-Length', approvedDoc.correctedFile.fileSize);

    res.send(approvedDoc.correctedFile.fileData.buffer || approvedDoc.correctedFile.fileData);

  } catch (err) {
    console.error("Error descargando PDF aprobado:", err);
    res.status(500).json({ error: "Error descargando PDF aprobado" });
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

module.exports = router;