const express = require("express");
const router = express.Router();
const crypto = require("crypto");
const { ObjectId } = require('mongodb');
const multer = require('multer');
const { addNotification } = require("../utils/notificaciones.helper");
const useragent = require('useragent');

const TOKEN_EXPIRATION = 12 * 1000 * 60 * 60;

// Configurar Multer para almacenar logos en memoria
const upload = multer({
  storage: multer.memoryStorage(),
  fileFilter: function (req, file, cb) {
    if (file.mimetype.startsWith('image/')) {
      cb(null, true);
    } else {
      cb(new Error('Solo se permiten archivos de imagen'), false);
    }
  },
  limits: {
    fileSize: 2 * 1024 * 1024
  }
});

router.get("/", async (req, res) => {
  try {
    const usr = await req.db.collection("usuarios").find().toArray();
    res.json(usr);
  } catch (err) {
    res.status(500).json({ error: "Error al obtener usuarios" });
  }
});


router.get("/:mail", async (req, res) => {
  try {
    const usr = await req.db
      .collection("usuarios")
      .findOne({ mail: req.params.mail.toLowerCase().trim()});

    if (!usr) return res.status(404).json({ error: "Usuario no encontrado" });

    res.json({ id: usr._id, empresa: usr.empresa, cargo: usr.cargo });
  } catch (err) {
    res.status(500).json({ error: "Error al obtener Usuario" });
  }
});

router.get("/full/:mail", async (req, res) => {
  try {
    const usr = await req.db
      .collection("usuarios")
      .findOne({ mail: req.params.mail.toLowerCase().trim()});

    if (!usr) return res.status(404).json({ error: "Usuario no encontrado" });

    // IMPORTANTE: Devolver el objeto completo para llenar el perfil
    res.json(usr);
  } catch (err) {
    res.status(500).json({ error: "Error al obtener Usuario completo" });
  }
});


router.post("/login", async (req, res) => {
  const { email, password } = req.body;

  try {
    const user = await req.db.collection("usuarios").findOne({ mail: email.toLowerCase().trim() });
    if (!user) return res.status(401).json({ success: false, message: "Credenciales inválidas" });

    if (user.estado === "pendiente")
      return res.status(401).json({
        success: false,
        message: "Usuario pendiente de activación. Revisa tu correo para establecer tu contraseña."
      });

    if (user.estado === "inactivo")
      return res.status(401).json({
        success: false,
        message: "Usuario inactivo. Contacta al administrador."
      });

    if (user.pass !== password)
      return res.status(401).json({ success: false, message: "Credenciales inválidas" });

    // ----------------------------------------------------------------
    // 🔍 LÓGICA DE BÚSQUEDA Y VALIDACIÓN DE TOKEN EXISTENTE
    // ----------------------------------------------------------------

    const now = new Date();
    let finalToken = null;
    let expiresAt = null;

    // 1. Buscar un token activo para este usuario
    const existingTokenRecord = await req.db.collection("tokens").findOne({
      email: email.toLowerCase().trim(),
      active: true
    });

    if (existingTokenRecord) {
      const existingExpiresAt = new Date(existingTokenRecord.expiresAt);
      const isExpired = existingExpiresAt < now;

      if (isExpired) {
        // 2a. Si existe y está expirado, lo revocamos
        await req.db.collection("tokens").updateOne(
          { _id: existingTokenRecord._id },
          { $set: { active: false, revokedAt: now } }
        );
        // El token final se generará en el paso 3
      } else {
        // 2b. Si existe y es válido, lo reutilizamos
        finalToken = existingTokenRecord.token;
        expiresAt = existingExpiresAt;
      }
    }

    // 3. Si no hay un token válido (ya sea porque no existía o fue revocado)
    if (!finalToken) {
      // Generar un token nuevo
      finalToken = crypto.randomBytes(32).toString("hex");
      expiresAt = new Date(Date.now() + TOKEN_EXPIRATION);

      // Insertar el nuevo token
      await req.db.collection("tokens").insertOne({
        token: finalToken,
        email: email.toLowerCase().trim(),
        rol: user.rol,
        createdAt: now,
        expiresAt,
        active: true
      });
    }

    // ----------------------------------------------------------------
    // 🚀 RESPUESTA FINAL
    // ----------------------------------------------------------------

    // Recopilar datos para notificación
    const ipAddress = req.ip || req.connection.remoteAddress;
    const userAgentString = req.headers['user-agent'] || 'Desconocido';
    const agent = useragent.parse(userAgentString);
    const os = agent.os.toString();
    const browser = agent.toAgent()

    const usr = { name: user.nombre, email: email.toLowerCase().trim(), cargo: user.rol };

    const newLogin = {
      usr, 
      ipAddress, 
      os, 
      browser, 
      now,
    }

    const result = await req.db.collection("ingresos").insertOne(newLogin);

    // Envío de Notificación
    await addNotification(req.db, {
      userId: user._id.toString(),
      titulo: `Nuevo inicio de sesión detectado`,
      descripcion: `Se realizó un inicio de sesión a las ${now.toLocaleString()}. 
        IP: **${ipAddress}**.
        OS: **${os}**.
        Navegador: **${browser}**.`,
      prioridad: 2,
      color: "#d42a00ff",
      icono: "User",
    });

    // Retornar el token reutilizado o el recién generado
    return res.json({ success: true, token: finalToken, usr });
  } catch (err) {
    console.error("Error en login:", err);
    return res.status(500).json({ error: "Error interno en login" });
  }
});

router.get("/logins/todos", async (req, res) => {
  try {
    const tkn = await req.db.collection("ingresos").find().toArray();
    res.json(tkn);
  } catch (err) {
    res.status(500).json({ error: "Error al obtener ingresos" });
  }
});

// VALIDATE - Consulta token desde DB
router.post("/validate", async (req, res) => {
  const { token, email, cargo } = req.body;

  if (!token || !email || !cargo)
    return res.status(401).json({ valid: false, message: "Acceso inválido" });

  try {
    const tokenRecord = await req.db.collection("tokens").findOne({ token, active: true });
    if (!tokenRecord)
      return res.status(401).json({ valid: false, message: "Token inválido o inexistente" });

    const now = new Date();
    const expiresAt = new Date(tokenRecord.expiresAt);
    const createdAt = new Date(tokenRecord.createdAt);

    // 1. Verificar si expiró
    const expired = expiresAt < now;

    // 2. Verificar si es del mismo día calendario
    const isSameDay =
      createdAt.getFullYear() === now.getFullYear() &&
      createdAt.getMonth() === now.getMonth() &&
      createdAt.getDate() === now.getDate();

    if (expired) {
      // 🔹 Eliminar token viejo o expirado para no acumular
      await req.db.collection("tokens").updateOne(
        { token },
        { $set: { active: false, revokedAt: new Date() } }
      );
      return res.status(401).json({
        valid: false,
        message: expired
          && "Token expirado. Inicia sesión nuevamente."
      });
    }

    if (tokenRecord.email !== email.toLowerCase().trim())
      return res.status(401).json({ valid: false, message: "Token no corresponde al usuario" });

    if (tokenRecord.rol !== cargo)
      return res.status(401).json({ valid: false, message: "Cargo no corresponde al usuario" });

    return res.json({ valid: true, user: { email: email.toLowerCase().trim(), cargo } });
  } catch (err) {
    console.error("Error validando token:", err);
    res.status(500).json({ valid: false, message: "Error interno al validar token" });
  }
});


// LOGOUT - Elimina o desactiva token en DB
router.post("/logout", async (req, res) => {
  const { token } = req.body;
  if (!token) return res.status(400).json({ success: false, message: "Token requerido" });

  try {
    await req.db.collection("tokens").updateOne(
      { token },
      { $set: { active: false, revokedAt: new Date() } }
    );
    res.json({ success: true, message: "Sesión cerrada" });
  } catch (err) {
    console.error("Error cerrando sesión:", err);
    res.status(500).json({ success: false, message: "Error interno al cerrar sesión" });
  }
});


router.post("/register", async (req, res) => {
  try {
    const { nombre, apellido, mail, empresa, cargo, rol, estado } = req.body;
    if (!nombre || !apellido || !mail || !empresa || !cargo || !rol) {
      return res.status(400).json({ error: "Todos los campos son obligatorios" });
    }
    const existingUser = await req.db.collection("usuarios").findOne({ mail });
    if (existingUser) {
      return res.status(400).json({ error: "El usuario ya existe" });
    }
    const newUser = {
      nombre,
      apellido,
      mail: mail.toLowerCase().trim(),
      empresa,
      cargo,
      rol,
      pass: "",
      estado: estado,
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString()
    };
    const result = await req.db.collection("usuarios").insertOne(newUser);
    const createdUser = await req.db.collection("usuarios").findOne({
      _id: result.insertedId
    });

    await addNotification(req.db, {
      userId: result.insertedId.toString(),
      titulo: `Registro Exitoso!`,
      descripcion: `Bienvenid@ a nuestra plataforma Virtual Acciona!`, // Agregamos la info aquí
      prioridad: 2,
      color: "#7afb24ff",
      icono: "User",
    });

    res.status(201).json({
      success: true,
      message: "Usuario registrado exitosamente",
      user: createdUser
    });
  } catch (err) {
    console.error("Error al registrar usuario:", err);
    res.status(500).json({ error: "Error interno del servidor" });
  }
});

// POST - Cambiar contraseña (Requiere validación de contraseña anterior)
router.post("/change-password", async (req, res) => {
  const { email, currentPassword, newPassword } = req.body;

  if (!email || !currentPassword || !newPassword) {
    return res.status(400).json({ success: false, message: "Faltan datos requeridos" });
  }

  try {
    // 1. Buscar usuario por email
    const user = await req.db.collection("usuarios").findOne({ mail: email });

    if (!user) {
      return res.status(404).json({ success: false, message: "Usuario no encontrado" });
    }

    // 2. Verificar contraseña actual (Pseudo-login)
    if (user.pass !== currentPassword) {
      return res.status(401).json({ success: false, message: "La contraseña actual es incorrecta" });
    }

    // 3. Validaciones de seguridad de la nueva contraseña
    if (newPassword.length < 8) {
      return res.status(400).json({ success: false, message: "La nueva contraseña debe tener al menos 8 caracteres" });
    }
    
    // Evitar que la nueva sea igual a la anterior
    if (user.pass === newPassword) {
      return res.status(400).json({ success: false, message: "La nueva contraseña no puede ser igual a la actual" });
    }

    // 4. Actualizar contraseña
    const result = await req.db.collection("usuarios").updateOne(
      { _id: user._id },
      { 
        $set: { 
          pass: newPassword, 
          updatedAt: new Date().toISOString() 
        } 
      }
    );

    if (result.modifiedCount === 0) {
      return res.status(500).json({ success: false, message: "No se pudo actualizar la contraseña" });
    }

    // 5. Registrar Notificación de seguridad
    const ipAddress = req.ip || req.connection.remoteAddress;
    await addNotification(req.db, {
      userId: user._id.toString(),
      titulo: `Cambio de Contraseña`,
      descripcion: `La contraseña fue actualizada exitosamente el ${new Date().toLocaleString()}. IP: ${ipAddress}`,
      prioridad: 2,
      color: "#ffae00", // Color de advertencia/seguridad
      icono: "Shield",
    });

    // Opcional: Revocar otros tokens si se desea forzar logout en otros dispositivos
    // await req.db.collection("tokens").updateMany({ email: email }, { $set: { active: false } });

    res.json({ success: true, message: "Contraseña actualizada exitosamente" });

  } catch (err) {
    console.error("Error cambiando contraseña:", err);
    res.status(500).json({ success: false, message: "Error interno del servidor" });
  }
});

// PUT - Actualizar usuario por ID
router.put("/users/:id", async (req, res) => {
  try {
    const { nombre, apellido, mail, empresa, cargo, rol, estado } = req.body;
    const userId = req.params.id;

    if (!nombre || !apellido || !mail || !empresa || !cargo || !rol) {
      return res.status(400).json({ error: "Todos los campos son obligatorios" });
    }

    // El email solo puede ser cambiado si no existe en otro usuario (excluyendo el actual)
    const existingUser = await req.db.collection("usuarios").findOne({
      mail: mail.toLowerCase().trim(),
      _id: { $ne: new ObjectId(userId) }
    });
    if (existingUser) {
      return res.status(400).json({ error: "El email ya está en uso por otro usuario" });
    }

    const updateData = {
      nombre,
      apellido,
      mail: mail.toLowerCase().trim(),
      empresa,
      cargo,
      rol,
      estado,
      updatedAt: new Date().toISOString()
    };

    const result = await req.db.collection("usuarios").updateOne(
      { _id: new ObjectId(userId) },
      { $set: updateData }
    );

    if (result.matchedCount === 0) {
      return res.status(404).json({ error: "Usuario no encontrado" });
    }

    res.json({
      success: true,
      message: "Usuario actualizado exitosamente",
      updatedFields: updateData
    });

  } catch (err) {
    console.error("Error actualizando usuario:", err);
    if (err.message.includes("ObjectId")) {
      return res.status(400).json({ error: "ID de usuario inválido" });
    }
    res.status(500).json({ error: "Error interno al actualizar usuario" });
  }
});


router.delete("/users/:id", async (req, res) => {
  try {
    const result = await req.db.collection("usuarios").deleteOne({
      _id: new ObjectId(req.params.id)
    });

    if (result.deletedCount === 0) {
      return res.status(404).json({ error: "Usuario no encontrado" });
    }

    res.json({ message: "Usuario eliminado exitosamente" });

  } catch (err) {
    console.error("Error eliminando usuario:", err);
    res.status(500).json({ error: "Error al eliminar usuario" });
  }
});

router.post("/set-password", async (req, res) => {
  try {
    const { userId, password } = req.body;
    if (!userId || !password) {
      return res.status(400).json({ error: "UserId y contraseña son requeridos" });
    }

    // ✅ NUEVA VALIDACIÓN DE CONTRASEÑA EN BACKEND
    if (password.length < 8) {
      return res.status(400).json({
        error: "La contraseña debe tener al menos 8 caracteres"
      });
    }

    // Validar que tenga letras y números
    const hasLetter = /[a-zA-Z]/.test(password);
    const hasNumber = /[0-9]/.test(password);

    if (!hasLetter || !hasNumber) {
      return res.status(400).json({
        error: "La contraseña debe incluir letras y números"
      });
    }

    // Validación adicional de seguridad (opcional pero recomendado)
    if (password.length > 128) {
      return res.status(400).json({
        error: "La contraseña es demasiado larga"
      });
    }

    // Evitar contraseñas comunes (lista básica)
    const commonPasswords = ['12345678', 'password', 'contraseña', 'admin123', 'qwerty123'];
    if (commonPasswords.includes(password.toLowerCase())) {
      return res.status(400).json({
        error: "La contraseña es demasiado común. Elige una más segura"
      });
    }

    const existingUser = await req.db.collection("usuarios").findOne({
      _id: new ObjectId(userId)
    });

    if (!existingUser) {
      return res.status(404).json({ error: "Usuario no encontrado" });
    }

    if (existingUser.estado !== "pendiente") {
      return res.status(400).json({
        error: "La contraseña ya fue establecida anteriormente. Si necesitas cambiarla, contacta al administrador."
      });
    }

    const result = await req.db.collection("usuarios").updateOne(
      {
        _id: new ObjectId(userId),
        estado: "pendiente"
      },
      {
        $set: {
          pass: password,
          estado: "activo",
          updatedAt: new Date().toISOString()
        }
      }
    );

    if (result.matchedCount === 0) {
      return res.status(400).json({
        error: "No se puede establecer la contraseña. Ya fue configurada anteriormente o el enlace expiró."
      });
    }

    res.json({
      success: true,
      message: "Contraseña establecida exitosamente"
    });

  } catch (error) {
    console.error("Error al establecer contraseña:", error);
    if (error.message.includes("ObjectId")) {
      return res.status(400).json({ error: "ID de usuario inválido" });
    }
    res.status(500).json({ error: "Error interno del servidor" });
  }
});

// EMPRESAS ENDPOINTS

// GET - Obtener todas las empresas
router.get("/empresas/todas", async (req, res) => {
  try {
    const empresas = await req.db.collection("empresas").find().toArray();
    res.json(empresas);
  } catch (err) {
    console.error("Error obteniendo empresas:", err);
    res.status(500).json({ error: "Error al obtener empresas" });
  }
});

// GET - Obtener empresa por ID
router.get("/empresas/:id", async (req, res) => {
  try {
    const empresa = await req.db.collection("empresas").findOne({
      _id: new ObjectId(req.params.id)
    });

    if (!empresa) {
      return res.status(404).json({ error: "Empresa no encontrada" });
    }

    res.json(empresa);
  } catch (err) {
    console.error("Error obteniendo empresa:", err);
    res.status(500).json({ error: "Error al obtener empresa" });
  }
});

// POST - Registrar nueva empresa
router.post("/empresas/register", upload.single('logo'), async (req, res) => {
  try {
    console.log("Debug: Iniciando registro de empresa");
    console.log("Debug: Datos recibidos:", req.body);

    const { nombre, rut, direccion, encargado, rut_encargado } = req.body;

    if (!nombre || !rut) {
      return res.status(400).json({ error: "Nombre y RUT son obligatorios" });
    }

    const empresaExistente = await req.db.collection("empresas").findOne({
      $or: [
        { nombre: nombre.trim() },
        { rut: rut.trim() }
      ]
    });

    if (empresaExistente) {
      const campoDuplicado = empresaExistente.nombre === nombre.trim() ? 'nombre' : 'RUT';
      return res.status(400).json({
        error: `Ya existe una empresa con el mismo ${campoDuplicado}`
      });
    }

    const empresaData = {
      nombre: nombre.trim(),
      rut: rut.trim(),
      direccion: direccion ? direccion.trim() : '',
      encargado: encargado ? encargado.trim() : '',
      rut_encargado: rut_encargado ? rut_encargado.trim() : '',
      createdAt: new Date(),
      updatedAt: new Date()
    };

    if (req.file) {
      empresaData.logo = {
        fileName: req.file.originalname,
        fileData: req.file.buffer,
        fileSize: req.file.size,
        mimeType: req.file.mimetype,
        uploadedAt: new Date()
      };
    }

    const result = await req.db.collection("empresas").insertOne(empresaData);

    console.log("Debug: Empresa registrada exitosamente, ID:", result.insertedId);

    const nuevaEmpresa = await req.db.collection("empresas").findOne({
      _id: result.insertedId
    });

    res.status(201).json({
      message: "Empresa registrada exitosamente",
      empresa: nuevaEmpresa
    });

  } catch (err) {
    console.error("Error registrando empresa:", err);

    if (err.code === 11000) {
      return res.status(400).json({ error: "Empresa duplicada" });
    }

    res.status(500).json({ error: "Error al registrar empresa: " + err.message });
  }
});

// PUT - Actualizar empresa
router.put("/empresas/:id", upload.single('logo'), async (req, res) => {
  try {
    const { nombre, rut, direccion, encargado, rut_encargado } = req.body;

    const updateData = {
      nombre: nombre.trim(),
      rut: rut.trim(),
      direccion: direccion ? direccion.trim() : '',
      encargado: encargado ? encargado.trim() : '',
      rut_encargado: rut_encargado ? rut_encargado.trim() : '',
      updatedAt: new Date()
    };

    if (req.file) {
      updateData.logo = {
        fileName: req.file.originalname,
        fileData: req.file.buffer,
        fileSize: req.file.size,
        mimeType: req.file.mimetype,
        uploadedAt: new Date()
      };
    } else if (req.body.logo === 'DELETE_LOGO') {
      updateData.logo = null;
    }

    const result = await req.db.collection("empresas").updateOne(
      { _id: new ObjectId(req.params.id) },
      { $set: updateData }
    );

    if (result.matchedCount === 0) {
      return res.status(404).json({ error: "Empresa no encontrada" });
    }

    const empresaActualizada = await req.db.collection("empresas").findOne({
      _id: new ObjectId(req.params.id)
    });

    res.json({
      message: "Empresa actualizada exitosamente",
      empresa: empresaActualizada
    });

  } catch (err) {
    console.error("Error actualizando empresa:", err);
    res.status(500).json({ error: "Error al actualizar empresa" });
  }
});

// DELETE - Eliminar empresa
router.delete("/empresas/:id", async (req, res) => {
  try {
    const result = await req.db.collection("empresas").deleteOne({
      _id: new ObjectId(req.params.id)
    });

    if (result.deletedCount === 0) {
      return res.status(404).json({ error: "Empresa no encontrada" });
    }

    res.json({ message: "Empresa eliminada exitosamente" });

  } catch (err) {
    console.error("Error eliminando empresa:", err);
    res.status(500).json({ error: "Error al eliminar empresa" });
  }
});

module.exports = router;