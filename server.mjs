// =============================================================================
// Puente de WhatsApp por QR (Baileys) para los ERP de Neura.
//
// UN SOLO REPO PARA TODOS LOS CLIENTES. Nada acá es específico de una empresa:
// todo lo que cambia entre clientes son variables de entorno. Antes había un
// repo copiado por cliente y un arreglo había que aplicarlo N veces.
//
// Sostiene la sesión de WhatsApp de UN número (como WhatsApp Web) y hace de
// intermediario con el ERP. Un número = un contenedor = un volumen: la sesión
// vive en AUTH_DIR y dos procesos sobre la misma carpeta se desconectan entre
// sí.
//
// ── Lo que el ERP le pide al puente ──────────────────────────────────────────
//   GET  /status          -> { connection, lastQr, meNumber }
//   GET  /contact-name    -> { ok, name }           ?to=<dígitos>
//   POST /send            { to, toJid?, text, replyTo? }
//   POST /send-reaction   { to, toJid?, targetId, emoji }
//   POST /send-media      { to, toJid?, url | base64, tipo?, caption?, filename?, mimetype? }
//
// ── Lo que el puente le manda al ERP ─────────────────────────────────────────
//   POST {ERP}/api/webhooks/baileys/inbound        cada mensaje que entra
//   POST {ERP}/api/webhooks/baileys/inbound/media  los bytes del archivo (multipart)
//   POST {ERP}/api/webhooks/baileys/status         entregado / leído / falló
//
// Todo lleva el header `x-bridge-secret`.
//
// ── Por qué la media la sube el puente ───────────────────────────────────────
// La media de WhatsApp viaja cifrada con la clave de la sesión. El ERP no
// puede ir a buscarla después ni con la URL: solo el puente puede descifrarla.
// Por eso la baja, la sube al ERP y recién ahí se ve en el inbox.
// =============================================================================

import express from "express";
import pino from "pino";
import QRCode from "qrcode";
import fs from "node:fs";
import path from "node:path";
import {
  makeWASocket,
  useMultiFileAuthState,
  DisconnectReason,
  fetchLatestBaileysVersion,
  downloadMediaMessage,
} from "@whiskeysockets/baileys";

// ---------------------------------------------------------------------------
// Config
// ---------------------------------------------------------------------------
const BRIDGE_SECRET = (process.env.BRIDGE_SECRET || "").trim();
const EMPRESA_ID    = (process.env.EMPRESA_ID    || "").trim();
// Se completa después de crear el canal en el ERP: sin esto el ERP no sabe a
// qué canal pertenece el mensaje y lo rechaza.
const CHANNEL_ID    = (process.env.CHANNEL_ID    || "").trim();
const AUTH_DIR      = (process.env.AUTH_DIR      || "./auth").trim();
const PORT          = Number(process.env.PORT || 3000);

/**
 * La base del ERP, por ejemplo https://roldanehijos.neura.com.py
 *
 * `ERP_WEBHOOK_URL` es como se llamaba antes y apuntaba directo al endpoint de
 * mensajes. Se sigue aceptando para no tener que tocar los puentes que ya están
 * andando: si viene con la ruta puesta, se le recorta y queda la base.
 */
const ERP_BASE = (() => {
  const directo = (process.env.ERP_BASE_URL || "").trim().replace(/\/+$/, "");
  if (directo) return directo;
  const viejo = (process.env.ERP_WEBHOOK_URL || "").trim().replace(/\/+$/, "");
  return viejo.replace(/\/api\/webhooks\/baileys(\/.*)?$/, "");
})();

const URL_INBOUND = ERP_BASE ? `${ERP_BASE}/api/webhooks/baileys/inbound` : "";
const URL_MEDIA   = ERP_BASE ? `${ERP_BASE}/api/webhooks/baileys/inbound/media` : "";
const URL_STATUS  = ERP_BASE ? `${ERP_BASE}/api/webhooks/baileys/status` : "";

/**
 * Cómo nombrar el tipo de mensaje al ERP.
 *
 *   "baileys" (por defecto) → `imageMessage`, `conversation`… el nombre crudo.
 *   "simple"               → `image`, `text`… como lo mandaban los puentes viejos.
 *
 * Existe porque los ERP de distinta antigüedad entienden uno u otro, y un ERP
 * que no reconoce el tipo SALTEA el mensaje: el número queda vinculado, el
 * puente reenvía, el ERP contesta 200 y al inbox no entra nada. Si vas a
 * apuntar un cliente viejo a este puente, o le ponés "simple", o le enseñás a
 * su ERP a aceptar los dos (es un switch, diez líneas).
 */
const VOCAB = (process.env.KIND_VOCAB || "baileys").trim().toLowerCase() === "simple"
  ? "simple"
  : "baileys";

if (!BRIDGE_SECRET) {
  console.error("FATAL: BRIDGE_SECRET no configurado.");
  process.exit(1);
}
if (!ERP_BASE) {
  console.error("FATAL: falta ERP_BASE_URL (o ERP_WEBHOOK_URL).");
  process.exit(1);
}
if (!fs.existsSync(AUTH_DIR)) fs.mkdirSync(AUTH_DIR, { recursive: true });

const logger = pino({ level: process.env.LOG_LEVEL || "info" });

// ---------------------------------------------------------------------------
// Estado de la conexión
// ---------------------------------------------------------------------------
/** @type {{ connection: "starting"|"qr"|"open"|"close", lastQr: string|null, meNumber: string|null }} */
const state = { connection: "starting", lastQr: null, meNumber: null };
let sock = null;

/**
 * Nombres que WhatsApp conoce (agenda del teléfono vinculado + pushName).
 * Clave: dígitos del número. Lo expone GET /contact-name para que el ERP
 * muestre el nombre real al abrir una conversación saliente.
 */
const contactNames = new Map();

function rememberContactName(id, ...candidatos) {
  const jid = String(id || "");
  // Solo números reales: un @lid no es un teléfono.
  if (!jid.endsWith("@s.whatsapp.net")) return;
  const digits = jid.split("@")[0].split(":")[0].replace(/\D/g, "");
  if (!digits) return;
  const name = candidatos
    .map((n) => (typeof n === "string" ? n.trim() : ""))
    .find((n) => n && /\p{L}/u.test(n) && n.replace(/\D/g, "") !== digits);
  if (name) contactNames.set(digits, name);
}

// ---------------------------------------------------------------------------
// Socket
// ---------------------------------------------------------------------------
async function startSocket() {
  const { state: authState, saveCreds } = await useMultiFileAuthState(AUTH_DIR);
  const { version } = await fetchLatestBaileysVersion();
  logger.info({ version }, "arrancando socket baileys");

  sock = makeWASocket({
    version,
    auth: authState,
    logger,
    browser: ["Neura ERP", "Chrome", "1.0"],
    markOnlineOnConnect: false,
  });

  sock.ev.on("creds.update", saveCreds);

  sock.ev.on("connection.update", async (update) => {
    const { connection, lastDisconnect, qr } = update;
    if (qr) {
      state.connection = "qr";
      state.lastQr = qr;
      logger.info("nuevo QR emitido");
    }
    if (connection === "open") {
      state.connection = "open";
      state.lastQr = null;
      state.meNumber = (sock?.user?.id || "").split(":")[0].split("@")[0] || null;
      logger.info({ me: state.meNumber }, "conectado");
    }
    if (connection === "close") {
      state.connection = "close";
      const code = lastDisconnect?.error?.output?.statusCode;
      const shouldReconnect = code !== DisconnectReason.loggedOut;
      logger.warn({ code, shouldReconnect }, "conexion cerrada");
      if (shouldReconnect) {
        setTimeout(() => startSocket().catch((e) => logger.error(e, "reintento fallo")), 2000);
      } else {
        // Sesión cerrada desde el celular: hay que borrar las credenciales para
        // que se genere un QR nuevo. Se vacía el CONTENIDO de AUTH_DIR y no el
        // directorio: suele ser un punto de montaje y borrarlo falla, dejando
        // credenciales viejas que loopean en 401.
        try {
          if (fs.existsSync(AUTH_DIR)) {
            for (const f of fs.readdirSync(AUTH_DIR)) {
              fs.rmSync(path.join(AUTH_DIR, f), { recursive: true, force: true });
            }
          } else {
            fs.mkdirSync(AUTH_DIR, { recursive: true });
          }
        } catch (e) {
          logger.warn(e, "no se pudo limpiar AUTH_DIR");
        }
        state.meNumber = null;
        setTimeout(() => startSocket().catch((e) => logger.error(e, "reinicio fallo")), 2000);
      }
    }
  });

  // Agenda del teléfono (sincronización inicial) + altas y cambios en vivo.
  sock.ev.on("messaging-history.set", (h) => {
    for (const c of h?.contacts ?? []) rememberContactName(c.id, c.name, c.verifiedName, c.notify);
  });
  sock.ev.on("contacts.upsert", (cs) => {
    for (const c of cs ?? []) rememberContactName(c.id, c.name, c.verifiedName, c.notify);
  });
  sock.ev.on("contacts.update", (cs) => {
    for (const c of cs ?? []) rememberContactName(c.id, c.name, c.verifiedName, c.notify);
  });

  sock.ev.on("messages.upsert", async ({ messages, type }) => {
    if (type !== "notify") return;
    for (const m of messages) {
      try {
        await handleInbound(m);
      } catch (e) {
        logger.error(e, "handleInbound");
      }
    }
  });

  // Tildes: sin esto los mensajes mandados desde el ERP se quedan sin marcas y
  // el que atiende cree que no llegaron.
  sock.ev.on("messages.update", async (updates) => {
    for (const u of updates ?? []) {
      try {
        await reportarEstado(u);
      } catch (e) {
        logger.warn(e, "reportarEstado");
      }
    }
  });
}

// ---------------------------------------------------------------------------
// Entrada: mensaje → ERP
// ---------------------------------------------------------------------------

/** Qué clase de mensaje es, en los dos vocabularios. */
function clasificar(msg) {
  const tabla = [
    ["conversation",            "text",     false],
    ["extendedTextMessage",     "text",     false],
    ["imageMessage",            "image",    true],
    ["videoMessage",            "video",    true],
    ["audioMessage",            "audio",    true],
    ["documentMessage",         "document", true],
    ["stickerMessage",          "sticker",  true],
    ["locationMessage",         "location", false],
    ["contactMessage",          "contact",  false],
    ["contactsArrayMessage",    "contact",  false],
    ["reactionMessage",         "reaction", false],
  ];
  for (const [clave, simple, media] of tabla) {
    if (msg[clave]) return { baileys: clave, simple, hasMedia: media };
  }
  // documentWithCaptionMessage envuelve un documentMessage adentro.
  if (msg.documentWithCaptionMessage?.message?.documentMessage) {
    return { baileys: "documentMessage", simple: "document", hasMedia: true };
  }
  return { baileys: "unknown", simple: "unknown", hasMedia: false };
}

/** El texto visible del mensaje, si tiene. */
function textoDe(msg) {
  return (
    msg.conversation ||
    msg.extendedTextMessage?.text ||
    msg.imageMessage?.caption ||
    msg.videoMessage?.caption ||
    msg.documentMessage?.caption ||
    msg.documentWithCaptionMessage?.message?.documentMessage?.caption ||
    ""
  );
}

/** El mensaje al que este responde, para que el inbox pueda mostrar el hilo. */
function citadoDe(msg) {
  const ctx =
    msg.extendedTextMessage?.contextInfo ||
    msg.imageMessage?.contextInfo ||
    msg.videoMessage?.contextInfo ||
    msg.documentMessage?.contextInfo ||
    msg.audioMessage?.contextInfo ||
    null;
  return ctx?.stanzaId || null;
}

/** Tarjetas de contacto compartidas, con la forma que el inbox ya sabe dibujar. */
function contactosDe(msg) {
  const uno = msg.contactMessage;
  const varios = msg.contactsArrayMessage?.contacts;
  const mapear = (c) => ({ name: { formatted_name: c?.displayName || "" }, vcard: c?.vcard || "" });
  if (Array.isArray(varios) && varios.length > 0) return varios.map(mapear);
  if (uno) return [mapear(uno)];
  return null;
}

async function handleInbound(m) {
  // fromMe: lo mandó el mismo número desde el celular, no desde el ERP. Se
  // reenvía igual para que aparezca en el inbox; el ERP deduplica por el id del
  // mensaje, así que lo que salió del ERP no se duplica.
  const fromMe = m.key?.fromMe === true;
  const remoteJid = String(m.key?.remoteJid || "");
  // Solo conversaciones 1 a 1. Grupos (@g.us) y estados se ignoran.
  const isDirect = remoteJid.endsWith("@s.whatsapp.net") || remoteJid.endsWith("@lid");
  if (!isDirect) return;

  // Con un @lid, el número real viene en `remoteJidAlt`; si no está, se le
  // pregunta al mapeo que Baileys mantiene.
  let pnJid = remoteJid;
  if (remoteJid.endsWith("@lid")) {
    const alt = String(m.key?.remoteJidAlt || "");
    if (alt.endsWith("@s.whatsapp.net")) {
      pnJid = alt;
    } else {
      try {
        const mapped = await sock?.signalRepository?.lidMapping?.getPNForLID?.(remoteJid);
        if (mapped) pnJid = String(mapped);
      } catch (e) {
        logger.warn(e, "no se pudo resolver LID->PN");
      }
    }
  }

  // El identificador con el que el ERP guarda el contacto es el del mensaje:
  // cambiarlo por el teléfono real duplicaría conversaciones. El teléfono va
  // aparte, en fromPhone, solo para mostrar.
  const fromDigits = remoteJid.split("@")[0].split(":")[0].replace(/\D/g, "");
  const fromPhone = pnJid.split("@")[0].split(":")[0].replace(/\D/g, "");
  if (!fromDigits) return;

  if (!fromMe && m.pushName) rememberContactName(pnJid, m.pushName);

  const msg = m.message || {};
  const clase = clasificar(msg);
  const waMessageId = m.key?.id || null;
  if (!waMessageId) return;

  const payload = {
    channelId: CHANNEL_ID || null,
    empresaId: EMPRESA_ID || null,
    fromDigits,
    fromPhone: fromPhone && fromPhone !== fromDigits ? fromPhone : undefined,
    fromJid: remoteJid,
    fromMe,
    waMessageId,
    messageKind: VOCAB === "simple" ? clase.simple : clase.baileys,
    text: textoDe(msg) || null,
    pushName: fromMe ? null : m.pushName || null,
    hasMedia: clase.hasMedia,
    quotedWaMessageId: citadoDe(msg) || undefined,
    contacts: contactosDe(msg) || undefined,
    timestamp: new Date((Number(m.messageTimestamp) || Math.floor(Date.now() / 1000)) * 1000).toISOString(),
  };

  if (!payload.channelId) logger.warn("CHANNEL_ID sin configurar: el ERP no va a poder rutear");

  let aceptado = false;
  try {
    const res = await fetch(URL_INBOUND, {
      method: "POST",
      headers: { "content-type": "application/json", "x-bridge-secret": BRIDGE_SECRET },
      body: JSON.stringify(payload),
    });
    aceptado = res.ok;
    if (!res.ok) {
      logger.warn({ status: res.status, body: await res.text().catch(() => "") }, "el ERP rechazó el mensaje");
    } else {
      logger.info({ fromDigits, kind: payload.messageKind }, "mensaje reenviado al ERP");
    }
  } catch (e) {
    logger.error(e, "no se pudo avisar al ERP");
    return;
  }

  // Los bytes van después y solo si el mensaje quedó guardado: subirlos para
  // una fila que no existe deja el archivo colgado.
  if (aceptado && clase.hasMedia) {
    subirMedia(m, waMessageId, clase.simple).catch((e) => logger.warn(e, "subirMedia"));
  }
}

/** Baja el archivo de WhatsApp y lo sube al ERP. */
async function subirMedia(m, waMessageId, tipo) {
  let buffer;
  try {
    buffer = await downloadMediaMessage(m, "buffer", {}, { logger, reuploadRequest: sock.updateMediaMessage });
  } catch (e) {
    logger.warn(e, "no se pudo bajar la media de WhatsApp");
    return;
  }
  if (!buffer?.length) return;

  const msg = m.message || {};
  const doc = msg.documentMessage || msg.documentWithCaptionMessage?.message?.documentMessage;
  const mimetype =
    msg.imageMessage?.mimetype ||
    msg.videoMessage?.mimetype ||
    msg.audioMessage?.mimetype ||
    msg.stickerMessage?.mimetype ||
    doc?.mimetype ||
    "application/octet-stream";
  const filename = doc?.fileName || `${waMessageId}`;

  const form = new FormData();
  form.append("channelId", CHANNEL_ID);
  form.append("empresaId", EMPRESA_ID);
  form.append("waMessageId", waMessageId);
  form.append("tipo", tipo);
  form.append("file", new Blob([buffer], { type: mimetype }), filename);

  const res = await fetch(URL_MEDIA, {
    method: "POST",
    headers: { "x-bridge-secret": BRIDGE_SECRET },
    body: form,
  });
  if (!res.ok) {
    logger.warn({ status: res.status, body: await res.text().catch(() => "") }, "el ERP rechazó el archivo");
  } else {
    logger.info({ waMessageId, tipo, bytes: buffer.length }, "archivo subido al ERP");
  }
}

/** Avisa al ERP que un mensaje saliente se entregó o se leyó. */
async function reportarEstado(u) {
  const waMessageId = u?.key?.id;
  if (!waMessageId || u?.key?.fromMe !== true) return;
  // 2 = entregado al servidor, 3 = entregado al celular, 4 = leído, 0/1 = en curso.
  const n = Number(u?.update?.status);
  const status = n >= 4 ? "read" : n === 3 ? "delivered" : n === 2 ? "sent" : null;
  if (!status) return;

  const res = await fetch(URL_STATUS, {
    method: "POST",
    headers: { "content-type": "application/json", "x-bridge-secret": BRIDGE_SECRET },
    body: JSON.stringify({
      empresaId: EMPRESA_ID,
      waMessageId,
      status,
      timestamp: new Date().toISOString(),
    }),
  });
  if (!res.ok) logger.warn({ status: res.status, waMessageId }, "el ERP rechazó el estado");
}

// ---------------------------------------------------------------------------
// HTTP
// ---------------------------------------------------------------------------
const app = express();
// 15mb alcanza para una factura en PDF mandada como base64. El límite real de
// WhatsApp es mayor, pero por acá no pasa nada tan grande en el día a día.
app.use(express.json({ limit: "15mb" }));

function requireSecret(req, res, next) {
  if ((req.header("x-bridge-secret") || "") !== BRIDGE_SECRET) {
    return res.status(401).json({ ok: false, error: "bad secret" });
  }
  next();
}

/**
 * A qué JID mandar.
 *
 * El ERP manda `toJid` con el sufijo real del contacto (`@lid` o
 * `@s.whatsapp.net`) y `to` como respaldo. Se respeta el que viene: forzar
 * siempre `@s.whatsapp.net` sobre un contacto @lid manda el mensaje a un
 * número que no existe y no llega nunca.
 */
function destino(body) {
  const jid = String(body?.toJid || "").trim();
  if (jid.includes("@")) return jid;
  const to = String(body?.to || "").replace(/\D/g, "");
  if (!to) return "";
  // Más de 13 dígitos no es un teléfono, es un identificador interno.
  return to.length > 13 ? `${to}@lid` : `${to}@s.whatsapp.net`;
}

function exigirConexion(res) {
  if (state.connection !== "open" || !sock) {
    res.status(503).json({ ok: false, error: "socket no conectado" });
    return false;
  }
  return true;
}

app.get("/status", requireSecret, (_req, res) => {
  res.json({
    connection: state.connection,
    lastQr: state.lastQr,
    meNumber: state.meNumber,
  });
});

// El nombre que WhatsApp conoce de un número. null si no lo conoce (número no
// agendado que todavía no escribió).
app.get("/contact-name", requireSecret, (req, res) => {
  const to = String(req.query?.to || "").replace(/\D/g, "");
  res.json({ ok: true, name: (to && contactNames.get(to)) || null });
});

app.post("/send", requireSecret, async (req, res) => {
  const jid = destino(req.body);
  const text = String(req.body?.text || "");
  const replyTo = String(req.body?.replyTo || "").trim();
  if (!jid || !text) return res.status(400).json({ ok: false, error: "to y text requeridos" });
  if (!exigirConexion(res)) return;
  try {
    // Contestar citando: sin esto, una respuesta sale como mensaje suelto y el
    // cliente no ve a qué se le contestó.
    const opciones = replyTo
      ? { quoted: { key: { remoteJid: jid, id: replyTo, fromMe: false }, message: {} } }
      : undefined;
    const sent = await sock.sendMessage(jid, { text }, opciones);
    res.json({ ok: true, id: sent?.key?.id || null });
  } catch (e) {
    res.status(500).json({ ok: false, error: e?.message || String(e) });
  }
});

app.post("/send-reaction", requireSecret, async (req, res) => {
  const jid = destino(req.body);
  const targetId = String(req.body?.targetId || "").trim();
  // Un emoji vacío quita la reacción, igual que en WhatsApp.
  const emoji = req.body?.emoji == null ? "" : String(req.body.emoji);
  if (!jid || !targetId) return res.status(400).json({ ok: false, error: "to y targetId requeridos" });
  if (!exigirConexion(res)) return;
  try {
    const sent = await sock.sendMessage(jid, {
      react: { text: emoji, key: { remoteJid: jid, id: targetId, fromMe: false } },
    });
    res.json({ ok: true, id: sent?.key?.id || null });
  } catch (e) {
    res.status(500).json({ ok: false, error: e?.message || String(e) });
  }
});

/**
 * Manda un archivo.
 *
 * Acepta `url` (el ERP ya lo tiene subido en su storage y pasa el link, que es
 * lo barato: no viajan megabytes por el cuerpo del pedido) o `base64` para los
 * ERP viejos que mandaban el binario.
 */
app.post("/send-media", requireSecret, async (req, res) => {
  const jid = destino(req.body);
  const url = String(req.body?.url || "").trim();
  const b64 = String(req.body?.base64 || "");
  const caption = req.body?.caption == null ? "" : String(req.body.caption);
  const filename = String(req.body?.filename || "").trim();
  let mimetype = String(req.body?.mimetype || "").trim();
  const tipo = String(req.body?.tipo || "").trim().toLowerCase();
  if (!jid) return res.status(400).json({ ok: false, error: "to requerido" });
  if (!url && !b64) return res.status(400).json({ ok: false, error: "url o base64 requerido" });
  if (!exigirConexion(res)) return;

  let buffer;
  try {
    if (url) {
      const r = await fetch(url);
      if (!r.ok) throw new Error(`no se pudo bajar el archivo (${r.status})`);
      if (!mimetype) mimetype = r.headers.get("content-type") || "";
      buffer = Buffer.from(await r.arrayBuffer());
    } else {
      buffer = Buffer.from(b64, "base64");
    }
    if (!buffer?.length) throw new Error("archivo vacío");
  } catch (e) {
    return res.status(400).json({ ok: false, error: e?.message || "archivo inválido" });
  }
  if (!mimetype) mimetype = "application/octet-stream";

  // El tipo que pide el ERP manda; si no vino, se deduce del mimetype.
  const clase =
    tipo ||
    (mimetype.startsWith("image/")
      ? "image"
      : mimetype.startsWith("video/")
        ? "video"
        : mimetype.startsWith("audio/")
          ? "audio"
          : "document");

  try {
    let contenido;
    if (clase === "image") contenido = { image: buffer, mimetype, caption };
    else if (clase === "video") contenido = { video: buffer, mimetype, caption };
    // ptt false: va como archivo de audio y no como nota de voz, que no es lo
    // mismo para el que lo recibe.
    else if (clase === "audio") contenido = { audio: buffer, mimetype, ptt: false };
    else if (clase === "sticker") contenido = { sticker: buffer };
    else contenido = { document: buffer, mimetype, fileName: filename || "documento", caption };

    const sent = await sock.sendMessage(jid, contenido);
    res.json({ ok: true, id: sent?.key?.id || null });
  } catch (e) {
    res.status(500).json({ ok: false, error: e?.message || String(e) });
  }
});

// Pantalla mínima para escanear el QR desde el celular, sin pasar por el ERP.
app.get("/", async (_req, res) => {
  let body = "";
  if (state.connection === "open") {
    body = `<h1 style="color:#2a7">Conectado</h1><p>Número: ${state.meNumber || "-"}</p>`;
  } else if (state.connection === "qr" && state.lastQr) {
    const dataUrl = await QRCode.toDataURL(state.lastQr);
    body = `<h1>Escaneá con WhatsApp</h1><img src="${dataUrl}" style="max-width:320px" />
      <p>WhatsApp → Dispositivos vinculados → Vincular un dispositivo</p>`;
  } else {
    body = `<h1>Estado: ${state.connection}</h1><p>Recargá en unos segundos…</p>`;
  }
  res.send(`<!doctype html><meta charset="utf-8"><title>Puente WhatsApp</title>
    <body style="font-family:system-ui;max-width:520px;margin:40px auto;padding:0 16px">${body}
    <script>setTimeout(()=>location.reload(), 4000)</script></body>`);
});

app.get("/qr.png", async (_req, res) => {
  if (state.connection !== "qr" || !state.lastQr) return res.status(404).send("sin QR");
  const buf = await QRCode.toBuffer(state.lastQr);
  res.setHeader("content-type", "image/png");
  res.send(buf);
});

app.get("/health", (_req, res) => res.json({ ok: true, connection: state.connection }));

app.listen(PORT, () =>
  logger.info({ port: PORT, authDir: path.resolve(AUTH_DIR), erp: ERP_BASE, vocab: VOCAB }, "puente escuchando")
);
startSocket().catch((e) => {
  logger.error(e, "startSocket falló");
  process.exit(1);
});
