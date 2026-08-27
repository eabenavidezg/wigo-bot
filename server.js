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
        ...
      );
    `);

    await pool.query(`
      CREATE TABLE IF NOT EXISTS solicitudes (
        id SERIAL PRIMARY KEY,
        usuario_id INTEGER REFERENCES usuarios(id),
        created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
      );
    `);

    await pool.query(`
      ALTER TABLE solicitudes
      ADD COLUMN IF NOT EXISTS origen_lat DECIMAL(12,8);
    `);

    await pool.query(`
      ALTER TABLE solicitudes
      ADD COLUMN IF NOT EXISTS origen_lng DECIMAL(12,8);
    `);

    await pool.query(`
      ALTER TABLE solicitudes
      ADD COLUMN IF NOT EXISTS destino TEXT;
    `);

    await pool.query(`
      ALTER TABLE solicitudes
      ADD COLUMN IF NOT EXISTS estado VARCHAR(50) DEFAULT 'pendiente';
    `);

  } catch (error) {
    console.error(error);
  }
}

// ======================================
// WHATSAPP HELPERS
// ======================================

async function enviarTexto(to, body) {
  try {

    await axios.post(
      `https://graph.facebook.com/v23.0/${PHONE_NUMBER_ID}/messages`,
      {
        messaging_product: "whatsapp",
        to,
        type: "text",
        text: {
          body
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
      JSON.stringify(
        error.response?.data || error.message,
        null,
        2
      )
    );

  }
}

async function enviarBotones(
  to,
  mensaje,
  botones
) {

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
      JSON.stringify(
        error.response?.data || error.message,
        null,
        2
      )
    );

  }

}

async function enviarMenu(
  telefono,
  nombre
) {

  return enviarBotones(
    telefono,
    `👋 Hola ${nombre}

¿Qué deseas hacer hoy?`,
    [
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
          id: "HISTORIAL",
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

async function solicitarUbicacion(
  telefono
) {

  try {

    await axios.post(
      `https://graph.facebook.com/v23.0/${PHONE_NUMBER_ID}/messages`,
      {
        messaging_product: "whatsapp",
        to: telefono,
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
      JSON.stringify(
        error.response?.data || error.message,
        null,
        2
      )
    );

    await enviarTexto(
      telefono,
      "📍 Comparte tu ubicación desde Adjuntar → Ubicación."
    );

  }

}

async function mostrarAyuda(
  telefono
) {

  return enviarTexto(
    telefono,
    `🆘 Soporte WIGO

Si necesitas ayuda responde este chat.`
  );

}

async function mostrarHistorial(
  usuarioId,
  telefono
) {

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

  let mensaje =
    "📖 Últimas solicitudes\n\n";

  result.rows.forEach((s) => {

    mensaje += `#${s.id}\n`;
    mensaje += `Destino: ${s.destino || "Pendiente"}\n`;
    mensaje += `Estado: ${s.estado}\n\n`;

  });

  await enviarTexto(
    telefono,
    mensaje
  );

}

// =====================================
// LOGICA
// =====================================

async function procesarMensaje(
  message
) {

  const telefono = message.from;

  const result = await pool.query(
    `
    SELECT *
    FROM usuarios
    WHERE telefono = $1
  `,
    [telefono]
  );

  let usuario = result.rows[0];

  let texto = "";

  if (message.text?.body) {
    texto = message.text.body.trim();
  }

  // NUEVO USUARIO

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

    return enviarTexto(
      telefono,
      `🚖 Bienvenido a WIGO

Vamos a crear tu perfil.

✍️ ¿Cuál es tu nombre completo?`
    );

  }

  // NOMBRE

  if (
    usuario.estado_registro ===
    "esperando_nombre"
  ) {

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
      "🏙️ ¿En qué ciudad te encuentras?"
    );

  }

  // CIUDAD

  if (
    usuario.estado_registro ===
    "esperando_ciudad"
  ) {

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

  // UBICACION

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

  // DESTINO

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
      [
        texto,
        pendiente.rows[0].id
      ]
    );

    await enviarTexto(
      telefono,
      `✅ Solicitud registrada

📍 Destino: ${texto}

Estamos buscando un conductor disponible.`
    );

    return enviarMenu(
      telefono,
      usuario.nombre
    );

  }

  // BOTONES

  if (
    message.interactive?.button_reply
  ) {

    const id =
      message.interactive.button_reply.id;

    if (id === "SOLICITAR") {
      return solicitarUbicacion(
        telefono
      );
    }

    if (id === "HISTORIAL") {
      return mostrarHistorial(
        usuario.id,
        telefono
      );
    }

    if (id === "AYUDA") {
      return mostrarAyuda(
        telefono
      );
    }

  }

  return enviarMenu(
    telefono,
    usuario.nombre
  );

}

// =====================================
// WEBHOOK VERIFY
// =====================================

app.get("/webhook", (req, res) => {

  const mode =
    req.query["hub.mode"];

  const token =
    req.query["hub.verify_token"];

  const challenge =
    req.query["hub.challenge"];

  if (
    mode === "subscribe" &&
    token === VERIFY_TOKEN
  ) {
    return res
      .status(200)
      .send(challenge);
  }

  return res.sendStatus(403);

});

// =====================================
// WEBHOOK EVENTS
// =====================================

app.post(
  "/webhook",
  async (req, res) => {

    try {

      const message =
        req.body?.entry?.[0]
          ?.changes?.[0]
          ?.value?.messages?.[0];

      if (!message) {
        return res.sendStatus(200);
      }

      console.log(
        JSON.stringify(
          message,
          null,
          2
        )
      );

      await procesarMensaje(
        message
      );

      return res.sendStatus(200);

    } catch (error) {

      console.error(
        "ERROR WEBHOOK:",
        error
      );

      return res.sendStatus(200);

    }

  }
);

// =====================================
// HOME
// =====================================

app.get("/", (req, res) => {
  res.send("🚖 WIGO ONLINE");
});

app.get("/db-check", async (req, res) => {
  try {

    const result = await pool.query(`
      SELECT column_name
      FROM information_schema.columns
      WHERE table_name = 'solicitudes'
      ORDER BY ordinal_position
    `);

    res.json(result.rows);

  } catch (error) {

    res.status(500).json(error);

  }
});

// =====================================
// START
// =====================================

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
