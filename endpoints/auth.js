const express = require("express");
const router = express.Router();
const crypto = require("crypto");
const { ObjectId } = require('mongodb');
const multer = require('multer');
const { addNotification } = require("../utils/notificaciones.helper");
const { sendEmail } = require("../utils/mail.helper"); // Importación del helper de correo
const useragent = require('useragent');

const TOKEN_EXPIRATION = 12 * 1000 * 60 * 60;
// Constante para la expiración del código de recuperación (ej: 15 minutos)
const RECOVERY_CODE_EXPIRATION = 15 * 60 * 1000;

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

const generateAndSend2FACode = async (db, user, type) => {
  // 1. Definir expiración y contenido del correo basado en el tipo
  let EXPIRATION_TIME;
  let subject;
  let contextMessage;

  if (type === '2FA_SETUP') {
    EXPIRATION_TIME = 15 * 60 * 1000; // 15 minutos para activación
    subject = 'Código de Activación de 2FA - Acciona';
    contextMessage = 'Hemos recibido una solicitud para **activar** la Autenticación de Dos Factores (2FA).';
  } else if (type === '2FA_LOGIN') {
    EXPIRATION_TIME = 5 * 60 * 1000; // 5 minutos para login (más seguro)
    subject = 'Código de Verificación de Acceso 2FA - Acciona';
    contextMessage = 'Estás intentando **iniciar sesión**. Ingresa el código en el sistema.';
  } else {
    throw new Error("Tipo de código 2FA inválido.");
  }

  const verificationCode = crypto.randomInt(100000, 999999).toString();
  const expiresAt = new Date(Date.now() + EXPIRATION_TIME);
  const userId = user.mail; // **CORRECCIÓN: Usar el _id de MongoDB**

  // 2. Invalidar códigos anteriores del MISMO TIPO
  await db.collection("2fa_codes").updateMany(
    { userId: userId, active: true, type: type }, // Usar el tipo y el ID para la limpieza
    { $set: { active: false, revokedAt: new Date(), reason: "new_code_issued" } }
  );

  // 3. Guardar el nuevo código
  await db.collection("2fa_codes").insertOne({
    userId: userId,
    code: verificationCode,
    type: type, // Usar el tipo dinámico
    createdAt: new Date(),
    expiresAt: expiresAt,
    active: true
  });

  // 4. Enviar el email
  const minutes = EXPIRATION_TIME / 1000 / 60;
  const htmlContent = `
        <p>Hola ${user.nombre},</p>
        <p>${contextMessage}</p>
        <p>Tu código de verificación es:</p>
        <h2 style="color: #f97316; font-size: 24px; text-align: center; border: 1px solid #f97316; padding: 10px; border-radius: 8px;">
            ${verificationCode}
        </h2>
        <p>Este código expira en ${minutes} minutos. Si no solicitaste esta acción, ignora este correo.</p>
        <p>Saludos cordiales,</p>
        <p>El equipo de Acciona</p>
    `;

  await sendEmail({
    to: user.mail,
    subject: subject,
    html: htmlContent
  });
};

router.get("/", async (req, res) => {
  try {
    const usr = await req.db.collection("usuarios").find().toArray();

    if (!usr || usr.length === 0) {
      return res.status(404).json({ error: "Usuarios no encontrados" });
    }

    // Eliminar el campo 'pass' de cada usuario
    const usuariosSinPass = usr.map(usuario => {
      const { pass, ...usuarioSinPass } = usuario;
      return usuarioSinPass;
    });

    res.status(200).json(usuariosSinPass);

  } catch (err) {
    console.error("Error al obtener usuarios:", err);
    res.status(500).json({ error: "Error al obtener usuarios" });
  }
});

router.get("/solicitud", async (req, res) => {
  try {
    const usuarios = await req.db
      .collection("usuarios")
      .find({}, { projection: { nombre: 1, apellido: 1, mail: 1, empresa: 1 } })
      .toArray();

    const usuariosFormateados = usuarios.map(usr => ({
      nombre: usr.nombre,
      apellido: usr.apellido,
      correo: usr.mail,
      empresa: usr.empresa
    }));

    res.json(usuariosFormateados);
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: "Error al obtener usuarios" });
  }
});


router.get("/:mail", async (req, res) => {
  try {
    const usr = await req.db
      .collection("usuarios")
      .findOne({ mail: req.params.mail.toLowerCase().trim() });

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
      .findOne({
        mail: req.params.mail.toLowerCase().trim()
      }, {
        projection: {
          _id: 1,
          nombre: 1,
          mail: 1,
          empresa: 1,
          cargo: 1,
          rol: 1,
          notificaciones: 1
        }
      });

    if (!usr) return res.status(404).json({ error: "Usuario no encontrado" });

    // Asegurar que notificaciones exista como array
    if (!usr.notificaciones) {
      usr.notificaciones = [];
    }

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

    // Validaciones de estado
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

    // Validación de contraseña (asumiendo pass plano)
    if (user.pass !== password)
      return res.status(401).json({ success: false, message: "Credenciales inválidas" });

    // ----------------------------------------------------------------
    // 🔒 LÓGICA 2FA CONDICIONAL
    // ----------------------------------------------------------------

    const is2FAEnabled = user.twoFactorEnabled === true;

    if (is2FAEnabled) {
      // LLAMADA CORREGIDA: Usar '2FA_LOGIN'
      await generateAndSend2FACode(req.db, user, '2FA_LOGIN');

      // Retornamos la bandera `twoFA: true`
      return res.json({
        success: true,
        twoFA: true,
        message: "Se requiere código 2FA. Enviado a tu correo."
      });
    }

    // ----------------------------------------------------------------
    // 🚀 LÓGICA DE TOKEN (Solo si 2FA NO está activa)
    // ----------------------------------------------------------------

    const now = new Date();
    let finalToken = null;
    let expiresAt = null;
    const normalizedEmail = email.toLowerCase().trim();

    // 1. Buscar un token activo para este usuario
    const existingTokenRecord = await req.db.collection("tokens").findOne({
      email: normalizedEmail,
      active: true
    });

    if (existingTokenRecord) {
      const existingExpiresAt = new Date(existingTokenRecord.expiresAt);
      const isExpired = existingExpiresAt < now;

      if (isExpired) {
        await req.db.collection("tokens").updateOne(
          { _id: existingTokenRecord._id },
          { $set: { active: false, revokedAt: now } }
        );
      } else {
        finalToken = existingTokenRecord.token;
        expiresAt = existingExpiresAt;
      }
    }

    // 2. Si no hay un token válido, generar uno nuevo
    if (!finalToken) {
      finalToken = crypto.randomBytes(32).toString("hex");
      expiresAt = new Date(Date.now() + TOKEN_EXPIRATION);

      await req.db.collection("tokens").insertOne({
        token: finalToken,
        email: normalizedEmail,
        rol: user.rol,
        createdAt: now,
        expiresAt,
        active: true
      });
    }

    // 3. Registrar Ingreso
    const ipAddress = req.ip || req.connection.remoteAddress;
    const userAgentString = req.headers['user-agent'] || 'Desconocido';
    const agent = useragent.parse(userAgentString);
    const usr = { name: user.nombre, email: normalizedEmail, cargo: user.rol };

    await req.db.collection("ingresos").insertOne({
      usr,
      ipAddress,
      os: agent.os.toString(),
      browser: agent.toAgent(),
      now: now,
    });

    // 4. Retornar el token
    return res.json({ success: true, token: finalToken, usr });
  } catch (err) {
    console.error("Error en login:", err);
    return res.status(500).json({ error: "Error interno en login" });
  }
});


router.post("/verify-login-2fa", async (req, res) => {
  const { email, verificationCode } = req.body;

  if (!email || !verificationCode || verificationCode.length !== 6) {
    return res.status(400).json({ success: false, message: "Datos incompletos o código inválido." });
  }

  const now = new Date();
  const normalizedEmail = email.toLowerCase().trim();

  try {
    const user = await req.db.collection("usuarios").findOne({ mail: normalizedEmail });
    if (!user) return res.status(401).json({ success: false, message: "Usuario no encontrado." });

    const userId = user._id.toString();

    // 1. Buscar el código activo y no expirado para LOGIN
    const codeRecord = await req.db.collection("2fa_codes").findOne({
      userId: normalizedEmail,
      code: verificationCode,
      type: '2FA_LOGIN',
      active: true,
      expiresAt: { $gt: now }
    });

    if (!codeRecord) {
      return res.status(401).json({ success: false, message: "Código 2FA incorrecto o expirado." });
    }

    // 2. Marcar el código como usado/inactivo
    await req.db.collection("2fa_codes").updateOne(
      { _id: codeRecord._id },
      { $set: { active: false, usedAt: now } }
    );

    // 3. Generar o Reutilizar Token (Misma lógica que en /login)
    let finalToken = null;
    let expiresAt = null;

    const existingTokenRecord = await req.db.collection("tokens").findOne({
      email: normalizedEmail,
      active: true
    });

    // Lógica de reutilización/generación de token...
    if (existingTokenRecord && new Date(existingTokenRecord.expiresAt) > now) {
      finalToken = existingTokenRecord.token;
    } else {
      finalToken = crypto.randomBytes(32).toString("hex");
      expiresAt = new Date(Date.now() + TOKEN_EXPIRATION);
      await req.db.collection("tokens").insertOne({
        token: finalToken,
        email: normalizedEmail,
        rol: user.rol,
        createdAt: now,
        expiresAt,
        active: true
      });
    }

    // 4. Registrar Ingreso
    const ipAddress = req.ip || req.connection.remoteAddress;
    const userAgentString = req.headers['user-agent'] || 'Desconocido';
    const agent = useragent.parse(userAgentString);
    const usr = { name: user.nombre, email: normalizedEmail, cargo: user.rol };

    await req.db.collection("ingresos").insertOne({
      usr,
      ipAddress,
      os: agent.os.toString(),
      browser: agent.toAgent(),
      now: now,
    });

    // 5. Retornar el token y datos del usuario (ACCESO CONCEDIDO)
    return res.json({ success: true, token: finalToken, usr });

  } catch (err) {
    console.error("Error en verify-login-2fa:", err);
    return res.status(500).json({ success: false, message: "Error interno en la verificación 2FA." });
  }
});


// =================================================================
// 🔑 ENDPOINT 1: SOLICITAR RECUPERACIÓN (PASO 1)
// =================================================================
router.post("/recuperacion", async (req, res) => {
  const { email } = req.body;

  if (!email) {
    return res.status(400).json({ message: "El correo electrónico es obligatorio." });
  }

  try {
    const user = await req.db.collection("usuarios").findOne({
      mail: email.toLowerCase().trim()
      // No validamos estado "activo" aquí para dar feedback si el email existe
    });

    // 1. Simular éxito si el usuario no existe para prevenir enumeración,
    // pero para debug y flujo explícito, retornamos 404/401 si no está activo.
    if (!user || user.estado === "inactivo") {
      return res.status(404).json({ message: "Usuario no encontrado o no activo." });
    }

    // 2. Generar código de 6 dígitos numéricos
    // Aseguramos que tenga 6 dígitos, rellenando con ceros si es necesario, aunque
    // crypto.randomInt(100000, 999999) ya garantiza 6 dígitos.
    const verificationCode = crypto.randomInt(100000, 999999).toString();
    const expiresAt = new Date(Date.now() + RECOVERY_CODE_EXPIRATION);

    // 3. Invalidar códigos anteriores para este usuario/email (Limpieza)
    await req.db.collection("recovery_codes").updateMany(
      { email: email.toLowerCase().trim(), active: true },
      { $set: { active: false, revokedAt: new Date(), reason: "new_code_issued" } }
    );

    // 4. Guardar el nuevo código en la colección temporal
    await req.db.collection("recovery_codes").insertOne({
      email: email.toLowerCase().trim(),
      code: verificationCode,
      userId: user._id.toString(), // Guardamos el ID por conveniencia
      createdAt: new Date(),
      expiresAt: expiresAt,
      active: true
    });

    // 5. Enviar el email
    const htmlContent = `
            <p>Hola ${user.nombre},</p>
            <p>Hemos recibido una solicitud para restablecer la contraseña de tu cuenta Acciona.</p>
            <p>Tu código de verificación es:</p>
            <h2 style="color: #f97316; font-size: 24px; text-align: center; border: 1px solid #f97316; padding: 10px; border-radius: 8px;">
                ${verificationCode}
            </h2>
            <p>Este código expira en 15 minutos. Si no solicitaste este cambio, ignora este correo.</p>
            <p>Saludos cordiales,</p>
            <p>El equipo de Acciona</p>
        `;

    await sendEmail({
      to: email,
      subject: 'Código de Recuperación de Contraseña - Acciona',
      html: htmlContent
    });

    // 6. Respuesta al cliente (status 200 para pasar al paso 2)
    res.status(200).json({ success: true, message: "Código de recuperación enviado." });

  } catch (err) {
    console.error("Error en /recuperacion:", err);
    // Error genérico si el envío falla o hay un error de DB
    res.status(500).json({ message: "Error interno al procesar la solicitud." });
  }
});

// =================================================================
// 🔑 ENDPOINT 2: VERIFICAR CÓDIGO Y BORRAR PASS (PASO 2)
// =================================================================
router.post("/borrarpass", async (req, res) => {
  const { email, code } = req.body;
  const now = new Date();

  if (!email || !code) {
    return res.status(400).json({ message: "Correo y código de verificación son obligatorios." });
  }

  try {
    // 1. Buscar código activo, sin expirar y que coincida con email/código
    const recoveryRecord = await req.db.collection("recovery_codes").findOne({
      email: email.toLowerCase().trim(),
      code: code,
      active: true
    });

    if (!recoveryRecord) {
      return res.status(401).json({ message: "Código inválido o ya utilizado." });
    }

    // 2. Verificar expiración
    if (recoveryRecord.expiresAt < now) {
      // Marcar como inactivo si expiró
      await req.db.collection("recovery_codes").updateOne(
        { _id: recoveryRecord._id },
        { $set: { active: false, revokedAt: now, reason: "expired" } }
      );
      return res.status(401).json({ message: "Código expirado. Solicita uno nuevo." });
    }

    // 3. Marcar el código como inactivo (consumido)
    await req.db.collection("recovery_codes").updateOne(
      { _id: recoveryRecord._id },
      { $set: { active: false, revokedAt: now, reason: "consumed" } }
    );

    // 4. Obtener el ID del usuario
    // Podemos usar el userId que guardamos en el recoveryRecord
    const userId = recoveryRecord.userId;

    if (!userId) {
      return res.status(404).json({ message: "Error interno: ID de usuario no encontrado." });
    }

    // Opcional: Borrar el campo pass temporalmente para forzar el cambio, o simplemente redirigir
    // Dado que el flujo es redirigir a `/set-password?userId=<uid>`, no borraremos la pass aquí.

    // 5. Retornar el UID del usuario (como string)
    return res.json({ success: true, uid: userId });

  } catch (err) {
    console.error("Error en /borrarpass:", err);
    res.status(500).json({ message: "Error interno al verificar el código." });
  }
});


router.post("/send-2fa-code", async (req, res) => {
  // Asumimos que el token JWT ya autenticó y el ID de usuario está disponible en req.user._id
  // Si usas tokens, el ID es la forma más segura de obtener el email
  const token = req.headers.authorization?.split(" ")[1];
  if (!token) {
    return res.status(401).json({ message: "No autorizado. Token requerido." });
  }

  // Nota: Deberías decodificar el token para obtener el userId.
  // Usaremos un placeholder simplificado (obtener email de sesión/storage) como en tu React:
  const userEmail = req.body.email || 'EMAIL_DEL_TOKEN'; // Obtener email real del token decodificado

  // --- LÓGICA DE VERIFICACIÓN DEL USUARIO Y ENVÍO DE CÓDIGO ---

  try {
    // En un entorno real, decodificas el token para obtener el ID del usuario:
    // const decoded = jwt.verify(token, process.env.JWT_SECRET); 
    // const user = await req.db.collection("usuarios").findOne({ _id: new ObjectId(decoded.id) });

    // Usamos el email por simplicidad del ejemplo:
    const user = await req.db.collection("usuarios").findOne({
      mail: userEmail.toLowerCase().trim()
    });

    if (!user) {
      // No revelamos si el email existe o no por seguridad, pero para este flujo
      // asumimos que el usuario está logeado y debe existir.
      return res.status(404).json({ message: "Usuario no encontrado." });
    }

    await generateAndSend2FACode(req.db, user, '2FA_SETUP');

    // 5. Respuesta al cliente
    res.status(200).json({ success: true, message: "Código de activación 2FA enviado a tu correo." });

  } catch (err) {
    console.error("Error en /send-2fa-code:", err);
    res.status(500).json({ success: false, message: "Error interno al procesar la solicitud." });
  }
});

router.post("/verify-2fa-activation", async (req, res) => {
  const { verificationCode } = req.body;
  const token = req.headers.authorization?.split(" ")[1];

  // Asumimos que obtienes el ID del usuario del token
  const userId = req.body.userId || 'ID_DEL_TOKEN'; // Obtener ID real del token decodificado

  if (!verificationCode || verificationCode.length !== 6 || !userId) {
    return res.status(400).json({ success: false, message: "Datos incompletos o código inválido." });
  }

  try {
    // 1. Buscar el código activo y no expirado
    const codeRecord = await req.db.collection("2fa_codes").findOne({
      userId: userId, // Usamos el ID de usuario autenticado
      code: verificationCode,
      type: '2FA_SETUP',
      active: true,
      expiresAt: { $gt: new Date() } // Debe ser mayor a la fecha/hora actual
    });

    if (!codeRecord) {
      return res.status(400).json({ success: false, message: "Código incorrecto o expirado." });
    }

    // 2. Marcar el código como usado/inactivo
    await req.db.collection("2fa_codes").updateOne(
      { _id: codeRecord._id },
      { $set: { active: false, usedAt: new Date() } }
    );

    // 3. ACTUALIZAR EL ESTADO 2FA DEL USUARIO
    await req.db.collection("usuarios").updateOne(
      { mail: userId },
      { $set: { twoFactorEnabled: true } } // ¡Importante!
    );

    // 4. Respuesta exitosa
    res.status(200).json({ success: true, message: "Autenticación de Dos Factores activada exitosamente." });

  } catch (err) {
    console.error("Error en /verify-2fa-activation:", err);
    res.status(500).json({ success: false, message: "Error interno en la verificación." });
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
      // Permitimos que este endpoint sea usado para setear contraseña en un flujo de recuperación
      // Si el usuario ya está activo, asumimos que este endpoint es para setear una nueva contraseña.
      // Se podría añadir lógica para diferenciar si viene de recuperación (borrarpass) o de activación inicial (register).

      // Si el flujo es solo para activación inicial, descomentar la línea de abajo y comentar la de arriba
      // return res.status(400).json({
      //   error: "La contraseña ya fue establecida. Si necesitas cambiarla, usa /change-password."
      // });
    }

    const result = await req.db.collection("usuarios").updateOne(
      {
        _id: new ObjectId(userId),
        // Si quieres que el set-password funcione para recuperación de un usuario ACTIVO
        // debes quitar la condición 'estado: "pendiente"'.
        // Lo dejaré sin la condición para que funcione como "reset" en la recuperación.
      },
      {
        $set: {
          pass: password,
          estado: "activo", // Aseguramos que el estado pase a activo (si estaba en pendiente)
          updatedAt: new Date().toISOString()
        }
      }
    );

    if (result.matchedCount === 0) {
      return res.status(400).json({
        error: "No se pudo actualizar la contraseña. El usuario no fue encontrado o el ID es incorrecto."
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