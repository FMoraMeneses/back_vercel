const express = require("express");
const router = express.Router();
const { ObjectId } = require("mongodb");
const { createBlindIndex } = require("../utils/seguridad.helper");

router.use(express.json({ limit: '4mb' }));

// Crear o actualizar un formulario
router.post("/", async (req, res) => {
  try {
    const data = req.body;

    // PROCESAR PREGUNTAS para asegurar configuraciones de archivos
    const processedQuestions = (data.questions || []).map(question => {
      if (question.type === 'file') {
        return {
          ...question,
          multiple: question.multiple || false,
          accept: question.accept || '.pdf,application/pdf',
          maxSize: question.maxSize || '1'
        };
      }
      return question;
    });

    const formData = {
      ...data,
      questions: processedQuestions,
      updatedAt: new Date()
    };

    let result;

    if (!data.id) {
      // INSERT
      result = await req.db.collection("forms").insertOne({
        ...formData,
        createdAt: new Date()
      });

      res.status(201).json({
        _id: result.insertedId,
        ...formData
      });
    } else {
      // UPDATE
      result = await req.db.collection("forms").findOneAndUpdate(
        { _id: new ObjectId(data.id) },
        { $set: formData },
        { returnDocument: "after" }
      );

      if (!result) {
        return res.status(404).json({ error: "Formulario no encontrado" });
      }

      res.status(200).json(result.value || result);
    }

  } catch (err) {
    console.error("Error en POST /forms:", err);
    res.status(500).json({ error: "Error al crear/actualizar formulario: " + err.message });
  }
});

// Listar todos los formularios
router.get("/", async (req, res) => {
  try {
    const forms = await req.db.collection("forms").find().toArray();
    res.json(forms);
  } catch (err) {
    res.status(500).json({ error: "Error al obtener formularios" });
  }
});

// Obtener un formulario por ID (Mongo ObjectId)
router.get("/:id", async (req, res) => {
  try {
    const form = await req.db
      .collection("forms")
      .findOne({ _id: new ObjectId(req.params.id) });

    if (!form) return res.status(404).json({ error: "Formulario no encontrado" });
    res.json(form);
  } catch (err) {
    res.status(500).json({ error: "Error al obtener formulario" });
  }
});

//Filtrado de forms por seccion y empresa en web clientes (ADAPTADO A SEGURIDAD PQC)
router.get("/section/:section/:mail", async (req, res) => {
  try {
    const { section, mail } = req.params;

    // 1. Buscar la empresa asociada al usuario usando BLIND INDEX
    // El mail en la base de datos está cifrado, por lo que buscamos por su hash SHA-256 indexado
    const user = await req.db.collection("usuarios").findOne({ 
      mail_index: createBlindIndex(mail) 
    });

    if (!user || !user.empresa) {
      return res.status(404).json({ error: "Usuario o empresa no encontrados" });
    }

    const empresaUsuario = user.empresa; 

    // 2. Definir la consulta de filtrado
    const query = {
      section: section,
      status: "publicado", 
      $or: [
        { companies: empresaUsuario }, 
        { companies: "Todas" }         
      ],
    };

    // 3. Buscar formularios que cumplan todas las condiciones
    const forms = await req.db
      .collection("forms")
      .find(query)
      .toArray();

    if (!forms || forms.length === 0) { 
      return res.status(404).json({
        error: `No se encontraron formularios para la sección "${section}" y la empresa "${empresaUsuario}"`,
      });
    }

    res.status(200).json(forms);
  } catch (err) {
    console.error("Error al obtener formularios filtrados:", err);
    res.status(500).json({ error: "Error al obtener formularios por sección y empresa" });
  }
});

// Actualizar un formulario
router.put("/:id", async (req, res) => {
  try {
    const data = req.body;

    const processedQuestions = (data.questions || []).map(question => {
      if (question.type === 'file') {
        return {
          ...question,
          multiple: question.multiple || false,
          accept: question.accept || '.pdf,application/pdf',
          maxSize: question.maxSize || '1'
        };
      }
      return question;
    });

    const result = await req.db.collection("forms").findOneAndUpdate(
      { _id: new ObjectId(req.params.id) },
      {
        $set: {
          ...data,
          questions: processedQuestions,
          updatedAt: new Date()
        }
      },
      { returnDocument: "after" }
    );

    if (!result) return res.status(404).json({ error: "Formulario no encontrado" });
    res.json(result.value || result);
  } catch (err) {
    res.status(500).json({ error: "Error al actualizar formulario" });
  }
});

// Publicar un formulario
router.put("/public/:id", async (req, res) => {
  try {
    const result = await req.db.collection("forms").findOneAndUpdate(
      { _id: new ObjectId(req.params.id) },
      {
        $set: {
          status: "publicado",
          updatedAt: new Date()
        }
      },
      { returnDocument: "after" }
    );

    if (!result.value) {
      return res.status(404).json({ error: "Formulario no encontrado" });
    }

    res.status(200).json(result.value);
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: "Error al publicar formulario" });
  }
});

// Eliminar un formulario
router.delete("/:id", async (req, res) => {
  try {
    const result = await req.db
      .collection("forms")
      .deleteOne({ _id: new ObjectId(req.params.id) });

    if (result.deletedCount === 0) {
      return res.status(404).json({ error: "Formulario no encontrado" });
    }

    res.status(200).json({ message: "Formulario eliminado" });
  } catch (err) {
    res.status(500).json({ error: "Error al eliminar formulario" });
  }
});

router.post("/respuestas", async (req, res) => {
  try {
    const result = await req.db.collection("respuestas").insertOne({
      ...req.body,
      createdAt: new Date()
    });

    res.json({ _id: result.insertedId, ...req.body });
  } catch (err) {
    res.status(500).json({ error: "Error al guardar respuesta" });
  }
});

module.exports = router;