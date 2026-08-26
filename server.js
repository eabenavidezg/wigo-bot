const express = require("express");
const axios = require("axios");
const { Pool } = require("pg");

const app = express();

app.use(express.json());

const PORT = process.env.PORT || 3000;

const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: {
    rejectUnauthorized: false
  }
});

const VERIFY_TOKEN = process.env.VERIFY_TOKEN;
const WHATSAPP_TOKEN = process.env.WHATSAPP_TOKEN;
const PHONE_NUMBER_ID = process.env.PHONE_NUMBER_ID;

// =========================
// DATABASE
// =========================

async function initDatabase() {
  try {
    await pool.query(`
      CREATE TABLE IF NOT EXISTS usuarios (
        id SERIAL PRIMARY KEY,
        telefono VARCHAR(30) UNIQUE NOT NULL,
        nombre VARCHAR(150),
        ciudad VARCHAR(100),
        estado_registro VARCHAR(50) DEFAULT 'esperando_nombre',
        created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
      );
    `);

    await pool.query(`
      CREATE TABLE IF NOT EXISTS solicitudes (
        id SERIAL PRIMARY KEY,
        usuario_id INTEGER REFERENCES usuarios(id),
        origen_lat DECIMAL(12,8),
        origen_lng DECIMAL(12,8),
        destino TEXT,
        estado VARCHAR(50) DEFAULT 'pendiente',
        created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
      );
    `);

    console.log("✅ Tablas verificadas");
  } catch (error) {
    console.error("Error BD:", error);
  }
}

// =========================
// WHATSAPP
// =========================

async function sendText(to, text) {
  try {
    await axios.post(
      `https://graph.facebook.com/v23.0/${PHONE_NUMBER_ID}/messages`,
      {
        messaging_product: "whatsapp",
        to,
        type: "text",
        text: {
          body: text
        }
      },
      {
        headers: {
          Authorization: `Bearer ${WHATSAPP_TOKEN}`,
          "Content-Type": "application/json"
        }
      }
    );
  } catch (error) {
    console.error(
      "ERROR SENDTEXT:",
      JSON.stringify(error.response?.data || error.message, null, 2)
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
            text: `👋 Hola ${nombre}\n\n¿Qué deseas hacer hoy?`
          },
          action: {
            buttons: [
              {
                type: "reply",
                reply: {
                  id: "SOLICITAR",
                  title: "🚖 Solicitar"
                }
              },
              {
                type: "reply",
                reply: {
                  id: "MIS_SOLICITUDES",
                  title: "📖 Historial"
                }
              },
              {
                type: "reply",
                reply: {
                  id: "AYUDA",
                  title: "🆘 Ayuda"
                }
              }
            ]
          }
        }
      },
      {
        headers: {
          Authorization: `Bearer ${WHATSAPP_TOKEN}`,
          "Content-Type": "application/json"
        }
      }
    );
  } catch (error) {
    console.error(
      "ERROR MENU:",
      JSON.stringify(error.response?.data || error.message, null, 2)
    );
  }
}

async function solicitarUbicacion(to) {
  try {
    await axios.post(
      `https://graph.facebook.com/v23.0/${PHONE_NUMBER_ID}/messages`,
      {
        messaging_product: "whatsapp",
        to,
        type: "interactive",
        interactive: {
          type: "location_request_message",
          body: {
            text: "📍 Comparte tu ubicación actual"
          },
          action: {
            name: "send_location"
          }
        }
      },
      {
        headers: {
          Authorization: `Bearer ${WHATSAPP_TOKEN}`,
          "Content-Type": "application/json"
        }
      }
    );
  } catch (error) {
    console.error(
      "ERROR LOCATION:",
      JSON.stringify(error.response?.data || error.message, null, 2)
    );

    await sendText(
      to,
      "📍 Comparte tu ubicación actual usando la opción Ubicación de WhatsApp."
    );
  }
}

async function mostrarAyuda(to) {
  await sendText(
    to,
    `🆘 Soporte WIGO

Si tienes inconvenientes con tu solicitud, responde este chat y nuestro equipo te ayudará.`
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
      "📖 No tienes solicitudes registradas."
    );
  }

  let mensaje = "📖 Últimas solicitudes\n\n";

  result.rows.forEach((s) => {
    mensaje += `#${s.id}\n`;
    mensaje += `Destino: ${s.destino || "Pendiente"}\n`;
    mensaje += `Estado: ${s.estado}\n\n`;
  });

  await sendText(telefono, mensaje);
}

// =========================
// LOGICA BOT
// =========================

async function procesarMensaje(message) {
  const telefono = message.from;

  let usuarioResult = await pool.query(
    `
    SELECT *
    FROM usuarios
    WHERE telefono = $1
  `,
    [telefono]
  );

  let usuario = usuarioResult.rows[0];

  let texto = "";

  if (message.text) {
    texto = message.text.body.trim();
  }

  // =========================
  // USUARIO NUEVO
  // =========================

  if (!usuario) {
    await pool.query(
      `
      INSERT INTO usuarios
      (
        telefono,
        estado_registro
      )
      VALUES
      (
        $1,
        'esperando_nombre'
      )
    `,
      [telefono]
    );

    return sendText(
      telefono,
      `🚖 Bienvenido a WIGO

Antes de solicitar tu primer servicio debemos crear tu perfil.

✍️ ¿Cuál es tu nombre completo?`
    );
  }

  // =========================
  // NOMBRE
  // =========================

  if (usuario.estado_registro === "esperando_nombre") {
    await pool.query(
      `
      UPDATE usuarios
      SET nombre = $1,
          estado_registro = 'esperando_ciudad'
      WHERE telefono = $2
    `,
      [texto, telefono]
    );

    return sendText(
      telefono,
      "📍 ¿En qué ciudad te encuentras?"
    );
  }

  // =========================
  // CIUDAD
  // =========================

  if (usuario.estado_registro === "esperando_ciudad") {
    await pool.query(
      `
      UPDATE usuarios
      SET ciudad = $1,
          estado_registro = 'completo'
      WHERE telefono = $2
    `,
      [texto, telefono]
    );

    return sendMenu(telefono, usuario.nombre);
  }

  // =========================
  // UBICACION
  // =========================

  if (message.location) {
    await pool.query(
      `
      INSERT INTO solicitudes
      (
        usuario_id,
        origen_lat,
        origen_lng,
        estado
      )
      VALUES
      (
        $1,
        $2,
        $3,
        'esperando_destino'
      )
    `,
      [
        usuario.id,
        message.location.latitude,
        message.location.longitude
      ]
    );

    return sendText(
      telefono,
      "📍 Ubicación recibida.\n\n¿Cuál es tu destino?"
    );
  }

  // =========================
  // DESTINO
  // =========================

  const pendiente = await pool.query(
    `
    SELECT *
    FROM solicitudes
    WHERE usuario_id = $1
    AND estado = 'esperando_destino'
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
      SET destino = $1,
          estado = 'pendiente'
      WHERE id = $2
    `,
      [texto, pendiente.rows[0].id]
    );

    await sendText(
      telefono,
      `✅ Solicitud registrada

📍 Origen: ubicación compartida
📍 Destino: ${texto}

Estamos buscando un conductor disponible.`
    );

    return sendMenu(
      telefono,
      usuario.nombre
    );
  }

  // =========================
  // BOTONES
  // =========================

  if (
    message.interactive &&
    message.interactive.button_reply
  ) {
    const id = message.interactive.button_reply.id;

    if (id === "SOLICITAR") {
      return solicitarUbicacion(telefono);
    }

    if (id === "MIS_SOLICITUDES") {
      return mostrarSolicitudes(
        usuario.id,
        telefono
      );
    }

    if (id === "AYUDA") {
      return mostrarAyuda(telefono);
    }
  }

  // =========================
  // MENU AUTOMATICO
  // =========================

  return sendMenu(
    telefono,
    usuario.nombre
  );
}

// =========================
// WEBHOOK VERIFY
// =========================

app.get("/webhook", (req, res) => {
  const mode = req.
