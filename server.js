const express = require("express");
const axios = require("axios");

const app = express();

app.use(express.json());

const VERIFY_TOKEN = "wigo123";
const TOKEN = process.env.WHATSAPP_TOKEN;
const PHONE_NUMBER_ID = process.env.PHONE_NUMBER_ID;

const usuarios = {};

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

    // NUEVO USUARIO

    if (usuario.estado === "nuevo") {

      usuario.estado = "esperando_contacto";

      await enviarBotones(
        from,
        "Para brindarte una mejor atención, compártenos tu número de contacto para identificarte, conservar tu historial y gestionar tus solicitudes.",
        [
          {
            type: "reply",
            reply: {
              id: "CONTACTO",
              title: "👤 Compartir contacto"
            }
          }
        ]
      );

      return res.sendStatus(200);
    }

    // CONTACTO

    if (
      usuario.estado === "esperando_contacto" &&
      (
        botonId === "CONTACTO" ||
        message.type === "contacts"
      )
    ) {

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

    // REGISTRARME

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

    // ACEPTA TERMINOS

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

    // NOMBRE

    if (
      usuario.estado === "nombre" &&
      message.type === "text"
    ) {

      usuario.nombre = texto;

      usuario.estado = "ciudad";

      await enviarBotones(
        from,
        "📍 ¿En qué ciudad te encuentras?",
        [
          {
            type: "reply",
            reply: {
              id: "FUSAGASUGA",
              title: "Fusagasugá"
            }
          }
        ]
      );

      return res.sendStatus(200);
    }

    // CIUDAD

    if (
      usuario.estado === "ciudad" &&
      botonId === "FUSAGASUGA"
    ) {

      usuario.ciudad = "Fusagasugá";

      usuario.estado = "registrado";

      await enviarBotones(
        from,
        `🚀 ¡Todo listo para empezar!

${usuario.nombre}, ya puedes solicitar tu primer viaje o servicio desde WhatsApp.`,
        [
          {
            type: "reply",
            reply: {
              id: "PEDIR_SERVICIO",
              title: "🚖 Pedir servicio"
            }
          }
        ]
      );

      return res.sendStatus(200);
    }

    // PEDIR SERVICIO

    if (
      usuario.estado === "registrado" &&
      botonId === "PEDIR_SERVICIO"
    ) {

      usuario.estado = "ubicacion";

      await solicitarUbicacion(from);

      return res.sendStatus(200);
    }

    // UBICACION

    if (
      usuario.estado === "ubicacion" &&
      message.type === "location"
    ) {

      usuario.latitud = message.location.latitude;
      usuario.longitud = message.location.longitude;

      usuario.estado = "destino";

      await enviarTexto(
        from,
        "📍 ¿Cuál es tu destino?"
      );

      return res.sendStatus(200);
    }

    // DESTINO

    if (
      usuario.estado === "destino" &&
      message.type === "text"
    ) {

      usuario.destino = texto;

      usuario.estado = "registrado";

      await enviarTexto(
        from,
        `✅ Solicitud registrada.

Pasajero: ${usuario.nombre}

Ciudad: ${usuario.ciudad}

Destino: ${usuario.destino}

Estamos buscando un conductor disponible.`
      );

      return res.sendStatus(200);
    }

    return res.sendStatus(200);

  } catch (error) {

    console.error(
      error.response?.data || error.message
    );

    return res.sendStatus(200);
  }
});

const PORT = process.env.PORT || 3000;

app.listen(PORT, () => {
  console.log(`Servidor ejecutándose en puerto ${PORT}`);
});
