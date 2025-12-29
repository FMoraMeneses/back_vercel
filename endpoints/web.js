const express = require("express");
const router = express.Router();
const { validarToken } = require('../utils/validarToken');
const { createBlindIndex, verifyPassword, decrypt } = require("../utils/seguridad.helper");

router.post("/filter", async (req, res) => {
  try {
    const { mail, token } = req.body;

    if (!mail || !token) {
      return res.status(400).json({ error: "Faltan parámetros de autenticación (mail y token)." });
    }

    // =========================================================
    // --- PASO 1: Validar el Token ---
    // =========================================================
    const tokenResult = await validarToken(req.db, token);

    if (!tokenResult.ok) {
      console.warn(`Intento de acceso fallido. Razón: ${tokenResult.reason}`);
      return res.status(401).json({ error: `Acceso denegado: ${tokenResult.reason}.` });
    }

    // Obtener email del token descifrado
    const tokenEmail = tokenResult.data.email;
    
    // =========================================================
    // --- PASO 2: Verificar que el mail del cuerpo coincida con el del token ---
    // =========================================================
    let cleanMail;
    
    // Determinar si el mail del request está cifrado
    if (mail && mail.includes(':')) {
      // El mail está cifrado, descifrarlo
      cleanMail = decrypt(mail).toLowerCase().trim();
    } else {
      // El mail ya está en texto plano
      cleanMail = mail.toLowerCase().trim();
    }

    // Comparar el mail descifrado con el email del token
    if (cleanMail !== tokenEmail) {
      console.warn(`Intento de acceso con token no correspondiente. Token email: ${tokenEmail}, Request email: ${cleanMail}`);
      return res.status(401).json({ error: "El token no corresponde al usuario especificado." });
    }

    // =========================================================
    // --- PASO 3: Obtener el Rol del Usuario (Uso de Blind Index) ---
    // =========================================================
    // Generamos el hash para buscar en la base de datos cifrada
    const mailSearchHash = createBlindIndex(cleanMail);

    const user = await req.db.collection('usuarios').findOne({
      mail_index: mailSearchHash
    });

    if (!user) {
      return res.status(401).json({ error: "Acceso denegado. Usuario no existe." });
    }

    // Descifrar el cargo/rol del usuario si es necesario
    let userRole;
    if (user.cargo && user.cargo.includes(':')) {
      // El cargo está cifrado
      userRole = decrypt(user.cargo);
    } else {
      // El cargo ya está en texto plano
      userRole = user.cargo;
    }

    if (!userRole) {
      return res.status(403).json({ error: "Cargo no definido para el usuario." });
    }

    // =========================================================
    // --- PASO 4: Filtrar las Secciones del Menú ---
    // =========================================================
    const allowedRoles = [userRole, 'Todas'];

    const menuItems = await req.db.collection('sidebar').find({
      cargo: { $in: allowedRoles }
    }).toArray();

    res.json(menuItems);

  } catch (err) {
    console.error("Error en el endpoint de filtro de menú:", err);
    res.status(500).json({ error: "Error interno del servidor." });
  }
});

module.exports = router;