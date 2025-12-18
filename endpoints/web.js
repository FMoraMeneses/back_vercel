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

    const cleanMail = decrypt(mail).toLowerCase().trim();

    // =========================================================
    // --- PASO 1: Validar el Token ---
    // =========================================================
    // Nota: Asegúrate de que tu función validarToken use el mail limpio para comparar
    const tokenResult = await validarToken(req.db, token);

    if (!tokenResult.ok) {
      console.warn(`Intento de acceso fallido para ${cleanMail}. Razón: ${tokenResult.reason}`);
      return res.status(401).json({ error: `Acceso denegado: ${tokenResult.reason}.` });
    }


    // =========================================================
    // --- PASO 2: Obtener el Rol del Usuario (Uso de Blind Index) ---
    // =========================================================

    // Generamos el hash para buscar en la base de datos cifrada
    const mailSearchHash = createBlindIndex(cleanMail);

    const user = await req.db.collection('usuarios').findOne({
      mail_index: mailSearchHash
    });

    if (!user) {
      return res.status(401).json({ error: "Acceso denegado. Usuario no existe." });
    }

    // Usamos 'rol' o 'cargo' según tu estructura (en tu ejemplo anterior usaste user.rol)
    const userRole = user.cargo;

    if (!userRole) {
      return res.status(403).json({ error: "Cargo no definido para el usuario." });
    }

    // =========================================================
    // --- PASO 3: Filtrar las Secciones del Menú ---
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