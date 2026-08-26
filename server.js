require("dotenv").config();

const express = require("express");
const axios = require("axios");
const { Pool } = require("pg");

const app = express();
app.use(express.json());

const PORT = process.env.PORT || 3000;

const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: {
    rejectUnauthorized: false,
  },
});

const VERIFY_TOKEN = process.env.VERIFY_TOKEN;
const WHATSAPP_TOKEN = process.env.WHATSAPP_TOKEN;
const PHONE_NUMBER_ID = process.env.PHONE_NUMBER_ID;

async function initDatabase() {
  try {
    await pool.query(`
      CREATE TABLE IF NOT EXISTS usuarios (
        id SERIAL PRIMARY KEY,
        telefono VARCHAR(30) UNIQUE NOT NULL,
        nombre VARCHAR(150),
        ciudad VARCHAR(100),
        estado_registro VARCHAR(50) DEFAULT 'completo',
        created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
      );
    `);

    await pool.query(`
      CREATE TABLE IF NOT EXISTS solicitudes (
        id SERIAL PRIMARY KEY,
        usuario_id INTEGER REFERENCES usuarios(id),
        origen TEXT,
        destino TEXT,
        estado VARCHAR(50) DEFAULT 'pendiente',
        created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
      );
    `);

    console.log("✅ Tablas verificadas");
  } catch (error) {
    console.error("Error creando tablas:", error);
  }
}

async function sendText(to, text) {
  try {
    await axios.post(
      `https://graph.facebook.com/v23.0/${PHONE_NUMBER_ID}/messages`,
      {
        messaging_product: "whatsapp",
        to,
        text: {
          body: text,
        },
      },
      {
        headers: {
          Authorization: `Bearer ${WHATSAPP_TOKEN}`,
          "Content-Type": "application/json",
        },
      }
    );
  } catch (error) {
    console.error(
      "Error enviando mensaje:",
      error.response?.data || error.message
    );
  }
}

async function sendMenu(to, nombre) {
  try {
    await axios.post(
      `https://graph.facebook.com/v23.0/${PHONE_NUMBER_ID}/messages`,
      {
        messaging_product: "whatsapp",
        to,
        type: "interactive",
        interactive: {
          type: "button",
          body: {
            text: `Hola ${nombre}, ¿qué quieres hacer hoy?`,
          },
          action: {
            buttons: [
              {
                type: "reply",
                reply: {
                  id: "solicitar_servicio",
                  title: "Solicitar servicio",
                },
              },
              {
                type: "reply",
                reply: {
                  id: "mis_solicitudes",
                  title: "Mis solicitudes",
                },
              },
              {
                type: "reply",
                reply: {
                  id: "ayuda",
                  title: "Ayuda",
                },
              },
            ],
          },
        },
      },
      {
        headers: {
          Authorization: `Bearer ${WHATSAPP_TOKEN}`,
          "Content-Type": "application/json",
        },
      }
    );
  } catch (error) {
    console.error(
      "Error enviando menú:",
      error.response?.data || error.message
    );
  }
}

async function solicitarUbicacion(to) {
  await sendText(
    to,
    "📍 Por favor envía tu ubicación actual usando la función de ubicación de WhatsApp."
  );
}

async function mostrarAyuda(to) {
  await sendText(
    to,
    "🆘 Soporte WIGO\n\nSi tienes inconvenientes con tu servicio, responde a este chat o comunícate con nuestro equipo de soporte."
  );
}

async function mostrarSolicitudes(usuarioId, telefono) {
  const result = await pool.query(
    `
    SELECT *
    FROM solicitudes
    WHERE usuario_id = $1
    ORDER BY created_at DESC
    LIMIT 5
    `,
    [usuarioId]
  );

  if (result.rows.length === 0) {
    return sendText(
      telefono,
      "No tienes solicitudes registradas."
    );
  }

  let mensaje = "📋 Tus últimas solicitudes:\n\n";

  result.rows.forEach((s) => {
    mensaje += `#${s.id}\n`;
    mensaje += `Destino: ${s.destino || "Pendiente"}\n`;
    mensaje += `Estado: ${s.estado}\n\n`;
  });

  await sendText(telefono, mensaje);
}

async function procesarMensaje(message) {
  const telefono = message.from;

  let usuarioResult = await pool.query(
    "SELECT * FROM usuarios WHERE telefono = $1",
    [telefono]
  );

  let usuario = usuarioResult.rows[0];

  // NUEVO USUARIO
  if (!usuario) {
    await pool.query(
      `
      INSERT INTO usuarios
      (telefono, estado_registro)
      VALUES ($1,'esperando_nombre')
      `,
      [telefono]
    );

    return sendText(
      telefono,
      "👋 Bienvenido a WIGO.\n\n¿Cuál es tu nombre?"
    );
  }

  // TEXTO
  let texto = "";

  if (message.text) {
    texto = message.text.body.trim();
  }

  // REGISTRO NOMBRE
  if (usuario.estado_registro === "esperando_nombre") {
    await pool.query(
      `
      UPDATE usuarios
      SET nombre=$1,
          estado_registro='esperando_ciudad'
      WHERE telefono=$2
      `,
      [texto, telefono]
    );

    return sendText(
      telefono,
      "🏙️ ¿En qué ciudad te encuentras?"
    );
  }

  // REGISTRO CIUDAD
  if (usuario.estado_registro === "esperando_ciudad") {
    await pool.query(
      `
      UPDATE usuarios
      SET ciudad=$1,
          estado_registro='completo'
      WHERE telefono=$2
      `,
      [texto, telefono]
    );

    usuario.nombre = usuario.nombre || texto;

    return sendMenu(telefono, usuario.nombre);
  }

  // UBICACIÓN
  if (message.location) {
    const origen = JSON.stringify({
      latitude: message.location.latitude,
      longitude: message.location.longitude,
    });

    const solicitud = await pool.query(
      `
      INSERT INTO solicitudes
      (usuario_id, origen, estado)
      VALUES ($1,$2,'esperando_destino')
      RETURNING *
      `,
      [usuario.id, origen]
    );

    return sendText(
      telefono,
      `📍 Ubicación recibida.\n\nAhora escribe tu destino.`
    );
  }

  // DESTINO
  const pendiente = await pool.query(
    `
    SELECT *
    FROM solicitudes
    WHERE usuario_id=$1
    AND estado='esperando_destino'
    ORDER BY id DESC
    LIMIT 1
    `,
    [usuario.id]
  );

  if (
    pendiente.rows.length > 0 &&
    texto
  ) {
    await pool.query(
      `
      UPDATE solicitudes
      SET destino=$1,
          estado='pendiente'
      WHERE id=$2
      `,
      [texto, pendiente.rows[0].id]
    );

    await sendText(
      telefono,
      "✅ Tu solicitud fue creada exitosamente.\n\nEn breve será asignada a un conductor."
    );

    return sendMenu(telefono, usuario.nombre);
  }

  // BOTONES
  if (message.interactive?.button_reply) {
    const id = message.interactive.button_reply.id;

    if (id === "solicitar_servicio") {
      return solicitarUbicacion(telefono);
    }

    if (id === "mis_solicitudes") {
      return mostrarSolicitudes(
        usuario.id,
        telefono
      );
    }

    if (id === "ayuda") {
      return mostrarAyuda(telefono);
    }
  }

  // TEXTO MENÚ
  const normalizado = texto.toLowerCase();

  if (
    normalizado === "hola" ||
    normalizado === "menu" ||
    normalizado === "menú"
  ) {
    return sendMenu(
      telefono,
      usuario.nombre
    );
  }

  return sendMenu(
    telefono,
    usuario.nombre
  );
}

// WEBHOOK VERIFICATION
app.get("/webhook", (req, res) => {
  const mode = req.query["hub.mode"];
  const token = req.query["hub.verify_token"];
  const challenge = req.query["hub.challenge"];

  if (
    mode &&
    token &&
    mode === "subscribe" &&
    token === VERIFY_TOKEN
  ) {
    return res.status(200).send(challenge);
  }

  return res.sendStatus(403);
});

// WEBHOOK MESSAGES
app.post("/webhook", async (req, res) => {
  try {
    const body = req.body;

    if (
      body.object &&
      body.entry &&
      body.entry[0]?.changes &&
      body.entry[0]?.changes[0]?.value?.messages
    ) {
      const message =
        body.entry[0].changes[0].value.messages[0];

      await procesarMensaje(message);
    }

    res.sendStatus(200);
  } catch (error) {
    console.error(error);
    res.sendStatus(500);
  }
});

initDatabase().then(() => {
  app.listen(PORT, () => {
    console.log(`🚀 WIGO ejecutándose en puerto ${PORT}`);
  });
});
