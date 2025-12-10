const express = require('express');
const router = express.Router();
const { ObjectId } = require('mongodb');
const { addNotification } = require("../utils/notificaciones.helper");

module.exports = (db) => {
  
  // Obtener chat completo (admin)
  router.get("/:formId/chat/admin", async (req, res) => {
    try {
      const { formId } = req.params;

      let query;
      if (ObjectId.isValid(formId)) {
        query = { $or: [{ _id: new ObjectId(formId) }, { formId }] };
      } else {
        query = { formId };
      }

      const respuesta = await db.collection("respuestas")
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

  // Obtener chat completo (cliente)
  router.get("/:formId/chat/", async (req, res) => {
    try {
      const { formId } = req.params;

      let query;
      if (ObjectId.isValid(formId)) {
        query = { $or: [{ _id: new ObjectId(formId) }, { formId }] };
      } else {
        query = { formId };
      }

      const respuesta = await db.collection("respuestas")
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

  // Enviar mensaje al chat
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

      const respuesta = await db.collection("respuestas").findOne(query);
      if (!respuesta) {
        return res.status(404).json({ error: "No se encontró la respuesta para agregar el mensaje" });
      }

      await db.collection("respuestas").updateOne(
        { _id: respuesta._id },
        { $push: { mensajes: nuevoMensaje } }
      );

      // Enviar notificaciones según quién envía el mensaje
      if (respuesta?.user?.nombre === autor) {
        // Mensaje enviado por el cliente → notificar a RRHH y admin
        await addNotification(db, {
          filtro: { cargo: "RRHH" },
          titulo: "Nuevo mensaje en tu formulario",
          descripcion: `${autor} le ha enviado un mensaje respecto a un formulario.`,
          icono: "Edit",
          color: "#45577eff",
          actionUrl: `/RespuestasForms?id=${respuesta._id}`,
        });

        await addNotification(db, {
          filtro: { cargo: "admin" },
          titulo: "Nuevo mensaje en tu formulario",
          descripcion: `${autor} le ha enviado un mensaje respecto a un formulario.`,
          icono: "Edit",
          color: "#45577eff",
          actionUrl: `/RespuestasForms?id=${respuesta._id}`,
        });
      } else {
        // Mensaje enviado por admin/RRHH → notificar al cliente
        await addNotification(db, {
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

  // Marcar todos los mensajes como leídos
  router.put("/chat/marcar-leidos", async (req, res) => {
    try {
      const result = await db.collection("respuestas").updateMany(
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

  return router;
};