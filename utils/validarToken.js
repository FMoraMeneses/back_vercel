export async function validarToken(db, token) {
  // 1. Buscar el token y verificar que esté activo
  const tokenData = await db.collection("tokens").findOne({
    "token": token,
    "active": true // Solo consideramos tokens activos
  });

  if (!tokenData) {
    // Si no se encuentra (no existe o ya está inactivo/revocado)
    return { ok: false, reason: "No existe o ha sido revocado" };
  }

  const ahora = new Date();
  // Asume que la fecha de expiración está en 'expiresAt' o 'expiration'
  const expiracion = new Date(tokenData.expiresAt || tokenData.expiration);

  // 2. Verificar expiración
  if (ahora > expiracion) {
    // Si está expirado, lo desactivamos (revocamos) en la base de datos
    await db.collection("tokens").updateOne(
      { _id: tokenData._id },
      { $set: { active: false, revokedAt: ahora } }
    );
    // Retornamos el estado de no válido
    return { ok: false, reason: "Expirado y revocado" };
  }

  // 3. Verificación de token antiguo (lógica comentada en el original)
  // Si deseas mantener la verificación de 'mismoDia' (que no es estándar para JWTs),
  // puedes descomentar la sección y aplicar la misma lógica de desactivación:
  /*
  const creacion = new Date(tokenData.createdAt);
  const mismoDia =
    creacion.getFullYear() === ahora.getFullYear() &&
    creacion.getMonth() === ahora.getMonth() &&
    creacion.getDate() === ahora.getDate();

  if (!mismoDia) {
    // Desactivamos si es "Antiguo" según esta lógica
    await db.collection("tokens").updateOne(
      { _id: tokenData._id },
      { $set: { active: false, revokedAt: ahora } }
    );
    return { ok: false, reason: "Antiguo y revocado" };
  }
  */

  // 4. Si el token existe, está activo y no ha expirado, es válido.
  return { ok: true };
}