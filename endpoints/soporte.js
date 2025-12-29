const express = require("express");
const router = express.Router();
const { ObjectId } = require("mongodb");
const multer = require('multer');
const { addNotification } = require("../utils/notificaciones.helper.js");
const { generarAnexoDesdeRespuesta } = require("../utils/generador.helper.js");
const { enviarCorreoRespaldo } = require("../utils/mailrespaldo.helper.js");
const { validarToken } = require("../utils/validarToken.js");
const { createBlindIndex, verifyPassword, decrypt } = require("../utils/seguridad.helper.js");
const { sendEmail } = require("../utils/mail.helper.js");

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

const generarContenidoCorreoRespaldo = (formTitle, usuario, fecha, responses, questions) => {

  /**
   * Función para procesar preguntas y respuestas en formato texto
   * Similar a generarDocumentoTxt pero adaptado para correo
   */
  const generarContenidoRespuestas = (responses, questions) => {
    let contenido = "RESPUESTAS DEL FORMULARIO\n";
    contenido += "========================\n\n";

    // Usar la misma lógica que en generarDocumentoTxt pero estructurado por preguntas
    let index = 1;

    // Procesar preguntas principales
    const procesarPreguntas = (preguntas, nivel = 0, contexto = '') => {
      let contenidoLocal = '';
      const indent = '  '.repeat(nivel);

      preguntas.forEach((pregunta, preguntaIndex) => {
        if (!pregunta || !pregunta.title) return;

        const tituloPregunta = pregunta.title;
        const respuesta = obtenerRespuestaPorTitulo(tituloPregunta, responses);

        // Solo mostrar si tiene respuesta o es requerida
        const tieneRespuesta = respuesta !== undefined && respuesta !== null &&
          respuesta !== '' && !(Array.isArray(respuesta) && respuesta.length === 0);

        if (tieneRespuesta || pregunta.required) {
          const numeroPregunta = nivel === 0 ? `${index}.` : `  ${preguntaIndex + 1}.`;
          const tituloCompleto = contexto ? `${contexto} - ${tituloPregunta}` : tituloPregunta;

          contenidoLocal += `${indent}${numeroPregunta} ${tituloCompleto}\n`;

          // Formatear respuesta (igual que en TXT)
          if (Array.isArray(respuesta)) {
            contenidoLocal += `${indent}   - ${respuesta.join(`\n${indent}   - `)}\n\n`;
          } else if (respuesta && typeof respuesta === 'object') {
            contenidoLocal += `${indent}   ${JSON.stringify(respuesta, null, 2)}\n\n`;
          } else {
            contenidoLocal += `${indent}   ${respuesta || 'Sin respuesta'}\n\n`;
          }

          if (nivel === 0) index++;
        }

        // Procesar subsecciones (opciones con subformularios)
        if (pregunta.options) {
          pregunta.options.forEach((opcion, opcionIndex) => {
            if (typeof opcion === 'object' && opcion.hasSubform && opcion.subformQuestions) {
              const textoOpcion = opcion.text || `Opción ${opcionIndex + 1}`;
              const opcionRespuesta = obtenerRespuestaPorTitulo(pregunta.title, responses);
              const deberiaProcesar =
                pregunta.type === 'single_choice' ? opcionRespuesta === textoOpcion :
                  pregunta.type === 'multiple_choice' ? Array.isArray(opcionRespuesta) && opcionRespuesta.includes(textoOpcion) : false;

              if (deberiaProcesar) {
                contenidoLocal += procesarPreguntas(
                  opcion.subformQuestions,
                  nivel + 1,
                  `${tituloPregunta} - ${textoOpcion}`
                );
              }
            }
          });
        }
      });

      return contenidoLocal;
    };

    // Procesar preguntas principales
    contenido += procesarPreguntas(questions || []);

    // Procesar información contextual (igual que en TXT)
    if (responses._contexto && Object.keys(responses._contexto).length > 0) {
      contenido += "\n--- INFORMACIÓN DETALLADA POR SECCIÓN ---\n\n";

      Object.keys(responses._contexto).forEach(contexto => {
        contenido += `SECCIÓN: ${contexto}\n`;

        Object.keys(responses._contexto[contexto]).forEach(pregunta => {
          const respuesta = responses._contexto[contexto][pregunta];
          contenido += `   ${pregunta}: ${respuesta}\n`;
        });
        contenido += "\n";
      });
    }

    return contenido;
  };

  /**
   * Obtiene respuesta por título (igual que en la versión anterior)
   */
  const obtenerRespuestaPorTitulo = (tituloPregunta, responses) => {
    // Buscar directamente en responses
    if (responses[tituloPregunta] !== undefined) {
      return responses[tituloPregunta];
    }

    // Si no encuentra, buscar en _contexto si existe
    if (responses._contexto) {
      for (const contexto in responses._contexto) {
        if (responses._contexto[contexto][tituloPregunta] !== undefined) {
          return responses._contexto[contexto][tituloPregunta];
        }
      }
    }

    return undefined;
  };

  // Descifrar datos del usuario si están cifrados
  let nombreUsuarioDescifrado = usuario.nombre;
  let empresaDescifrada = usuario.empresa;
  
  try {
    if (usuario.nombre && usuario.nombre.includes(':')) {
      nombreUsuarioDescifrado = decrypt(usuario.nombre);
    }
    if (usuario.empresa && usuario.empresa.includes(':')) {
      empresaDescifrada = decrypt(usuario.empresa);
    }
  } catch (error) {
    console.error('Error descifrando datos del usuario para correo:', error);
  }

  // Usar el nombre del trabajador de las respuestas si está disponible
  const nombreTrabajador = responses['Nombre del trabajador'] || nombreUsuarioDescifrado;

  const contenidoRespuestas = generarContenidoRespuestas(responses, questions);

  // Contenido en texto plano (estructura similar al TXT)
  const texto = `RESPALDO DE RESPUESTAS - FORMULARIO: ${formTitle}
=================================================

INFORMACIÓN GENERAL:
-------------------
Trabajador: ${nombreTrabajador}
Empresa: ${empresaDescifrada}
Respondido por: ${nombreUsuarioDescifrado}
Fecha y hora: ${fecha}

${contenidoRespuestas}
---
Este es un respaldo automático de las respuestas enviadas.
Generado el: ${fecha}
`;

  // Contenido en HTML (manteniendo formato legible)
  const html = `
<div style="font-family: Arial, sans-serif; line-height: 1.6; color: #333;">
  <h2 style="color: #2c3e50; border-bottom: 2px solid #3498db; padding-bottom: 10px;">
    Tiket Recibido
  </h2>
  
  <div style="background: #f8f9fa; padding: 15px; border-radius: 5px; margin-bottom: 20px; border-left: 4px solid #3498db;">
    <h3 style="color: #2c3e50; margin-top: 0;">INFORMACIÓN GENERAL</h3>
    <p><strong>Trabajador:</strong> ${nombreTrabajador}</p>
    <p><strong>Empresa:</strong> ${empresaDescifrada}</p>
    <p><strong>Respondido por:</strong> ${nombreUsuarioDescifrado}</p>
    <p><strong>Fecha y hora:</strong> ${fecha}</p>
  </div>

  <div style="margin-top: 20px; padding-top: 15px; border-top: 1px dashed #ccc; color: #7f8c8d; font-size: 12px;">
    <em>Este es un respaldo automático de las respuestas enviadas.<br>
    Generado el: ${fecha}</em>
  </div>
</div>
`;

  return { texto, html };
};

router.use(express.json({ limit: '4mb' }));

// En el endpoint POST principal (/) - SOLO FORMATO ESPECÍFICO
router.post("/", async (req, res) => {
  try {
    const { formId, user, responses, formTitle, adjuntos = [], mail: correoRespaldo } = req.body;

    // El usuario que viene del frontend ya debería estar descifrado en su sesión, 
    // pero para la lógica interna usamos sus datos.
    const usuario = user;
    let empresa = user?.empresa;
    const userId = user?.uid;
    const token = user?.token;

    console.log("=== INICIO GUARDAR RESPUESTA ===");

    const tokenValido = await validarToken(req.db, token);
    if (!tokenValido.ok) {
      return res.status(401).json({ error: tokenValido.reason });
    }

    // Descifrar empresa si está cifrada
    let empresaDescifrada = empresa;
    if (empresa && empresa.includes(':')) {
      empresaDescifrada = decrypt(empresa);
      console.log("Empresa descifrada para validación:", empresaDescifrada);
    }

    let form = null;
    if (ObjectId.isValid(formId)) {
      form = await req.db.collection("forms").findOne({ _id: new ObjectId(formId) });
      if (!form) return res.status(404).json({ error: "Formulario no encontrado" });

      // Las empresas en 'form.companies' probablemente están en texto plano o son ObjectIds
      const empresaAutorizada = form.companies?.includes(empresaDescifrada) || 
                                form.companies?.includes("Todas");
      if (!empresaAutorizada) {
        return res.status(403).json({ error: `La empresa ${empresaDescifrada} no está autorizada.` });
      }
    } else {
      console.log(`Ticket creado: ${formId}`);
    }

    const result = await req.db.collection("soporte").insertOne({
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
      const fechaHora = new Date().toLocaleString('es-CL', {
        timeZone: 'America/Santiago',
        dateStyle: 'full',
        timeStyle: 'medium'
      });
      const questions = form?.questions || [];
      const contenido = generarContenidoCorreoRespaldo(
        formTitle,
        usuario,
        fechaHora,
        responses,
        questions
      );

      const mailPayload = {
        accessKey: "wBlL283JH9TqdEJRxon1QOBuI0A6jGVEwpUYchnyMGz", // Reemplaza con tu clave real
        to: correoRespaldo.trim(),
        subject: `Ticket levantado`,
        text: contenido.texto,
        html: contenido.html
      };

      await sendEmail(mailPayload);
    }

    // Descifrar nombre para notificaciones si está cifrado
    let nombreUsuarioDescifrado = usuario;
    if (typeof usuario === 'string' && usuario.includes(':')) {
      nombreUsuarioDescifrado = decrypt(usuario);
    }

    const notifData = {
      titulo: `${nombreUsuarioDescifrado} de la empresa ${empresaDescifrada} ha levantado un ticket de soporte`,
      descripcion: adjuntos.length > 0 ? `Incluye ${adjuntos.length} archivo(s)` : "Revisar en panel.",
      prioridad: 2,
      color: "#bb8900ff",
       icono: "CheckCircle",
      actionUrl: `/Tickets?id=${result.insertedId}`,
    };
    await addNotification(req.db, { filtro: { rol: "Admin" }, ...notifData });

    // Notificación al usuario
    await addNotification(req.db, {
      userId,
      titulo: "Ticket enviado con éxito",
      descripcion: `Se ha recibido correctamente su ticket. Su ID de solicitud es el ${result.insertedId}.`,
      prioridad: 2,
      icono: "CheckCircle",
      color: "#006e13ff",
      actionUrl: `/soporte?id=${result.insertedId}`,
    });

    try {
      await generarAnexoDesdeRespuesta(responses, result.insertedId.toString(), req.db, form?.section || "Soporte General", {
        nombre: usuario,
        empresa: empresa, // Pasar empresa cifrada para que generador.helper la descifre
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
    const respuestaExistente = await req.db.collection("soporte").findOne({
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
    const answers = await req.db.collection("soporte").find().toArray();
    
    // Descifrar datos de usuario en cada respuesta
    const answersDescifrados = answers.map(answer => {
      const answerCopy = { ...answer };
      
      if (answerCopy.user && typeof answerCopy.user === 'object') {
        try {
          // Descifrar campos del usuario si están cifrados
          if (answerCopy.user.nombre && answerCopy.user.nombre.includes(':')) {
            answerCopy.user.nombre = decrypt(answerCopy.user.nombre);
          }
          if (answerCopy.user.apellido && answerCopy.user.apellido.includes(':')) {
            answerCopy.user.apellido = decrypt(answerCopy.user.apellido);
          }
          if (answerCopy.user.mail && answerCopy.user.mail.includes(':')) {
            answerCopy.user.mail = decrypt(answerCopy.user.mail);
          }
          if (answerCopy.user.empresa && answerCopy.user.empresa.includes(':')) {
            answerCopy.user.empresa = decrypt(answerCopy.user.empresa);
          }
          if (answerCopy.user.cargo && answerCopy.user.cargo.includes(':')) {
            answerCopy.user.cargo = decrypt(answerCopy.user.cargo);
          }
        } catch (error) {
          console.error('Error descifrando datos de usuario en respuesta:', error);
        }
      }
      
      return answerCopy;
    });
    
    res.json(answersDescifrados);
  } catch (err) {
    res.status(500).json({ error: "Error al obtener formularios" });
  }
});

router.get("/mail/:mail", async (req, res) => {
  try {
    const cleanMail = req.params.mail.toLowerCase().trim();
    // Usar Blind Index para buscar usuario
    const mailSearchHash = createBlindIndex(cleanMail);
    
    const user = await req.db.collection("usuarios").findOne({ mail_index: mailSearchHash });

    if (!user) return res.status(404).json({ error: "Usuario no encontrado" });

    // Ahora buscamos en respuestas por el UID del usuario
    const answers = await req.db.collection("soporte").find({ "user.uid": user._id.toString() }).toArray();

    if (!answers || answers.length === 0) {
      return res.status(404).json({ error: "No se encontraron formularios" });
    }

    // Descifrar datos de usuario en cada respuesta
    const answersProcessed = answers.map(answer => {
      const answerCopy = { ...answer };
      
      if (answerCopy.user && typeof answerCopy.user === 'object') {
        try {
          // Descifrar campos del usuario si están cifrados
          if (answerCopy.user.nombre && answerCopy.user.nombre.includes(':')) {
            answerCopy.user.nombre = decrypt(answerCopy.user.nombre);
          }
          if (answerCopy.user.apellido && answerCopy.user.apellido.includes(':')) {
            answerCopy.user.apellido = decrypt(answerCopy.user.apellido);
          }
          if (answerCopy.user.mail && answerCopy.user.mail.includes(':')) {
            answerCopy.user.mail = decrypt(answerCopy.user.mail);
          }
          if (answerCopy.user.empresa && answerCopy.user.empresa.includes(':')) {
            answerCopy.user.empresa = decrypt(answerCopy.user.empresa);
          }
          if (answerCopy.user.cargo && answerCopy.user.cargo.includes(':')) {
            answerCopy.user.cargo = decrypt(answerCopy.user.cargo);
          }
        } catch (error) {
          console.error('Error descifrando datos de usuario en respuesta:', error);
        }
      }
      
      return {
        _id: answerCopy._id,
        formId: answerCopy.formId,
        formTitle: answerCopy.formTitle,
        trabajador: answerCopy.responses?.["Nombre del trabajador"] || "No especificado",
        responses: answerCopy.responses,
        user: answerCopy.user,
        status: answerCopy.status,
        createdAt: answerCopy.createdAt,
        approvedAt: answerCopy.approvedAt,
        updatedAt: answerCopy.updatedAt
      };
    });

    res.json(answersProcessed);
  } catch (err) {
    res.status(500).json({ error: "Error al obtener por email" });
  }
});

router.get("/mini", async (req, res) => {
  try {
    const answers = await req.db.collection("soporte")
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
        assignedTo: 1,
        createdAt: 1,
        adjuntosCount: 1
      })
      .toArray();

    // Procesar y descifrar las respuestas
    const answersProcessed = answers.map(answer => {
      // Descifrar campos de usuario
      let nombreDescifrado = answer.user?.nombre || "No especificado";
      let empresaDescifrada = answer.user?.empresa || "No especificado";
      
      try {
        if (nombreDescifrado.includes(':')) {
          nombreDescifrado = decrypt(nombreDescifrado);
        }
        if (empresaDescifrada.includes(':')) {
          empresaDescifrada = decrypt(empresaDescifrada);
        }
      } catch (error) {
        console.error('Error descifrando datos en /mini:', error);
      }

      return {
        _id: answer._id,
        formId: answer.formId,
        formTitle: answer.formTitle,
        trabajador: "No especificado",
        rutTrabajador: "No especificado",
        submittedAt: answer.submittedAt,
        user: {
          nombre: nombreDescifrado,
          empresa: empresaDescifrada,
          uid: answer.user?.uid
        },
        status: answer.status,
        assignedTo: answer.assignedTo,
        responses: answer.responses,
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
    const form = await req.db.collection("soporte")
      .findOne({ _id: new ObjectId(req.params.id) });

    if (!form) return res.status(404).json({ error: "Respuesta no encontrado" });

    // Descifrar datos de usuario si están cifrados
    const formDescifrado = { ...form };
    
    if (formDescifrado.user && typeof formDescifrado.user === 'object') {
      try {
        if (formDescifrado.user.nombre && formDescifrado.user.nombre.includes(':')) {
          formDescifrado.user.nombre = decrypt(formDescifrado.user.nombre);
        }
        if (formDescifrado.user.apellido && formDescifrado.user.apellido.includes(':')) {
          formDescifrado.user.apellido = decrypt(formDescifrado.user.apellido);
        }
        if (formDescifrado.user.mail && formDescifrado.user.mail.includes(':')) {
          formDescifrado.user.mail = decrypt(formDescifrado.user.mail);
        }
        if (formDescifrado.user.empresa && formDescifrado.user.empresa.includes(':')) {
          formDescifrado.user.empresa = decrypt(formDescifrado.user.empresa);
        }
        if (formDescifrado.user.cargo && formDescifrado.user.cargo.includes(':')) {
          formDescifrado.user.cargo = decrypt(formDescifrado.user.cargo);
        }
      } catch (error) {
        console.error('Error descifrando datos de usuario en respuesta individual:', error);
      }
    }

    res.json(formDescifrado);

  } catch (err) {
    res.status(500).json({ error: "Error al obtener Respuesta" });
  }
});

//actualizar respuesta
router.put("/:id", async (req, res) => {
  try {
    const result = await req.db.collection("soporte").findOneAndUpdate(
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

//eliminar respuesta
router.delete("/:id", async (req, res) => {
  try {
    const responseId = req.params.id;

    // Eliminar de todas las colecciones relacionadas
    const [resultRespuestas, resultDocxs, resultAprobados, resultFirmados, resultAdjuntos] = await Promise.all([
      // Eliminar de respuestas
      req.db.collection("soporte").deleteOne({ _id: new ObjectId(responseId) }),

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

// 14. Cambiar estado de respuesta (avanzar o retroceder)
router.put("/:id/status", async (req, res) => {
  try {
    const { id } = req.params;
    const { status, assignedTo } = req.body;

    if (!ObjectId.isValid(id)) {
      return res.status(400).json({ error: "ID de respuesta inválido" });
    }

    if (!status) {
      return res.status(400).json({ error: "Estado requerido" });
    }

    const estadosPermitidos = ['pendiente', 'en_revision', 'finalizado', 'archivado'];
    if (!estadosPermitidos.includes(status)) {
      return res.status(400).json({ error: "Estado no válido" });
    }

    const respuesta = await req.db.collection("soporte").findOne({
      _id: new ObjectId(id)
    });

    if (!respuesta) {
      return res.status(404).json({ error: "Respuesta no encontrada" });
    }

    const updateData = {
      status: status,
      updatedAt: new Date()
    };

    if (status === 'en_revision') {
      updateData.reviewedAt = new Date();
      if (assignedTo) {
        updateData.assignedTo = assignedTo;
        updateData.assignedAt = new Date();
      }
    } else if (status === 'aprobado') {
      updateData.approvedAt = new Date();
    } else if (status === 'firmado') {
      updateData.signedAt = new Date();
    } else if (status === 'finalizado') {
      updateData.finalizedAt = new Date();
    } else if (status === 'archivado') {
      updateData.archivedAt = new Date();
    }

    const updateResult = await req.db.collection("soporte").updateOne(
      { _id: new ObjectId(id) },
      { $set: updateData }
    );

    if (updateResult.matchedCount === 0) {
      return res.status(404).json({ error: "No se pudo actualizar la respuesta" });
    }

    const updatedResponse = await req.db.collection("soporte").findOne({
      _id: new ObjectId(id)
    });

    // Descifrar datos para notificaciones si es necesario
    let formTitleDescifrado = updatedResponse.formTitle;
    try {
      if (formTitleDescifrado && formTitleDescifrado.includes(':')) {
        formTitleDescifrado = decrypt(formTitleDescifrado);
      }
    } catch (error) {
      console.error('Error descifrando formTitle para notificación:', error);
    }

    // Enviar notificación al usuario si aplica
    if (status === 'en_revision') {
      await addNotification(req.db, {
        userId: respuesta?.user?.uid,
        titulo: "Respuestas En Revisión",
        descripcion: `Formulario ${formTitleDescifrado} ha cambiado su estado a En Revisión.`,
        prioridad: 2,
        icono: 'FileText',
        color: '#00c6f8ff',
        actionUrl: `/?id=${id}`,
      });
    }

    // Descifrar datos del usuario antes de enviar respuesta
    const updatedResponseDescifrado = { ...updatedResponse };
    if (updatedResponseDescifrado.user && typeof updatedResponseDescifrado.user === 'object') {
      try {
        if (updatedResponseDescifrado.user.nombre && updatedResponseDescifrado.user.nombre.includes(':')) {
          updatedResponseDescifrado.user.nombre = decrypt(updatedResponseDescifrado.user.nombre);
        }
        if (updatedResponseDescifrado.user.empresa && updatedResponseDescifrado.user.empresa.includes(':')) {
          updatedResponseDescifrado.user.empresa = decrypt(updatedResponseDescifrado.user.empresa);
        }
      } catch (error) {
        console.error('Error descifrando datos de usuario:', error);
      }
    }

    res.json({
      success: true,
      message: `Estado cambiado a '${status}'`,
      updatedRequest: updatedResponseDescifrado
    });

  } catch (err) {
    console.error("Error cambiando estado:", err);
    res.status(500).json({ error: "Error cambiando estado: " + err.message });
  }
});

module.exports = router;