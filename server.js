const express = require("express");
const axios = require("axios");
const { Pool } = require("pg");

const app = express();

app.use(express.json());

const PORT = process.env.PORT || 3000;

const VERIFY_TOKEN = process.env.VERIFY_TOKEN;
const WHATSAPP_TOKEN = process.env.WHATSAPP_TOKEN;
const PHONE_NUMBER_ID = process.env.PHONE_NUMBER_ID;

const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: {
    rejectUnauthorized: false
  }
});

// ======================================
// DATABASE
// ======================================

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
    console.error("❌ Error creando tablas:", error);
  }
}

// ======================================
// WHATSAPP HELPERS
// ======================================

async function enviarTexto(destino, mensaje) {
  try {
    await axios.post(
      `https://graph.facebook.com/v23.0/${PHONE_NUMBER_ID}/messages`,
      {
        messaging_product: "whatsapp",
        to: destino,
        type: "text",
        text: {
          body: mensaje
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
      "ERROR TEXTO:",
      JSON.stringify(error.response?.data || error.message, null, 2)
    );
  }
}

async function enviarBotones(destino, mensaje, botones) {
  try {
    await axios.post(
      `https://graph.facebook.com/v23.0/${PHONE_NUMBER_ID}/messages`,
      {
        messaging_product: "whatsapp",
        to: destino,
        type: "interactive",
        interactive: {
          type: "button",
          body: {
            text: mensaje
          },
          action: {
            buttons: botones
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
      "ERROR BOTONES:",
      JSON.stringify(error.response?.data || error.message, null, 2)
    );
  }
}

async function enviarMenu(destino, nombre) {
  return enviarBotones(
    destino,
    `👋 Hola ${nombre}

¿Qué deseas hacer hoy?`,
    [
      {
        type: "reply",
        reply: {
          id: "SOLICITAR_SERVICIO",
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
  );
}

async function solicitarUbicacion(destino) {
  try {
    await axios.post(
      `https://graph.facebook.com/v23.0/${PHONE_NUMBER_ID}/messages`,
      {
        messaging_product: "whatsapp",
        to: destino,
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
      "ERROR UBICACION:",
      JSON.stringify(error.response?.data || error.message, null, 2)
    );

    await enviarTexto(
      destino,
      "📍 Comparte tu ubicación actual usando el botón Adjuntar → Ubicación."
    );
  }
}

// ======================================
// HISTORIAL
// ======================================

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
    return enviarTexto(
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

  await enviarTexto(telefono, mensaje);
}

// ======================================
// AYUDA
// ======================================

async function mostrarAyuda(telefono) {
  await enviarTexto(
    telefono,
    `🆘 Soporte WIGO

Si necesitas ayuda, responde este chat y nuestro equipo te atenderá.`
  );
}

// ======================================
// LOGICA PRINCIPAL
// ======================================

async function procesarMensaje(message) {
  const telefono = message.from;

  const usuarioResult = await pool.query(
    "SELECT * FROM usuarios WHERE telefono = $1",
    [telefono]
  );

  let usuario = usuarioResult.rows[0];

  let texto = "";

  if (message.text?.body) {
    texto = message.text.body.trim();
  }

  // =========================
  // NUEVO USUARIO
  // =========================

  if (!usuario) {
    await pool.query(
      `
      INSERT INTO usuarios
      (telefono, estado_registro)
      VALUES
      ($1, 'esperando_nombre')
      `,
      [telefono]
    );

    return enviarTexto(
      telefono,
      `🚖 Bienvenido a WIGO

Vamos a crear tu perfil.

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

    return enviarTexto(
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

    usuario.nombre = usuario.nombre || "Usuario";

    return enviarMenu(
      telefono,
      usuario.nombre
    );
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

    return enviarTexto(
      telefono,
      "📍 Ubicación recibida.\n\n¿Cuál es tu destino?"
    );
  }

  // =========================
  // DESTINO
  // =========================

  const solicitudPendiente = await pool.query(
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
    solicitudPendiente.rows.length > 0 &&
    texto
  ) {
    await pool.query(
      `
      UPDATE solicitudes
      SET destino = $1,
          estado = 'pendiente'
      WHERE id = $2
      `,
      [texto, solicitudPendiente.rows[0].id]
    );

    await enviarTexto(
      telefono,
      `✅ Solicitud registrada

📍 Origen: ubicación compartida
📍 Destino: ${texto}

Estamos buscando un conductor disponible.`
    );

    return enviarMenu(
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
    const botonId =
      message.interactive.button_reply.id;

    if (botonId === "SOLICITAR_SERVICIO") {
      return solicitarUbicacion(telefono);
    }

    if (botonId === "MIS_SOLICITUDES") {
      return mostrarSolicitudes(
        usuario.id,
        telefono
      );
    }

    if (botonId === "AYUDA") {
      return mostrarAyuda(telefono);
    }
  }

  // =========================
  // MENU AUTOMATICO
  // =========================

  return enviarMenu(
    telefono,
    usuario.nombre
  );
}

// ======================================
// HOME
// ======================================

app.get("/", (req, res) => {
  res.send("🚖 WIGO ONLINE");
});

// ======================================
// VERIFY WEBHOOK
// ======================================

app.get("/webhook", (req, res) => {
  const mode = req.query["hub.mode"];
  const token = req.query["hub.verify_token"];
  const challenge = req.query["hub.challenge"];

  if (
    mode === "subscribe" &&
    token === VERIFY_TOKEN
  ) {
    return res.status(200).send(challenge);
  }

  return res.sendStatus(403);
});

// ======================================
// WEBHOOK EVENTS
// ======================================

app.post("/webhook", async (req, res) => {
  try {
    const message =
      req.body?.entry?.[0]?.changes?.[0]?.value?.messages?.[0];

    if (!message) {
      return res.sendStatus(200);
    }

    console.log(
      JSON.stringify(message, null, 2)
    );

    await procesarMensaje(message);

    return res.sendStatus(200);
  } catch (error) {
    console.error(
      "ERROR WEBHOOK:",
      error
    );

    return res.sendStatus(200);
  }
});

// ======================================
// START
// ======================================

initDatabase().then(() => {
  console.log(
    "PHONE_NUMBER_ID:",
    PHONE_NUMBER_ID
  );

  app.listen(PORT, () => {
    console.log(
      `🚀 WIGO ejecutándose en puerto ${PORT}`
    );
  });
});
