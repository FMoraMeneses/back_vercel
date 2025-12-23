const express = require("express");
const cors = require("cors");
const { MongoClient } = require("mongodb");

// Importar rutas
const authRoutes = require("./endpoints/auth");
const formRoutes = require("./endpoints/forms");
const answersRoutes = require("./endpoints/answers");
const mailRoutes = require("./endpoints/mail");
const gen = require("./endpoints/Generador");
const noti = require("./endpoints/notificaciones");
const menu = require("./endpoints/web");
const plantillas = require("./endpoints/plantillas");
const anunciosRouter = require("./endpoints/anuncios");
const soporteRoutes = require("./endpoints/soporte");
const app = express();

app.use(express.json({ limit: '4mb' }));
app.use(express.urlencoded({ limit: '4mb', extended: true }));

// Configuración CORS
app.use(cors());

// CONFIGURACIÓN ACTUALIZADA PARA PLAN GRATUITO DE VERCEL
// Límites reducidos para evitar PayloadTooLargeError
app.use(express.json({ limit: '4mb' })); // 4MB máximo (por debajo del límite de 4.5MB de Vercel)
app.use(express.urlencoded({ limit: '4mb', extended: true }));

app.set('trust proxy', true);

// Configurar conexión a MongoDB (desde variable de entorno)
const client = new MongoClient(process.env.MONGO_URI);
let db;

async function connectDB() {
  if (!db) {
    await client.connect();
    db = client.db("formsdb");
    console.log("Conectado a MongoDB");
  }
  return db;
}

// 
app.use(async (req, res, next) => {
  try {
    req.db = await connectDB();
    next();
  } catch (err) {
    console.error("Error al conectar con MongoDB:", err);
    res.status(500).json({ error: "Error con base de datos" });
  }
});

// Rutas
app.use("/api/auth", authRoutes);
app.use("/api/forms", formRoutes);
app.use("/api/respuestas", answersRoutes);
app.use("/api/mail", mailRoutes);
app.use("/api/generador", gen);
app.use("/api/noti", noti);
app.use("/api/menu", menu);
app.use("/api/plantillas", plantillas);
app.use("/api/anuncios", anunciosRouter);
app.use("/api/soporte", soporteRoutes);

// Ruta base
app.get("/", (req, res) => {
  res.json({ message: "API funcionando" });
});

// Exportar la app para que Vercel la maneje como serverless function
module.exports = app;