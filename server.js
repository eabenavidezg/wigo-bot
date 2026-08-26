const express = require("express");
const axios = require("axios");

const app = express();

app.use(express.json());

const VERIFY_TOKEN = "wigo123";
const TOKEN = process.env.WHATSAPP_TOKEN;
const PHONE_NUMBER_ID = process.env.PHONE_NUMBER_ID;

const usuarios = {};

// =========================
// MENSAJES
// =========================

async function enviarTexto(destino, mensaje) {
  return axios.post(
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
        Authorization: `Bearer ${TOKEN}`,
        "Content-Type": "application/json"
      }
    }
  );
}

async function enviarBotones(destino, mensaje, botones) {
  return axios.post(
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
        Authorization: `Bearer ${TOKEN}`,
        "Content-Type": "application/json"
      }
    }
  );
}

async function solicitarUbicacion(destino) {
  return axios.post(
    `https://graph.facebook.com/v23.0/${PHONE_NUMBER_ID}/messages`,
    {
      messaging_product: "whatsapp",
      to: destino,
      type: "interactive",
      interactive: {
        type: "location_request_message",
        body: {
          text: "📍 ¿Dónde te recogemos?"
        },
        action: {
          name: "send_location"
        }
      }
    },
    {
      headers: {
        Authorization: `Bearer ${TOKEN}`,
        "Content-Type": "application/json"
      }
    }
  );
}

// =========================
// WEBHOOK
// =========================

app.get("/", (req, res) => {
  res.send("WIGO Bot funcionando 🚖");
});

app.get("/webhook", (req, res) => {
  const mode = req.query["hub.mode"];
  const token = req.query["hub.verify_token"];
  const challenge = req.query["hub.challenge"];

  if (mode === "subscribe" && token === VERIFY_TOKEN) {
    return res.status(200).send(challenge);
  }

  return res.sendStatus(403);
});

app.post("/webhook", async (req, res) => {
  try {

    const message =
      req.body?.entry?.[0]?.changes?.[0]?.value?.messages?.[0];

    if (!message) {
      return res.sendStatus(200);
    }

    const from = message.from;

    if (!usuarios[from]) {
      usuarios[from] = {
        estado: "nuevo"
      };
    }

    const usuario = usuarios[from];

    let texto = "";

    if (message.type === "text") {
      texto = message.text.body.trim();
    }

    let botonId = "";

    if (
      message.type === "interactive" &&
      message.interactive?.button_reply
    ) {
      botonId = message.interactive.button_reply.id;
    }

    const esMenu =
      message.type === "text" &&
      ["hola", "menu", "menú"].includes(
        texto.toLowerCase()
      );

    // =========================
    // NUEVO USUARIO
    // =========================

    if (usuario.estado === "nuevo") {

      usuario.estado = "registrarme";

      await enviarBotones(
        from,
        `🚖 Bienvenido(a)

Con WIGO moverte vuelve a sentirse fácil.

Todo empieza con un mensaje.`,
        [
          {
            type: "reply",
            reply: {
              id: "REGISTRARME",
              title: "📝 Registrarme"
            }
          }
        ]
      );

      return res.sendStatus(200);
    }

    // =========================
    // REGISTRARME
    // =========================

    if (
      usuario.estado === "registrarme" &&
      botonId === "REGISTRARME"
    ) {

      usuario.estado = "terminos";

      await enviarBotones(
        from,
        `🔒 Protegemos tu información y respetamos tu privacidad.

Confirma para seguir.`,
        [
          {
            type: "reply",
            reply: {
              id: "ACEPTO",
              title: "✅ Acepto"
            }
          }
        ]
      );

      return res.sendStatus(200);
    }

    // =========================
    // ACEPTAR TERMINOS
    // =========================

    if (
      usuario.estado === "terminos" &&
      botonId === "ACEPTO"
    ) {

      usuario.estado = "nombre";

      await enviarTexto(
        from,
        `✍️ ¿Cómo te llamas?

Escribe tu nombre y apellido.`
      );

      return res.sendStatus(200);
    }

    // =========================
    // NOMBRE
    // =========================

    if (
      usuario.estado === "nombre" &&
      message.type === "text"
    ) {

      usuario.nombre = texto;

      usuario.estado = "ciudad";

