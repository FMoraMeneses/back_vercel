// back_vercel2/endpoints/anuncios.js
const express = require('express');
const router = express.Router();
const { ObjectId } = require('mongodb');
const { addNotification } = require('../utils/notificaciones.helper');

// GET /api/anuncios - Listar anuncios
router.get('/', async (req, res) => {
  try {
    const db = req.db;
    const anuncios = await db.collection('anuncios').find().toArray();
    res.json(anuncios);
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// POST /api/anuncios - Crear anuncio
router.post('/', async (req, res) => {
  try {
    const db = req.db;
    const {
      titulo,
      descripcion,
      prioridad = 1,
      color = '#f5872dff',
      icono = 'paper',
      actionUrl = null,
      destinatarios,
      programacion,
      estado = 'borrador'
    } = req.body;

    const nuevoAnuncio = {
      titulo,
      descripcion,
      prioridad,
      color,
      icono,
      actionUrl,
      destinatarios,
      programacion,
      estado,
      creadoPor: req.userEmail, // Asumiendo que tienes middleware de autenticación
      fechaCreacion: new Date(),
      fechaActualizacion: new Date()
    };

    const result = await db.collection('anuncios').insertOne(nuevoAnuncio);
    
    res.json({
      success: true,
      id: result.insertedId,
      anuncio: nuevoAnuncio
    });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// PUT /api/anuncios/:id - Actualizar anuncio
router.put('/:id', async (req, res) => {
  try {
    const db = req.db;
    const { id } = req.params;
    
    const updateData = {
      ...req.body,
      fechaActualizacion: new Date()
    };

    const result = await db.collection('anuncios').updateOne(
      { _id: new ObjectId(id) },
      { $set: updateData }
    );

    res.json({
      success: true,
      modifiedCount: result.modifiedCount
    });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// POST /api/anuncios/:id/enviar - Enviar anuncio
router.post('/:id/enviar', async (req, res) => {
  try {
    const db = req.db;
    const { id } = req.params;
    
    // 1. Obtener el anuncio
    const anuncio = await db.collection('anuncios').findOne({ 
      _id: new ObjectId(id) 
    });

    if (!anuncio) {
      return res.status(404).json({ error: 'Anuncio no encontrado' });
    }

    // 2. Determinar destinatarios según el tipo
    let query = {};
    
    if (anuncio.destinatarios.tipo === 'filtro') {
      const filtro = anuncio.destinatarios.filtro;
      query = {
        $or: [
          filtro.empresas?.length > 0 ? { empresa: { $in: filtro.empresas } } : {},
          filtro.cargos?.length > 0 ? { cargo: { $in: filtro.cargos } } : {},
          filtro.roles?.length > 0 ? { rol: { $in: filtro.roles } } : {}
        ].filter(cond => Object.keys(cond).length > 0)
      };
    } else if (anuncio.destinatarios.tipo === 'manual') {
      query = {
        _id: { $in: anuncio.destinatarios.usuariosManuales.map(id => new ObjectId(id)) }
      };
    }
    // Si es 'todos', query queda vacío para todos los usuarios

    // 3. Enviar notificaciones usando tu helper existente
    const usuarios = await db.collection('usuarios').find(query).toArray();
    
    for (const usuario of usuarios) {
      await addNotification(db, {
        userId: usuario._id.toString(),
        titulo: anuncio.titulo,
        descripcion: anuncio.descripcion,
        prioridad: anuncio.prioridad,
        color: anuncio.color,
        icono: anuncio.icono,
        actionUrl: anuncio.actionUrl
      });
    }

    // 4. Actualizar estado del anuncio
    await db.collection('anuncios').updateOne(
      { _id: new ObjectId(id) },
      { 
        $set: { 
          estado: 'enviado',
          fechaEnvio: new Date(),
          destinatariosCount: usuarios.length
        }
      }
    );

    res.json({
      success: true,
      message: `Anuncio enviado a ${usuarios.length} usuarios`,
      count: usuarios.length
    });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// DELETE /api/anuncios/:id - Eliminar anuncio
router.delete('/:id', async (req, res) => {
  try {
    const db = req.db;
    const { id } = req.params;

    const result = await db.collection('anuncios').deleteOne({
      _id: new ObjectId(id)
    });

    res.json({
      success: true,
      deletedCount: result.deletedCount
    });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

module.exports = router;