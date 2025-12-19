// routes/notificaciones.helper.js
const { ObjectId } = require("mongodb");
const { createBlindIndex } = require("./seguridad.helper");

/**
 * Añade una notificación a uno o varios usuarios
 * @param {Db} db - Conexión activa a MongoDB
 * @param {Object} options - Configuración de la notificación
 * @param {string} [options.userId] - ID del usuario destino
 * @param {Object} [options.filtro] - Filtro para múltiples usuarios
 * @param {string} options.titulo - Título de la notificación
 * @param {string} options.descripcion - Descripción de la notificación
 * @param {number} [options.prioridad=1] - Nivel de prioridad
 * @param {string} [options.color="#f5872dff"] - Color de acento
 * @param {string} [options.icono="paper"] - Icono de referencia
 * @param {string|null} [options.actionUrl=null] - URL o ruta asociada
 */
async function addNotification(
  db,
  {
    userId,
    filtro,
    titulo,
    descripcion,
    prioridad = 1,
    color = "#f5872dff",
    icono = "paper",
    actionUrl = null,
  }
) {
  if (!userId && !filtro) {
    throw new Error("Debe proporcionar un userId o un filtro de usuarios (rol/cargo).");
  }

  const notificacion = {
    id: new ObjectId().toString(),
    titulo,
    descripcion,
    prioridad,
    color,
    icono,
    actionUrl,
    leido: false,
    fecha_creacion: new Date(),
  };

  let query;
  
  // Si es usuario específico
  if (userId) {
    try {
      // Intentar como ObjectId primero
      query = { _id: new ObjectId(userId) };
    } catch (error) {
      // Si no es ObjectId válido, asumir que es email y usar blind index
      const emailBlindIndex = createBlindIndex(userId);
      query = { emailBlindIndex: emailBlindIndex };
    }
  } 
  // Si es por filtro
  else if (filtro) {
    query = { estado: 'activo' };
    const andConditions = [];
    
    // CASO 1: Filtro con estructura compleja (desde anuncios.js)
    if (filtro.$and && Array.isArray(filtro.$and)) {
      filtro.$and.forEach(condition => {
        Object.keys(condition).forEach(key => {
          const value = condition[key];
          
          // Si es búsqueda por $in (ej: empresas: ["Empresa A", "Empresa B"])
          if (value.$in && Array.isArray(value.$in)) {
            const fieldName = key;
            const fieldValues = value.$in;
            
            const blindIndexField = getBlindIndexFieldName(fieldName);
            const blindIndexes = fieldValues.map(val => createBlindIndex(val));
            andConditions.push({ [blindIndexField]: { $in: blindIndexes } });
          }
          // Si es búsqueda por igualdad simple
          else if (typeof value === 'string') {
            const blindIndexField = getBlindIndexFieldName(key);
            const blindIndexValue = createBlindIndex(value);
            andConditions.push({ [blindIndexField]: blindIndexValue });
          }
        });
      });
    }
    // CASO 2: Filtro simple (desde otros endpoints) - Ej: { cargo: "RRHH" }, { rol: "admin" }
    else {
      Object.keys(filtro).forEach(key => {
        const value = filtro[key];
        
        // Manejar diferentes tipos de valores
        if (Array.isArray(value)) {
          // Si es array, usar $in
          const blindIndexField = getBlindIndexFieldName(key);
          const blindIndexes = value.map(val => createBlindIndex(val));
          andConditions.push({ [blindIndexField]: { $in: blindIndexes } });
        } else if (typeof value === 'string') {
          // Si es string simple, usar igualdad
          const blindIndexField = getBlindIndexFieldName(key);
          const blindIndexValue = createBlindIndex(value);
          andConditions.push({ [blindIndexField]: blindIndexValue });
        } else if (value && typeof value === 'object') {
          // Si ya es un operador MongoDB (como $in, $eq, etc.)
          const blindIndexField = getBlindIndexFieldName(key);
          
          // Convertir valores dentro del operador a blind indexes si es necesario
          if (value.$in && Array.isArray(value.$in)) {
            const blindIndexes = value.$in.map(val => createBlindIndex(val));
            andConditions.push({ [blindIndexField]: { $in: blindIndexes } });
          } else {
            // Para otros operadores, pasar tal cual (asumiendo que ya son blind indexes)
            andConditions.push({ [blindIndexField]: value });
          }
        }
      });
    }
    
    // Si hay condiciones AND, agregarlas al query
    if (andConditions.length > 0) {
      query.$and = andConditions;
    }
  }

  console.log("Query para buscar usuarios:", JSON.stringify(query, null, 2));
  
  const result = await db.collection("usuarios").updateMany(query, {
    $push: { notificaciones: notificacion },
  });
  
  console.log("Resultado de updateMany:", {
    matchedCount: result.matchedCount,
    modifiedCount: result.modifiedCount,
    acknowledged: result.acknowledged
  });

  return { notificacion, modifiedCount: result.modifiedCount };
}

/**
 * Función helper para obtener el nombre del campo blind index
 */
function getBlindIndexFieldName(fieldName) {
  switch(fieldName.toLowerCase()) {
    case 'empresa':
      return 'empresaBlindIndex';
    case 'cargo':
      return 'cargoBlindIndex';
    case 'rol':
      return 'rolBlindIndex';
    case 'mail':
    case 'email':
      return 'emailBlindIndex';
    default:
      return `${fieldName}BlindIndex`;
  }
}

module.exports = { addNotification };