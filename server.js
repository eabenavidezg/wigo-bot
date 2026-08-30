const express = require("express");
const axios = require("axios");
const { Pool } = require("pg");
const { v2: cloudinary } = require("cloudinary");

const app = express();
app.use(express.json());

const PORT = process.env.PORT || 3000;
const VERIFY_TOKEN = process.env.VERIFY_TOKEN;
const WHATSAPP_TOKEN = process.env.WHATSAPP_TOKEN;
const PHONE_NUMBER_ID = process.env.PHONE_NUMBER_ID;

const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: { rejectUnauthorized: false }
});

cloudinary.config({
  cloud_name: process.env.CLOUDINARY_CLOUD_NAME,
  api_key: process.env.CLOUDINARY_API_KEY,
  api_secret: process.env.CLOUDINARY_API_SECRET
});

const ACTIVE_STATES = [
  "pendiente",
  "ofertada",
  "asignada",
  "en_camino",
  "esperando_pasajero",
  "en_viaje"
];

async function query(sql, params = []) {
  try {
    return await pool.query(sql, params);
  } catch (e) {
    console.error("POSTGRESQL ERROR", e);
    throw e;
  }
}

async function initDatabase() {
  await query(`
  CREATE TABLE IF NOT EXISTS usuarios(
    id SERIAL PRIMARY KEY,
    telefono VARCHAR(30) UNIQUE NOT NULL,
    nombre VARCHAR(150),
    ciudad VARCHAR(100),
    acepto_datos BOOLEAN DEFAULT FALSE,
    fecha_aceptacion TIMESTAMP,
    estado_registro VARCHAR(50),
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
  )`);

  await query(`
  CREATE TABLE IF NOT EXISTS conductores(
    id SERIAL PRIMARY KEY,
    telefono VARCHAR(30) UNIQUE NOT NULL,
    nombre VARCHAR(150),
    acepto_datos BOOLEAN DEFAULT FALSE,
    fecha_aceptacion TIMESTAMP,
    estado_registro VARCHAR(50),
    estado_validacion VARCHAR(50) DEFAULT 'pendiente_revision',
    disponible BOOLEAN DEFAULT FALSE,
    lat DECIMAL(12,8),
    lng DECIMAL(12,8),
    ultima_actualizacion TIMESTAMP,
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
  )`);

  await query(`
  CREATE TABLE IF NOT EXISTS vehiculos(
    id SERIAL PRIMARY KEY,
    conductor_id INTEGER REFERENCES conductores(id),
    marca VARCHAR(100),
    linea VARCHAR(100),
    modelo VARCHAR(20),
    placa VARCHAR(20) UNIQUE,
    color VARCHAR(50),
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
  )`);

  await query(`
  CREATE TABLE IF NOT EXISTS documentos_conductor(
    id SERIAL PRIMARY KEY,
    conductor_id INTEGER REFERENCES conductores(id),
    tipo_documento VARCHAR(50),
    nombre_archivo VARCHAR(255),
    mime_type VARCHAR(100),
    archivo_url TEXT,
    estado_validacion VARCHAR(30) DEFAULT 'pendiente',
    observaciones TEXT,
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
  )`);

  await query(`
  CREATE TABLE IF NOT EXISTS solicitudes(
    id SERIAL PRIMARY KEY,
    usuario_id INTEGER REFERENCES usuarios(id),
    conductor_id INTEGER,
    origen_lat DECIMAL(12,8),
    origen_lng DECIMAL(12,8),
    destino TEXT,
    estado VARCHAR(50),
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    fecha_asignacion TIMESTAMP,
    fecha_inicio TIMESTAMP,
    fecha_finalizacion TIMESTAMP
  )`);

  await query(`ALTER TABLE usuarios ADD COLUMN IF NOT EXISTS ciudad VARCHAR(100)`);
  await query(`ALTER TABLE usuarios ADD COLUMN IF NOT EXISTS acepto_datos BOOLEAN DEFAULT FALSE`);
  await query(`ALTER TABLE usuarios ADD COLUMN IF NOT EXISTS fecha_aceptacion TIMESTAMP`);
  await query(`ALTER TABLE usuarios ADD COLUMN IF NOT EXISTS estado_registro VARCHAR(50)`);

  await query(`ALTER TABLE conductores ADD COLUMN IF NOT EXISTS estado_validacion VARCHAR(50) DEFAULT 'pendiente_revision'`);
  await query(`ALTER TABLE conductores ADD COLUMN IF NOT EXISTS disponible BOOLEAN DEFAULT FALSE`);
  await query(`ALTER TABLE conductores ADD COLUMN IF NOT EXISTS lat DECIMAL(12,8)`);
  await query(`ALTER TABLE conductores ADD COLUMN IF NOT EXISTS lng DECIMAL(12,8)`);
  await query(`ALTER TABLE conductores ADD COLUMN IF NOT EXISTS ultima_actualizacion TIMESTAMP`);
}

function firstName(v = "") {
  return v.split(" ")[0] || "";
}

async function sendText(to, body) {
  await axios.post(
    `https://graph.facebook.com/v23.0/${PHONE_NUMBER_ID}/messages`,
    {
      messaging_product: "whatsapp",
      to,
      type: "text",
      text: { body }
    },
    {
      headers: {
        Authorization: `Bearer ${WHATSAPP_TOKEN}`
      }
    }
  );
}

async function sendButtons(to, body, buttons) {
  await axios.post(
    `https://graph.facebook.com/v23.0/${PHONE_NUMBER_ID}/messages`,
    {
      messaging_product: "whatsapp",
      to,
      type: "interactive",
      interactive: {
        type: "button",
        body: { text: body },
        action: {
          buttons: buttons.map((b) => ({
            type: "reply",
            reply: {
              id: b.id,
              title: b.title
            }
          }))
        }
      }
    },
    {
      headers: {
        Authorization: `Bearer ${WHATSAPP_TOKEN}`
      }
    }
  );
}
async function aprobarConductor(conductorId) {
  console.log("VERSION_DEBUG_20260829");
  console.log("APROBANDO CONDUCTOR");

  await query(
    `UPDATE conductores
     SET estado_validacion='aprobado'
     WHERE id=$1`,
    [conductorId]
  );

  const conductor = (
  await query(
    `SELECT id,nombre,telefono
     FROM conductores
     WHERE id=$1`,
    [conductorId]
  )
).rows[0];

console.log("CONDUCTOR OBTENIDO:");
console.log(conductor);

if (!conductor) return false;

console.log("APROBANDO CONDUCTOR");
console.log(conductor);

console.log("ENVIANDO WHATSAPP APROBACION");
await sendButtons(
  conductor.telefono,
  `✅ Tu documentación ha sido aprobada.

Bienvenido a WIGO Conductores.

Ya puedes comenzar a recibir servicios.`,
  [
    {
      id: "DISPONIBLE",
      title: "Disponible"
    },
    {
      id: "NO_DISPONIBLE",
      title: "No disponible"
    }
  ]
);

console.log("WHATSAPP APROBACION ENVIADO");

return true;
}

async function rechazarConductor(conductorId, motivo = "") {

  await query(
    `UPDATE conductores
     SET estado_validacion='rechazado'
     WHERE id=$1`,
    [conductorId]
  );

  const conductor = (
    await query(
      `SELECT telefono
       FROM conductores
       WHERE id=$1`,
      [conductorId]
    )
  ).rows[0];

  if (!conductor) return false;

  await sendText(
    conductor.telefono,
    `❌ Tu documentación fue rechazada.

${motivo}

Por favor contacta soporte o realiza nuevamente el proceso de validación.`
  );

  return true;
}
async function requestLocation(to) {
  try {
    await axios.post(
      `https://graph.facebook.com/v23.0/${PHONE_NUMBER_ID}/messages`,
      {
        messaging_product: "whatsapp",
        to,
        type: "interactive",
        interactive: {
          type: "location_request_message",
          body: { text: "📍 Comparte tu ubicación." },
          action: { name: "send_location" }
        }
      },
      {
        headers: {
          Authorization: `Bearer ${WHATSAPP_TOKEN}`
        }
      }
    );
  } catch {
    await sendText(to, "📍 Comparte tu ubicación usando Adjuntar → Ubicación.");
  }
}

async function getProfile(phone) {
  const conductor = await query(
    `SELECT * FROM conductores WHERE telefono=$1`,
    [phone]
  );

  if (conductor.rows.length) {
    return { type: "conductor", data: conductor.rows[0] };
  }

  const usuario = await query(
    `SELECT * FROM usuarios WHERE telefono=$1`,
    [phone]
  );

  if (usuario.rows.length) {
    return { type: "usuario", data: usuario.rows[0] };
  }

  return null;
}

async function showInitialMenu(phone) {
  await sendButtons(
    phone,
    "🚖 Bienvenido a WIGO\n¿Cómo deseas utilizar la plataforma?",
    [
      { id: "REGISTRO_USUARIO", title: "🙋 Viajes" },
      { id: "REGISTRO_CONDUCTOR", title: "🚗 Conducir" }
    ]
  );
}

async function createUser(phone) {
  await query(
    `INSERT INTO usuarios(telefono,estado_registro)
     VALUES($1,'aceptacion_datos')
     ON CONFLICT(telefono) DO NOTHING`,
    [phone]
  );

  await sendButtons(
    phone,
    "🚖 Bienvenido a WIGO\nAntes de continuar necesitamos tu autorización para el tratamiento de tus datos personales.\n¿Deseas continuar?",
    [{ id: "ACEPTAR_DATOS", title: "✅ Aceptar" }]
  );
}

async function createDriver(phone) {
  await query(
    `INSERT INTO conductores(telefono,estado_registro)
     VALUES($1,'aceptacion_datos')
     ON CONFLICT(telefono) DO NOTHING`,
    [phone]
  );

  await sendButtons(
    phone,
    "🚖 Bienvenido a WIGO Conductores\nAntes de continuar necesitamos tu autorización para el tratamiento de datos personales.\n¿Deseas continuar?",
    [{ id: "ACEPTAR_DATOS_CONDUCTOR", title: "✅ Aceptar" }]
  );
}

async function uploadMediaToCloudinary(mediaId, conductorId, typeName) {
  try {
    const media = await axios.get(
      `https://graph.facebook.com/v23.0/${mediaId}`,
      {
        headers: { Authorization: `Bearer ${WHATSAPP_TOKEN}` }
      }
    );

    const file = await axios.get(media.data.url, {
      responseType: "arraybuffer",
      headers: { Authorization: `Bearer ${WHATSAPP_TOKEN}` }
    });

    const ext = media.data.mime_type.includes("pdf")
      ? "pdf"
      : media.data.mime_type.includes("png")
      ? "png"
      : media.data.mime_type.includes("webp")
      ? "webp"
      : "jpg";

    const dataUri = `data:${media.data.mime_type};base64,${Buffer.from(
      file.data
    ).toString("base64")}`;

    const uploaded = await cloudinary.uploader.upload(dataUri, {
      folder: `wigo/conductores/${conductorId}`,
      public_id: `${typeName}.${ext}`
    });

    return {
      url: uploaded.secure_url,
      mime_type: media.data.mime_type,
      nombre: `${typeName}.${ext}`
    };
  } catch (e) {
    console.error("META/CLOUDINARY ERROR", e);
    throw e;
  }
}

function haversine(lat1, lon1, lat2, lon2) {
  const R = 6371;
  const dLat = ((lat2 - lat1) * Math.PI) / 180;
  const dLon = ((lon2 - lon1) * Math.PI) / 180;

  const a =
    Math.sin(dLat / 2) ** 2 +
    Math.cos((lat1 * Math.PI) / 180) *
      Math.cos((lat2 * Math.PI) / 180) *
      Math.sin(dLon / 2) ** 2;

  return R * 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
}

async function offerDrivers(requestId) {
  const req = (
    await query(`SELECT * FROM solicitudes WHERE id=$1`, [requestId])
  ).rows[0];

  const drivers = (
    await query(
      `
      SELECT c.*
      FROM conductores c
      WHERE c.estado_validacion='aprobado'
      AND c.disponible=true
      AND c.ultima_actualizacion >= NOW() - INTERVAL '10 minutes'
      AND NOT EXISTS(
        SELECT 1
        FROM solicitudes s
        WHERE s.conductor_id=c.id
        AND s.estado IN ('asignada','en_camino','esperando_pasajero','en_viaje')
      )
    `
    )
  ).rows;

  if (!drivers.length) {
    const user = (
      await query(`SELECT telefono FROM usuarios WHERE id=$1`, [req.usuario_id])
    ).rows[0];

    if (user) {
      await sendText(
        user.telefono,
        "⚠️ No hay conductores disponibles en este momento.\nPor favor intenta nuevamente en unos minutos."
      );
    }

    return;
  }

  const nearest = drivers
    .map((d) => ({
      ...d,
      distance: haversine(
        Number(req.origen_lat),
        Number(req.origen_lng),
        Number(d.lat),
        Number(d.lng)
      )
    }))
    .sort((a, b) => a.distance - b.distance)
    .slice(0, 5);

  await query(
    `UPDATE solicitudes SET estado='ofertada' WHERE id=$1`,
    [requestId]
  );

  for (const d of nearest) {

  const mapsUrl = `https://www.google.com/maps?q=${req.origen_lat},${req.origen_lng}`;

  await sendButtons(
  d.telefono,
  `🚖 Nueva solicitud disponible

📍 Punto de recogida:
${mapsUrl}

📍 Destino:
${req.destino}

¿Deseas aceptar este servicio?`,
  [
    { id: `ACEPTAR_SERVICIO_${requestId}`, title: "✅ Aceptar" },
    { id: `RECHAZAR_SERVICIO_${requestId}`, title: "❌ Rechazar" }
  ]
  );

  }

}

async function processPassenger(user, phone, message, value) {
  if (value === "ACEPTAR_DATOS") {
    await query(
      `UPDATE usuarios
       SET acepto_datos=true,
           fecha_aceptacion=NOW(),
           estado_registro='esperando_nombre'
       WHERE id=$1`,
      [user.id]
    );

    return sendText(
      phone,
      "🛡️ Por tu seguridad y la de nuestros conductores, indícanos por favor tu nombre y apellido."
    );
  }

  if (value === "SOLICITAR") {
    const active = await query(
      `SELECT id FROM solicitudes
       WHERE usuario_id=$1
       AND estado = ANY($2::text[])`,
      [user.id, ACTIVE_STATES]
    );

    if (active.rows.length) {
      return sendText(
        phone,
        "🚖 Ya tienes una solicitud activa.\nDebes esperar a que finalice antes de crear otra."
      );
    }

    return requestLocation(phone);
  }

  if (user.estado_registro === "esperando_nombre" && message.text) {
    await query(
      `UPDATE usuarios
       SET nombre=$1,estado_registro='esperando_ciudad'
       WHERE id=$2`,
      [message.text.body, user.id]
    );

    return sendText(phone, "📍 ¿En qué ciudad deseas utilizar WIGO?");
  }

  if (user.estado_registro === "esperando_ciudad" && message.text) {
    await query(
      `UPDATE usuarios
       SET ciudad=$1,estado_registro='completo'
       WHERE id=$2`,
      [message.text.body, user.id]
    );

    const u = (
      await query(`SELECT * FROM usuarios WHERE id=$1`, [user.id])
    ).rows[0];

    return sendButtons(
      phone,
      `👋 Hola, ${firstName(u.nombre)}.\n🚖 ¿A dónde vamos hoy?`,
      [{ id: "SOLICITAR", title: "🚖 Viaje" }]
    );
  }

  if (message.location) {
    const active = await query(
      `SELECT * FROM solicitudes
       WHERE usuario_id=$1
       AND estado='esperando_destino'
       ORDER BY id DESC LIMIT 1`,
      [user.id]
    );

    if (active.rows.length) return;

    await query(
      `INSERT INTO solicitudes(
      usuario_id,origen_lat,origen_lng,estado
      )
      VALUES($1,$2,$3,'esperando_destino')`,
      [user.id, message.location.latitude, message.location.longitude]
    );

    return sendText(
      phone,
      "✅ Ubicación recibida correctamente.\n📍 ¿Hacia dónde te diriges?"
    );
  }

  const pending = await query(
    `
    SELECT * FROM solicitudes
    WHERE usuario_id=$1
    AND estado='esperando_destino'
    ORDER BY id DESC LIMIT 1
    `,
    [user.id]
  );

  if (pending.rows.length && message.text) {
    const req = pending.rows[0];

    await query(
      `UPDATE solicitudes
       SET destino=$1,estado='pendiente'
       WHERE id=$2`,
      [message.text.body, req.id]
    );

    await sendText(
      phone,
      `✅ Solicitud registrada con éxito.\n📍 Origen: Ubicación compartida\n📍 Destino: ${message.text.body}\n⏳ Estamos buscando un conductor disponible.\nTe notificaremos cuando tu solicitud sea aceptada.`
    );

        return offerDrivers(req.id);
  }

  if (user.estado_registro === "completo") {
    return sendButtons(
      phone,
      `👋 Hola, ${firstName(user.nombre)}.\n🚖 ¿Qué deseas hacer?`,
      [
        { id: "SOLICITAR", title: "🚖 Viaje" }
      ]
    );
  }
}

async function processDriver(driver, phone, message, value) {
  if (driver.estado_validacion === "pendiente_revision" && driver.estado_registro === "revision") {
    return sendText(
      phone,
      "⏳ Tu documentación está siendo revisada.\nTiempo estimado:\n1 a 12 horas."
    );
  }

  if (driver.estado_validacion === "rechazado") {
    return sendText(
      phone,
      "❌ Tu documentación fue rechazada.\nPor favor contacta soporte."
    );
  }

  if (driver.estado_validacion === "suspendido") {
    return sendText(
      phone,
      "⛔ Tu cuenta se encuentra suspendida.\nContacta soporte."
    );
  }

  if (value === "ACEPTAR_DATOS_CONDUCTOR") {
    await query(
      `UPDATE conductores
       SET acepto_datos=true,
           fecha_aceptacion=NOW(),
           estado_registro='esperando_nombre'
       WHERE id=$1`,
      [driver.id]
    );

    return sendText(
      phone,
      "🛡️ Para iniciar tu proceso de validación indícanos tu nombre y apellido."
    );
  }

  if (driver.estado_registro === "esperando_nombre" && message.text) {
    await query(
      `UPDATE conductores
      SET nombre=$1,
      estado_registro='esperando_cedula'
      WHERE id=$2`,
      [message.text.body, driver.id]
    );

    return sendText(
      phone,
      "📄 Envía tu cédula.\n✅ PDF recomendado\n📸 Fotografías permitidas"
    );
  }

  const acceptedMime = [
    "application/pdf",
    "image/jpeg",
    "image/jpg",
    "image/png",
    "image/webp"
  ];

  if (
    ["document", "image"].includes(message.type) &&
    [
      "esperando_cedula",
      "esperando_licencia",
      "esperando_tarjeta_propiedad",
      "esperando_soat",
      "esperando_tecnomecanica"
    ].includes(driver.estado_registro)
  ) {
    const media = message.document || message.image;
    const mime = media.mime_type || "image/jpeg";

    if (!acceptedMime.includes(mime)) {
      return sendText(phone, "Formato no permitido.");
    }

    const tipo = driver.estado_registro.replace("esperando_", "");

    const file = await uploadMediaToCloudinary(
      media.id,
      driver.id,
      tipo
    );

    await query(
      `
      INSERT INTO documentos_conductor(
      conductor_id,tipo_documento,nombre_archivo,mime_type,archivo_url,estado_validacion
      )
      VALUES($1,$2,$3,$4,$5,'pendiente')
      ON CONFLICT DO NOTHING
      `,
      [driver.id, tipo, file.nombre, file.mime_type, file.url]
    );

    await query(
      `DELETE FROM documentos_conductor
       WHERE conductor_id=$1
       AND tipo_documento=$2
       AND id NOT IN(
        SELECT id FROM documentos_conductor
        WHERE conductor_id=$1
        AND tipo_documento=$2
        ORDER BY id DESC
        LIMIT 1
       )`,
      [driver.id, tipo]
    );

    const next = {
      esperando_cedula: "esperando_licencia",
      esperando_licencia: "esperando_tarjeta_propiedad",
      esperando_tarjeta_propiedad: "esperando_soat",
      esperando_soat: "esperando_tecnomecanica",
      esperando_tecnomecanica: "esperando_placa"
    };

    await query(
      `UPDATE conductores SET estado_registro=$1 WHERE id=$2`,
      [next[driver.estado_registro], driver.id]
    );

    if (driver.estado_registro === "esperando_tecnomecanica") {
      return sendText(phone, "🔖 Indícanos la placa del vehículo.");
    }

    const txt = {
      esperando_cedula: "📄 Envía tu licencia.",
      esperando_licencia: "📄 Envía la tarjeta de propiedad.",
      esperando_tarjeta_propiedad: "📄 Envía el SOAT.",
      esperando_soat: "📄 Envía la tecnomecánica."
    };

    return sendText(phone, txt[driver.estado_registro]);
  }

  if (driver.estado_registro === "esperando_placa" && message.text) {
    await query(
      `INSERT INTO vehiculos(conductor_id,placa)
       VALUES($1,$2)
       ON CONFLICT(placa) DO NOTHING`,
      [driver.id, message.text.body.toUpperCase()]
    );

    await query(
      `UPDATE conductores
      SET estado_registro='revision',
      estado_validacion='pendiente_revision'
      WHERE id=$1`,
      [driver.id]
    );

    return sendText(
      phone,
      "✅ Hemos recibido toda tu documentación.\n⏳ Nuestro equipo realizará la validación correspondiente.\nEl proceso puede tardar entre 1 y 12 horas.\nTe notificaremos cuando tu cuenta sea aprobada."
    );
  }

  if (driver.estado_validacion === "aprobado") {
    if (value === "DISPONIBLE") {
      await query(
        `UPDATE conductores SET disponible=true WHERE id=$1`,
        [driver.id]
      );
      return requestLocation(phone);
    }

    if (value === "NO_DISPONIBLE") {
      await query(
        `UPDATE conductores SET disponible=false WHERE id=$1`,
        [driver.id]
      );
      return sendText(phone, "🔴 Estado actualizado.");
    }

    if (value === "ACTUALIZAR_UBICACION") {
      return requestLocation(phone);
    }

   if (message.location) {

  await query(
    `
    UPDATE conductores
    SET lat=$1,
    lng=$2,
    ultima_actualizacion=NOW()
    WHERE id=$3
    `,
    [
      message.location.latitude,
      message.location.longitude,
      driver.id
    ]
  );

  return sendText(
    phone,
    "✅ Ubicación actualizada correctamente.\n🚖 Ya puedes recibir solicitudes."
  );
}

    if (value.startsWith("ACEPTAR_SERVICIO_")) {
      const requestId = value.split("_").pop();

      const upd = await query(
        `
        UPDATE solicitudes
        SET conductor_id=$1,
            fecha_asignacion=NOW(),
            estado='asignada'
        WHERE id=$2
        AND estado='ofertada'
        `,
        [driver.id, requestId]
      );

      if (!upd.rowCount) {
        return sendText(
          phone,
          "⚠️ Esta solicitud ya fue asignada a otro conductor."
        );
      }

      const req = (
  await query(
    `SELECT * FROM solicitudes WHERE id=$1`,
    [requestId]
  )
).rows[0];

  const mapsUrl = `https://www.google.com/maps?q=${req.origen_lat},${req.origen_lng}`;

  await sendText(
  phone,
  `📍 Navegación al punto de recogida:

${mapsUrl}`
);

 const user = (
  await query(
    `SELECT * FROM usuarios WHERE id=$1`,
    [req.usuario_id]
  )
).rows[0];

  const vehicle = (
    await query(
    `SELECT placa FROM vehiculos WHERE conductor_id=$1 LIMIT 1`,
    [driver.id]
  )
).rows[0];

 await sendText(
  user.telefono,
  `✅ Tu solicitud ha sido aceptada.

👤 Conductor: ${driver.nombre}
🚗 Placa: ${vehicle?.placa || "N/D"}

🚖 El conductor se dirige hacia tu ubicación.`
);

await query(
  `UPDATE solicitudes SET estado='en_camino' WHERE id=$1`,
  [requestId]
); 

      return sendButtons(
        phone,
        "Servicio asignado",
        [
          { id: `LLEGUE_${requestId}`, title: "📍 Llegué" },
          { id: `CANCELAR_${requestId}`, title: "❌ Cancelar" }
        ]
      );
    }

    if (value.startsWith("LLEGUE_")) {
      const requestId = value.split("_").pop();

      await query(
        `UPDATE solicitudes SET estado='esperando_pasajero' WHERE id=$1`,
        [requestId]
      );

      const req = (
        await query(`SELECT * FROM solicitudes WHERE id=$1`, [requestId])
      ).rows[0];

      const user = (
        await query(`SELECT telefono FROM usuarios WHERE id=$1`, [req.usuario_id])
      ).rows[0];

      await sendText(
        user.telefono,
        "📍 Tu conductor ha llegado al punto de recogida."
      );

      return sendButtons(
        phone,
        "Esperando pasajero",
        [{ id: `INICIAR_${requestId}`, title: "▶️ Iniciar" }]
      );
    }

    if (value.startsWith("INICIAR_")) {
      const requestId = value.split("_").pop();

      await query(
        `UPDATE solicitudes
         SET estado='en_viaje',
         fecha_inicio=NOW()
         WHERE id=$1`,
        [requestId]
      );

      const req = (
        await query(`SELECT * FROM solicitudes WHERE id=$1`, [requestId])
      ).rows[0];

      const user = (
        await query(`SELECT telefono FROM usuarios WHERE id=$1`, [req.usuario_id])
      ).rows[0];

      await sendText(user.telefono, "🚖 Tu viaje ha comenzado.");

      return sendButtons(
        phone,
        "Viaje en curso",
        [{ id: `FINALIZAR_${requestId}`, title: "🏁 Finalizar" }]
      );
    }

    if (value.startsWith("FINALIZAR_")) {
      const requestId = value.split("_").pop();

      await query(
        `UPDATE solicitudes
         SET estado='finalizada',
         fecha_finalizacion=NOW()
         WHERE id=$1`,
        [requestId]
      );

      await query(
        `UPDATE conductores SET disponible=false WHERE id=$1`,
        [driver.id]
      );

      const req = (
        await query(`SELECT * FROM solicitudes WHERE id=$1`, [requestId])
      ).rows[0];

      const user = (
        await query(`SELECT telefono FROM usuarios WHERE id=$1`, [req.usuario_id])
      ).rows[0];

      await sendButtons(
        user.telefono,
        "✅ Hemos llegado al destino.\nGracias por utilizar WIGO.",
        [
          { id: "CALIFICAR", title: "⭐ Calificar" },
          { id: "SOLICITAR", title: "🚖 Otro viaje" }
        ]
      );

      return sendButtons(
        phone,
        "✅ Servicio finalizado correctamente.\n¿Deseas continuar recibiendo servicios?",
        [
          { id: "DISPONIBLE", title: "🟢 Disponible" },
          { id: "NO_DISPONIBLE", title: "🔴 No disponible" }
        ]
      );
    }
  }
    console.log("CONDUCTOR APROBADO - MOSTRANDO PANEL");

console.log({
  telefono: driver.telefono,
  estado_registro: driver.estado_registro,
  estado_validacion: driver.estado_validacion
});

return sendButtons(
  phone,
  "🚖 Panel del conductor",
  [
    { id: "DISPONIBLE", title: "Disponible" },
    { id: "NO_DISPONIBLE", title: "No disponible" },
    { id: "ACTUALIZAR_UBICACION", title: "Ubicacion" }
  ]
  );
}

app.get("/admin/aprobar/:id", async (req, res) => {
  try {

    await aprobarConductor(req.params.id);

    res.send(`Conductor ${req.params.id} aprobado correctamente`);

  } catch (error) {

    console.error(error);

    res.status(500).send("Error");

  }

});

app.get("/admin/rechazar/:id", async (req, res) => {

  try {

    await rechazarConductor(req.params.id);

    res.send(`Conductor ${req.params.id} rechazado correctamente`);

  } catch (error) {

    console.error(error);

    res.status(500).send("Error");

  }

});
app.get("/", (req, res) => {
  res.send("🚖 WIGO ONLINE");
});

app.get("/webhook", (req, res) => {
  const mode = req.query["hub.mode"];
  const token = req.query["hub.verify_token"];
  const challenge = req.query["hub.challenge"];

  if (mode === "subscribe" && token === VERIFY_TOKEN) {
    return res.status(200).send(challenge);
  }

  res.sendStatus(403);
});

app.post("/webhook", async (req, res) => {
  try {
    const entry = req.body.entry?.[0];
    const changes = entry?.changes?.[0];
    const value = changes?.value;
    const message = value?.messages?.[0];

    if (!message) return res.sendStatus(200);

    console.log(JSON.stringify(message, null, 2));

    const phone = message.from;

    let action = null;

    if (message.type === "interactive") {
      action = message.interactive?.button_reply?.id || "";
    }

    let profile = await getProfile(phone);

      console.log("PROFILE:");
      console.log(profile);

    if (!profile) {
      if (action === "REGISTRO_USUARIO") {
        await createUser(phone);
      } else if (action === "REGISTRO_CONDUCTOR") {
        await createDriver(phone);
      } else {
        await showInitialMenu(phone);
      }

      return res.sendStatus(200);
    }

    if (profile.type === "usuario") {

  console.log("ENTRANDO A PASAJERO");

  await processPassenger(
    profile.data,
    phone,
    message,
    action || ""
  );
}


    if (profile.type === "conductor") {

  console.log("ENTRANDO A CONDUCTOR");

  await processDriver(
    profile.data,
    phone,
    message,
    action || ""
  );
}

    res.sendStatus(200);
  } catch (e) {
    console.error(e);
    res.sendStatus(500);
  }
});

initDatabase()
  .then(() => {
    app.listen(PORT, () => {
      console.log(`WIGO ${PORT}`);
    });
  })
  .catch(console.error);

