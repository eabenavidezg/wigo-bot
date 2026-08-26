const express = require("express");
const axios = require("axios");

const app = express();

app.use(express.json());

const VERIFY_TOKEN = "wigo123";
const TOKEN = process.env.WHATSAPP_TOKEN;
const PHONE_NUMBER_ID = process.env.PHONE_NUMBER_ID;

const usuarios = {};

async function enviarTexto(destino, mensaje) {
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

  if (mode && token === VERIFY_TOKEN) {
    return res.status(200).send(challenge);
  }

  res.sendStatus(403);
});

app.post("/webhook", async (req, res) => {
  try {
    const message =
      req.body?.entry?.[0]?.changes?.[0]?.value?.messages?.[0];

    if (!message) {
      return res.sendStatus(200);
    }

    const from = message.from;

    let texto = "";

    if (message.type === "text") {
      texto = message.text.body.trim();
    }

    if (!usuarios[from]) {
      usuarios[from] = {
        estado: "nombre"
      };

      await enviarTexto(
        from,
        `🚖 Bienvenido(a) a WIGO

Moverte vuelve a ser fácil.

Antes de continuar necesitamos conocerte.

👋 ¿Cómo te llamas?

Escribe tu nombre y apellido.`
      );

      return res.sendStatus(200);
    }

    const usuario = usuarios[from];

    if (
      texto.toLowerCase() === "cancelar"
    ) {
      usuario.estado = "registrado";

      await enviarTexto(
        from,
        `✅ Operación cancelada.

Cuando necesites un vehículo nuevamente escribe:

PEDIR SERVICIO`
      );

      return res.sendStatus(200);
    }

    if (usuario.estado === "nombre") {
      usuario.nombre = texto;
      usuario.estado = "terminos";

      await enviarTexto(
        from,
        `🔒 Al continuar aceptas nuestros términos de uso y política de tratamiento de datos.

Escribe:

ACEPTO`
      );

      return res.sendStatus(200);
    }

    if (
      usuario.estado === "terminos" &&
      texto.toLowerCase() === "acepto"
    ) {
      usuario.estado = "registrado";

      await enviarTexto(
        from,
        `🚀 ¡Todo listo para empezar!

${usuario.nombre}, ya puedes solicitar tu primer servicio desde WhatsApp.

Escribe:

PEDIR SERVICIO`
      );

      return res.sendStatus(200);
    }

    if (
      usuario.estado === "registrado" &&
      texto.toLowerCase() === "pedir servicio"
    ) {
      usuario.estado = "ubicacion";

      await enviarTexto(
        from,
        `📍 ¿Dónde te recogemos?

Por favor comparte tu ubicación actual o escribe una dirección.

También puedes escribir:

CANCELAR`
      );

      return res.sendStatus(200);
    }

    if (
      usuario.estado === "ubicacion" &&
      (message.type === "location" || texto.length > 5)
    ) {
      usuario.estado = "registrado";

      await enviarTexto(
        from,
        `✅ Solicitud recibida.

Estamos buscando un conductor disponible cerca de tu ubicación.

Te notificaremos cuando un conductor acepte el servicio.`
      );

      return res.sendStatus(200);
    }

    if (usuario.estado === "registrado") {
      await enviarTexto(
        from,
        `🚖 Bienvenido nuevamente ${usuario.nombre}.

Escribe:

PEDIR SERVICIO`
      );
    }

    res.sendStatus(200);
  } catch (error) {
    console.error(error.response?.data || error.message);
    res.sendStatus(200);
  }
});

const PORT = process.env.PORT || 3000;

app.listen(PORT, () => {
  console.log(`Servidor ejecutándose en puerto ${PORT}`);
});
