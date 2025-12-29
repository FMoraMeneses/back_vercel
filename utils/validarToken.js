const { createBlindIndex, decrypt } = require("./seguridad.helper");

export async function validarToken(db, token) {
  // 1. Buscar el token (el campo 'token' no está cifrado)
  const tokenData = await db.collection("tokens").findOne({
    "token": token
  });

  if (!tokenData) {
    return { ok: false, reason: "No existe" };
  }

  // 2. Verificar que esté activo (campo 'active' está cifrado)
  let activeDescifrado = false;
  try {
    if (tokenData.active && tokenData.active.includes(':')) {
      // El campo está cifrado
      const activeStr = decrypt(tokenData.active);
      activeDescifrado = activeStr === "true";
    } else {
      // Si no está cifrado (durante transición o error)
      activeDescifrado = tokenData.active === true;
    }
  } catch (error) {
    console.error('Error descifrando campo active:', error);
    return { ok: false, reason: "Error de cifrado en active" };
  }

  if (!activeDescifrado) {
    return { ok: false, reason: "Token inactivo o revocado" };
  }

  const ahora = new Date();
  const expiracion = new Date(tokenData.expiresAt || tokenData.expiration);

  // 3. Verificar expiración
  if (ahora > expiracion) {
    // Si está expirado, lo desactivamos (revocamos) en la base de datos
    // Actualizar campo 'active' cifrado
    try {
      await db.collection("tokens").updateOne(
        { _id: tokenData._id },
        { 
          $set: { 
            active: encrypt("false"), // Cifrar como string
            revokedAt: ahora 
          }
        }
      );
    } catch (error) {
      console.error('Error al desactivar token expirado:', error);
    }
    return { ok: false, reason: "Expirado y revocado" };
  }

  // 4. Verificación de token antiguo (manteniendo lógica comentada)
  /*
  const creacion = new Date(tokenData.createdAt);
  const mismoDia =
    creacion.getFullYear() === ahora.getFullYear() &&
    creacion.getMonth() === ahora.getMonth() &&
    creacion.getDate() === ahora.getDate();

  if (!mismoDia) {
    // Desactivamos si es "Antiguo" según esta lógica
    try {
      await db.collection("tokens").updateOne(
        { _id: tokenData._id },
        { 
          $set: { 
            active: encrypt("false"), // Cifrar como string
            revokedAt: ahora 
          }
        }
      );
    } catch (error) {
      console.error('Error al desactivar token antiguo:', error);
    }
    return { ok: false, reason: "Antiguo y revocado" };
  }
  */

  // 5. Si el token existe, está activo y no ha expirado, es válido.
  // Opcional: devolver datos descifrados adicionales si se necesitan
  let emailDescifrado = null;
  let rolDescifrado = null;
  
  try {
    if (tokenData.email && tokenData.email.includes(':')) {
      emailDescifrado = decrypt(tokenData.email);
    } else {
      emailDescifrado = tokenData.email; // Por si no está cifrado
    }
    
    if (tokenData.rol && tokenData.rol.includes(':')) {
      rolDescifrado = decrypt(tokenData.rol);
    } else {
      rolDescifrado = tokenData.rol; // Por si no está cifrado
    }
  } catch (error) {
    console.error('Error descifrando datos del token:', error);
    // Continuamos aunque haya error de descifrado, el token sigue siendo válido
  }

  return { 
    ok: true,
    data: {
      _id: tokenData._id,
      email: emailDescifrado,
      rol: rolDescifrado,
      createdAt: tokenData.createdAt,
      expiresAt: tokenData.expiresAt
    }
  };
}