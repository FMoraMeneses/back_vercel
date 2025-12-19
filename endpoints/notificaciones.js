// routes/notificaciones.js - VERSIÓN ACTUALIZADA CON BLIND INDEXES
const express = require("express");
const router = express.Router();
const { ObjectId } = require("mongodb");
const { addNotification } = require("../utils/notificaciones.helper");
const { createBlindIndex } = require("../utils/seguridad.helper");

// Crear una notificación (para 1 usuario o grupo)
router.post("/", async (req, res) => {
  try {
    const data = req.body;
    const { filtro, formTitle, prioridad, color, icono, actionUrl } = data;

    if (!formTitle) {
      return res.status(400).json({ error: "Faltan campos requeridos: formTitle" });
    }

    const { notificacion, modifiedCount } = await addNotification(req.db, {
      userId,
      filtro,
      formTitle: `Se ha añadido notificacion manual.`,
      descripcion: `Se a usado postman para añadir nuevas notificaciones desde fuera`,
      prioridad,
      color,
      icono,
      actionUrl,
    });

    if (modifiedCount === 0) {
      return res.status(404).json({ error: "No se encontraron usuarios para la notificación" });
    }

    res.status(201).json({
      message: "Notificación creada exitosamente",
      notificacion,
      usuarios_afectados: modifiedCount,
    });
  } catch (err) {
    console.error("Error al crear notificación:", err);
    res.status(500).json({ error: "Error al crear notificación", detalles: err.message });
  }
});

// Listar notificaciones de un usuario
router.get("/:nombre", async (req, res) => {
  try {
    const emailBlindIndex = createBlindIndex(req.params.nombre);

    const usuario = await req.db
      .collection("usuarios")
      .findOne({ emailBlindIndex: emailBlindIndex }, {
        projection: {
          notificaciones: 1,
          mail: 1
        }
      });

    if (!usuario) return res.status(404).json({ error: "Usuario no encontrado" });

    res.json(usuario.notificaciones || []);
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: "Error al obtener notificaciones" });
  }
});

// Marcar una notificación como leída
router.put("/:userId/:notiId/leido", async (req, res) => {
  try {
    const emailBlindIndex = createBlindIndex(req.params.userId);

    const result = await req.db.collection("usuarios").findOneAndUpdate(
      {
        emailBlindIndex: emailBlindIndex,
        "notificaciones.id": req.params.notiId
      },
      { $set: { "notificaciones.$.leido": true } },
      { returnDocument: "after" }
    );

    if (!result.value)
      return res.status(404).json({ error: "Usuario o notificación no encontrada" });

    res.json({
      message: "Notificación marcada como leída",
      usuario: result.value
    });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: "Error al marcar notificación como leída" });
  }
});

// Eliminar una notificación
router.delete("/:mail/:notiId", async (req, res) => {
  try {
    const emailBlindIndex = createBlindIndex(req.params.mail);

    const result = await req.db.collection("usuarios").findOneAndUpdate(
      { emailBlindIndex: emailBlindIndex },
      { $pull: { notificaciones: { id: req.params.notiId } } },
      { returnDocument: "after" }
    );

    if (!result)
      return res.status(404).json({
        error: "Usuario o notificación no encontrada",
        result: result
      });

    res.json({
      message: "Notificación eliminada",
      usuario: result.value
    });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: "Error al eliminar notificación" });
  }
});

// Eliminar todas las notificaciones de un usuario
router.delete("/:mail", async (req, res) => {
  try {
    const emailBlindIndex = createBlindIndex(req.params.mail);

    const result = await req.db.collection("usuarios").findOneAndUpdate(
      { emailBlindIndex: emailBlindIndex },
      { $set: { notificaciones: [] } },
      { returnDocument: "after" }
    );

    if (!result.value) {
      return res.status(404).json({ error: "Usuario no encontrado" });
    }

    res.json({
      message: "Todas las notificaciones fueron eliminadas correctamente.",
      usuario: result.value
    });
  } catch (err) {
    console.error("Error al eliminar todas las notificaciones:", err);
    res.status(500).json({ error: "Error al eliminar notificaciones" });
  }
});

// Marcar todas las notificaciones como leídas
router.put("/:mail/leido-todas", async (req, res) => {
  try {
    const { mail } = req.params;
    const emailBlindIndex = createBlindIndex(mail);

    const result = await req.db.collection("usuarios").updateOne(
      { emailBlindIndex: emailBlindIndex },
      { $set: { "notificaciones.$[].leido": true } }
    );

    if (result.matchedCount === 0) {
      return res.status(404).json({ error: "Usuario no encontrado" });
    }

    res.json({
      message: "Todas las notificaciones fueron marcadas como leídas",
      modifiedCount: result.modifiedCount,
    });
  } catch (err) {
    console.error("Error al marcar todas como leídas:", err);
    res.status(500).json({ error: "Error al marcar todas las notificaciones como leídas" });
  }
});

// Obtener contador de notificaciones no leídas
router.get("/:mail/unread-count", async (req, res) => {
  try {
    const { mail } = req.params;
    console.log("🔍 Buscando notificaciones no leídas para email:", mail);

    const emailBlindIndex = createBlindIndex(mail);
    console.log("🔑 Blind index generado:", emailBlindIndex);

    const usuario = await req.db
      .collection("usuarios")
      .findOne({
        emailBlindIndex: emailBlindIndex
      }, {
        projection: {
          notificaciones: 1,
          mail: 1,
          nombre: 1,
          apellido: 1
        }
      });

    console.log("📊 Usuario encontrado:", usuario ? "SÍ" : "NO");

    if (!usuario) {
      // DEBUG: Ver qué usuarios existen
      const todosUsuarios = await req.db.collection("usuarios")
        .find({}, { projection: { emailBlindIndex: 1, mail: 1, nombre: 1 } })
        .limit(5)
        .toArray();

      console.log("📋 Primeros 5 usuarios en BD:", todosUsuarios.map(u => ({
        emailBlindIndex: u.emailBlindIndex,
        mail: u.mail,
        nombre: u.nombre
      })));

      return res.status(404).json({
        error: "Usuario no encontrado",
        emailBuscado: mail,
        blindIndexBuscado: emailBlindIndex
      });
    }

    const unreadCount = (usuario.notificaciones || []).filter(
      (n) => n.leido === false
    ).length;

    console.log("✅ Notificaciones no leídas:", unreadCount);

    res.json({
      unreadCount,
      totalNotificaciones: usuario.notificaciones ? usuario.notificaciones.length : 0
    });
  } catch (err) {
    console.error("❌ Error al obtener contador de no leídas:", err);
    res.status(500).json({
      error: "Error al obtener contador de notificaciones no leídas",
      detalles: err.message,
    });
  }
});

module.exports = router;