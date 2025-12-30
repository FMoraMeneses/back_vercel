const crypto = require("crypto");
const argon2 = require("argon2");

// En producción, usa process.env.MASTER_KEY (debe ser de 32 bytes / 64 caracteres hex)
const MASTER_KEY = Buffer.from(process.env.MASTER_KEY || "0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef", 'hex');
const ALGORITHM = 'aes-256-gcm';

/**
 * Crea un hash determinístico para buscar datos cifrados (como el mail) 
 * sin revelar el contenido original.
 */
const createBlindIndex = (text) => {
    if (!text) return null;
    return crypto.createHash('sha256').update(text.toLowerCase().trim()).digest('hex');
};

/**
 * Cifra texto usando AES-256-GCM.
 * Retorna formato iv:authTag:encryptedText
 */
const encrypt = (text) => {
    if (!text) return null;
    const iv = crypto.randomBytes(12);
    const cipher = crypto.createCipheriv(ALGORITHM, MASTER_KEY, iv);
    let encrypted = cipher.update(text, 'utf8', 'hex');
    encrypted += cipher.final('hex');
    const authTag = cipher.getAuthTag().toString('hex');
    return `${iv.toString('hex')}:${authTag}:${encrypted}`;
};

/**
 * Descifra strings en formato iv:authTag:encryptedText
 */
const decrypt = (encryptedData) => {
    if (!encryptedData) return encryptedData;

    try {
        const parts = encryptedData.split(':');

        if (parts.length !== 3) {
            console.error(`❌ Dato no cifrado encontrado: ${encryptedData.substring(0, 30)}...`);
            return "[Dato no cifrado]";
        }

        const [ivHex, authTagHex, encryptedText] = parts;
        const isValidHex = (str) => /^[0-9a-fA-F]+$/.test(str);

        if (!isValidHex(ivHex) || !isValidHex(authTagHex) || !isValidHex(encryptedText)) {
            console.error(`❌ Formato hexadecimal inválido: ${encryptedData.substring(0, 30)}...`);
            return encryptedData;
        }

        if (ivHex.length !== 24 || authTagHex.length !== 32) {
            console.error(`❌ Longitudes inválidas: iv=${ivHex.length}, auth=${authTagHex.length}`);
            return encryptedData;
        }

        const decipher = crypto.createDecipheriv(ALGORITHM, MASTER_KEY, Buffer.from(ivHex, 'hex'));
        decipher.setAuthTag(Buffer.from(authTagHex, 'hex'));
        let decrypted = decipher.update(encryptedText, 'hex', 'utf8');
        decrypted += decipher.final('utf8');

        return decrypted;

    } catch (err) {

        console.error(`🔥 ERROR CRÍTICO DE DESCIFRADO:`);
        console.error(`   Dato: ${encryptedData.substring(0, 50)}...`);
        console.error(`   Error: ${err.message}`);

        const buscarHoraEnHex = (hexStr) => {

            try {
                const ascii = Buffer.from(hexStr, 'hex').toString('ascii');
                const match = ascii.match(/(\d{1,2}:\d{2})/);
                if (match) return match[1];
            } catch (e) { }
            return null;
        };

        const parts = encryptedData.split(':');
        if (parts.length >= 3) {
            const encryptedText = parts[2];
            const horaRecuperada = buscarHoraEnHex(encryptedText);
            if (horaRecuperada) {
                console.log(`⚠️  Hora recuperada de hex: ${horaRecuperada}`);
                return horaRecuperada;
            }
        }

        if (/^\d{1,2}:\d{2}$/.test(encryptedData)) {
            console.error(`⚠️  Hora aparentemente no cifrada: ${encryptedData}`);
            return encryptedData;
        }

        return "[Error de descifrado]";
    }
};

/**
 * Hashea contraseñas con Argon2id (Post-Quantum Resistant)
 */
const hashPassword = async (password) => {
    return await argon2.hash(password, {
        type: argon2.argon2id,
        memoryCost: 2 ** 16, // 64MB
        timeCost: 3,
        parallelism: 1
    });
};

/**
 * Verifica contraseñas contra un hash Argon2id
 */
const verifyPassword = async (hash, password) => {
    try {
        return await argon2.verify(hash, password);
    } catch (err) {
        return false;
    }
};

module.exports = {
    encrypt,
    decrypt,
    createBlindIndex,
    hashPassword,
    verifyPassword
};