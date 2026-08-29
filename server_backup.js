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
    rejectUnauthorized: false,
  },
});

async function initDatabase() {
  const client = await pool.connect();

  try {
    await client.query(`
      CREATE TABLE IF NOT EXISTS usuarios (
        id SERIAL PRIMARY KEY,
        telefono VARCHAR(30) UNIQUE NOT NULL,
        nombre VARCHAR(150),
        ciudad VARCHAR(100),
        acepto_datos BOOLEAN DEFAULT FALSE,
        fecha_aceptacion TIMESTAMP,
        estado_registro VARCHAR(50),
        created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
      )
    `);

    await client.query(`
      ALTER TABLE usuarios
      ADD COLUMN IF NOT EXISTS nombre VARCHAR(150)
    `);

    await client.query(`
      ALTER TABLE usuarios
      ADD COLUMN IF NOT EXISTS ciudad VARCHAR(100)
    `);

    await client.query(`
      ALTER TABLE usuarios
      ADD COLUMN IF NOT EXISTS acepto_datos BOOLEAN DEFAULT FALSE
    `);

    await client.query(`
      ALTER TABLE usuarios
      ADD COLUMN IF NOT EXISTS fecha_aceptacion TIMESTAMP
    `);

    await client.query(`
      ALTER TABLE usuarios
      ADD COLUMN IF NOT EXISTS estado_registro VARCHAR(50)
    `);

    await client.query(`
      CREATE TABLE IF NOT EXISTS solicitudes (
        id SERIAL PRIMARY KEY,
        usuario_id INTEGER REFERENCES usuarios(id),
        origen_lat DECIMAL(12,8),
        origen_lng DECIMAL(12,8),
        destino TEXT,
        estado VARCHAR(50) DEFAULT 'pendiente',
        created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
      )
    `);

    await client.query(`
      ALTER TABLE solicitudes
      ADD COLUMN IF NOT EXISTS origen_lat DECIMAL(12,8)
    `);

    await client.query(`
      ALTER TABLE solicitudes
      ADD COLUMN IF NOT EXISTS origen_lng DECIMAL(12,8)
    `);

    await client.query(`
      ALTER TABLE solicitudes
      ADD COLUMN IF NOT EXISTS destino TEXT
    `);

    await client.query(`
      ALTER TABLE solicitudes
      ADD COLUMN IF NOT EXISTS estado VARCHAR(50) DEFAULT 'pendiente'
    `);

    console.log("Base de datos inicializada correctamente");
  } finally {
    client.release();
  }
}

async function sendWhatsAppMessage(payload) {
  try {
    await axios.post(
      `https://graph.facebook.com/v21.0/${PHONE_NUMBER_ID}/messages`,
      payload,
      {
        headers: {
          Authorization: `Bearer ${WHATSAPP_TOKEN}`,
          "Content-Type": "application/json",
        },
      }
    );
  } catch (error) {
    console.error(
      "META ERROR:",
      JSON.stringify(
        error.response?.data || error.message,
        null,
        2
      )
    );
    throw error;
  }
}

async function sendText(to, text) {
  return sendWhatsAppMessage({
    messaging_product: "whatsapp",
    to,
    type: "text",
    text: {
      body: text,
    },
  });
}

async function sendAcceptDataButton(to) {
  return sendWhatsAppMessage({
    messaging_product: "whatsapp",
    to,
    type: "interactive",
    interactive: {
      type: "button",
      body: {
        text:
          "🚖 ¡Bienvenido a WIGO!\n\nAntes de continuar, necesitamos tu autorización para el tratamiento de tus datos personales con el fin de gestionar solicitudes de transporte y brindarte una mejor experiencia de servicio.\n\n¿Deseas continuar?",
      },
      action: {
        buttons: [
          {
            type: "reply",
            reply: {
              id: "ACEPTAR_DATOS",
              title: "✅ Aceptar",
            },
          },
        ],
      },
    },
  });
}

async function sendMainMenu(to, nombreCompleto) {
  const primerNombre =
    (nombreCompleto || "").trim().split(/\s+/)[0] || "Usuario";

  return sendWhatsAppMessage({
    messaging_product: "whatsapp",
    to,
    type: "interactive",
    interactive: {
      type: "button",
      body: {
        text: `👋 Hola, ${primerNombre}.\n🚖 ¿A dónde vamos hoy?`,
      },
      action: {
        buttons: [
          {
            type: "reply",
            reply: {
              id: "SOLICITAR",
              title: "🚖 Solicitar viaje",
            },
          },
        ],
      },
    },
  });
}

async function requestLocation(to) {
  try {
    await sendWhatsAppMessage({
      messaging_product: "whatsapp",
      recipient_type: "individual",
      to,
      type: "interactive",
      interactive: {
        type: "location_request_message",
        body: {
          text:
            "📍 Comparte tu ubicación actual para encontrar conductores cercanos.",
        },
        action: {
          name: "send_location",
        },
      },
    });
  } catch (error) {
    await sendText(
      to,
      "📍 Comparte tu ubicación usando Adjuntar → Ubicación."
    );
  }
}

async function getUserByPhone(phone) {
  const result = await pool.query(
    `SELECT * FROM usuarios WHERE telefono = $1`,
    [phone]
  );

  return result.rows[0] || null;
}

async function createUser(phone) {
  const result = await pool.query(
    `
      INSERT INTO usuarios (
        telefono,
        estado_registro
      )
      VALUES ($1,'aceptacion_datos')
      ON CONFLICT (telefono)
      DO UPDATE SET telefono = EXCLUDED.telefono
      RETURNING *
    `,
    [phone]
  );

  return result.rows[0];
}

async function processInteractiveReply(user, from, replyId) {
  if (replyId === "ACEPTAR_DATOS") {
    await pool.query(
      `
      UPDATE usuarios
      SET
        acepto_datos = TRUE,
        fecha_aceptacion = NOW(),
        estado_registro = 'esperando_nombre'
      WHERE id = $1
    `,
      [user.id]
    );

    await sendText(
      from,
      "🛡️ Por tu seguridad y la de nuestros conductores, indícanos por favor tu nombre y apellido."
    );

    return;
  }

  if (replyId === "SOLICITAR") {
    await requestLocation(from);
    return;
  }
}

async function processLocation(user, from, location) {
  const result = await pool.query(
    `
      INSERT INTO solicitudes (
        usuario_id,
        origen_lat,
        origen_lng,
        estado
      )
      VALUES ($1,$2,$3,'esperando_destino')
      RETURNING id
    `,
    [
      user.id,
      location.latitude,
      location.longitude,
    ]
  );

  if (result.rows.length > 0) {
    await sendText(
      from,
      "✅ Ubicación recibida correctamente.\n📍 ¿Hacia dónde te diriges?"
    );
  }
}

async function processText(user, from, text) {
  const estado = user.estado_registro || "";

  if (estado === "aceptacion_datos") {
    await sendAcceptDataButton(from);
    return;
  }

  if (estado === "esperando_nombre") {
    await pool.query(
      `
      UPDATE usuarios
      SET
        nombre = $1,
        estado_registro = 'esperando_ciudad'
      WHERE id = $2
    `,
      [text, user.id]
    );

    await sendText(
      from,
      "📍 ¿En qué ciudad deseas utilizar WIGO?"
    );

    return;
  }

  if (estado === "esperando_ciudad") {
    await pool.query(
      `
      UPDATE usuarios
      SET
        ciudad = $1,
        estado_registro = 'completo'
      WHERE id = $2
    `,
      [text, user.id]
    );

    const updatedUser = await getUserByPhone(from);

    await sendMainMenu(
      from,
      updatedUser.nombre
    );

    return;
  }

  const solicitudPendiente = await pool.query(
    `
      SELECT *
      FROM solicitudes
      WHERE usuario_id = $1
      AND estado = 'esperando_destino'
      ORDER BY id DESC
      LIMIT 1
    `,
    [user.id]
  );

  if (solicitudPendiente.rows.length > 0) {
    const solicitud = solicitudPendiente.rows[0];

    await pool.query(
      `
      UPDATE solicitudes
      SET
        destino = $1,
        estado = 'pendiente'
      WHERE id = $2
    `,
      [text, solicitud.id]
    );

    await sendText(
      from,
      `✅ Solicitud registrada con éxito.\n\n📍 Origen: Ubicación compartida\n📍 Destino: ${text}\n\n⏳ Estamos buscando un conductor disponible.\nTe notificaremos cuando tu solicitud sea aceptada.`
    );

    return;
  }

  if (estado === "completo") {
    await sendMainMenu(
      from,
      user.nombre
    );
  }
}

app.get("/", (req, res) => {
  res.status(200).send("🚖 WIGO ONLINE");
});

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

app.post("/webhook", async (req, res) => {
  try {
    const entry =
      req.body?.entry?.[0];

    const change =
      entry?.changes?.[0];

    const value =
      change?.value;

    const message =
      value?.messages?.[0];

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

    const from = message.from;

    let user = await getUserByPhone(from);

    if (!user) {
      user = await createUser(from);
      await sendAcceptDataButton(from);
      return res.sendStatus(200);
    }

    if (
      message.type === "interactive" &&
      message.interactive?.button_reply
    ) {
      await processInteractiveReply(
        user,
        from,
        message.interactive.button_reply.id
      );

      return res.sendStatus(200);
    }

    if (
      message.type === "location" &&
      message.location
    ) {
      await processLocation(
        user,
        from,
        message.location
      );

      return res.sendStatus(200);
    }

    if (
      message.type === "text" &&
      message.text?.body
    ) {
      await processText(
        user,
        from,
        message.text.body.trim()
      );

      return res.sendStatus(200);
    }

    return res.sendStatus(200);
  } catch (error) {
    console.error(
      "WEBHOOK ERROR:",
      error
    );

    return res.sendStatus(500);
  }
});

(async () => {
  try {
    await initDatabase();

    app.listen(PORT, () => {
      console.log(
        `WIGO ejecutándose en puerto ${PORT}`
      );
    });
  } catch (error) {
    console.error(
      "ERROR DE INICIO:",
      error
    );
    process.exit(1);
  }
})();
