// =============================================================================
// Puente de WhatsApp por QR (Baileys) para los ERP de Neura.
//
// UN CONTENEDOR, VARIOS NÚMEROS. Lo que no se puede compartir entre dos
// números es la CARPETA de la sesión, no el proceso. Así que acá vive una
// carpeta por número dentro de AUTH_DIR y una ruta por número:
//
//     /s/<CHANNEL_ID>/status      /s/<CHANNEL_ID>/send      ...
//
// El ERP no necesita saber nada de esto: guarda la URL del puente por canal,
// y a esa URL le pega `/status`, `/send`, etc. Poniéndole
// `https://wa.midominio.com/s/<CHANNEL_ID>` sale solo.
//
// Y la sesión se crea sola la primera vez que el ERP pregunta por ese canal:
// agregar un número más es crear el canal en el ERP y escanear. Sin deploy.
//
// UN SOLO REPO PARA TODOS LOS CLIENTES: nada acá es de una empresa en
// particular, todo lo que cambia son variables de entorno.
//
// ── Lo que el ERP le pide al puente ──────────────────────────────────────────
//   GET  /s/<id>/status          -> { connection, lastQr, meNumber }
//   GET  /s/<id>/contact-name    -> { ok, name }           ?to=<dígitos>
//   POST /s/<id>/send            { to, toJid?, text, replyTo? }
//   POST /s/<id>/send-reaction   { to, toJid?, targetId, emoji }
//   POST /s/<id>/send-media      { to, toJid?, url | base64, tipo?, caption?, ... }
//
// Las mismas rutas sin el prefijo `/s/<id>` siguen funcionando contra el canal
// de CHANNEL_ID, para no romper los puentes que ya están configurados así.
//
// ── Lo que el puente le manda al ERP ─────────────────────────────────────────
//   POST {ERP}/api/webhooks/baileys/inbound        cada mensaje que entra
//   POST {ERP}/api/webhooks/baileys/inbound/media  los bytes del archivo
//   POST {ERP}/api/webhooks/baileys/status         entregado / leído / falló
//
// Todo lleva el header `x-bridge-secret`.
//
// ── Por qué la media la sube el puente ───────────────────────────────────────
// La media de WhatsApp viaja cifrada con la clave de la sesión. El ERP no
// puede ir a buscarla ni teniendo la URL: solo el puente puede descifrarla.
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
/** Canal por defecto, para las rutas sin `/s/<id>`. Opcional. */
const CHANNEL_ID    = (process.env.CHANNEL_ID    || "").trim();
const AUTH_DIR      = (process.env.AUTH_DIR      || "./auth").trim();
const PORT          = Number(process.env.PORT || 3000);
/** Tope de sesiones vivas. Cada una pesa, y un tope evita que un error las multiplique. */
const MAX_SESIONES  = Math.max(1, Number(process.env.MAX_SESIONES || 10));

/**
 * La base del ERP, por ejemplo https://roldanehijos.neura.com.py
 *
 * `ERP_WEBHOOK_URL` es como se llamaba antes y apuntaba directo al endpoint de
 * mensajes. Se sigue aceptando: si viene con la ruta puesta, se le recorta.
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
 *   "simple"               → `image`, `text`… como los puentes viejos.
 *
 * Un ERP que no reconoce el tipo SALTEA el mensaje: el número queda vinculado,
 * el puente reenvía, el ERP contesta 200 y al inbox no entra nada. Antes de
 * apuntar un cliente viejo acá, o le ponés "simple", o le enseñás a su ERP a
 * aceptar los dos.
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
// Sesiones
// ---------------------------------------------------------------------------

/**
 * Un id de canal es un UUID y nada más.
 *
 * Esto no es decoración: el id arma el nombre de una carpeta en disco. Sin
 * esta validación, un `..` en la URL escribiría fuera de AUTH_DIR.
 */
const RE_CANAL = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** @type {Map<string, {channelId:string, state:{connection:string,lastQr:string|null,meNumber:string|null}, sock:any, contactNames:Map<string,string>, arrancando:boolean}>} */
const sesiones = new Map();

function carpetaDe(channelId) {
  return path.join(AUTH_DIR, channelId);
}

function nuevaSesion(channelId) {
  return {
    channelId,
    state: { connection: "starting", lastQr: null, meNumber: null },
    sock: null,
    contactNames: new Map(),
    arrancando: false,
  };
}

/**
 * Devuelve la sesión de ese canal, arrancándola si hace falta.
 *
 * Arrancar sola es lo que hace que agregar un número no necesite un deploy:
 * el ERP pregunta por su canal y la sesión nace ahí, pidiendo su QR.
 */
function obtenerSesion(channelId) {
  let s = sesiones.get(channelId);
  if (s) return s;
  if (sesiones.size >= MAX_SESIONES) {
    throw new Error(`Se alcanzó el tope de ${MAX_SESIONES} números en este puente.`);
  }
  s = nuevaSesion(channelId);
  sesiones.set(channelId, s);
  arrancar(s).catch((e) => logger.error({ channelId, err: String(e) }, "no se pudo arrancar la sesión"));
  return s;
}

function rememberContactName(ses, id, ...candidatos) {
  const jid = String(id || "");
  // Solo números reales: un @lid no es un teléfono.
  if (!jid.endsWith("@s.whatsapp.net")) return;
  const digits = jid.split("@")[0].split(":")[0].replace(/\D/g, "");
  if (!digits) return;
  const name = candidatos
    .map((n) => (typeof n === "string" ? n.trim() : ""))
    .find((n) => n && /\p{L}/u.test(n) && n.replace(/\D/g, "") !== digits);
  if (name) ses.contactNames.set(digits, name);
}

async function arrancar(ses) {
  if (ses.arrancando) return;
  ses.arrancando = true;
  const dir = carpetaDe(ses.channelId);
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });

  try {
    const { state: authState, saveCreds } = await useMultiFileAuthState(dir);
    const { version } = await fetchLatestBaileysVersion();
    logger.info({ channelId: ses.channelId, version }, "arrancando sesión");

    const sock = makeWASocket({
      version,
      auth: authState,
      logger,
      browser: ["Neura ERP", "Chrome", "1.0"],
      markOnlineOnConnect: false,
    });
    ses.sock = sock;

    sock.ev.on("creds.update", saveCreds);

    sock.ev.on("connection.update", async (update) => {
      const { connection, lastDisconnect, qr } = update;
      if (qr) {
        ses.state.connection = "qr";
        ses.state.lastQr = qr;
        logger.info({ channelId: ses.channelId }, "nuevo QR emitido");
      }
      if (connection === "open") {
        ses.state.connection = "open";
        ses.state.lastQr = null;
        ses.state.meNumber = (sock?.user?.id || "").split(":")[0].split("@")[0] || null;
        logger.info({ channelId: ses.channelId, me: ses.state.meNumber }, "conectado");
      }
      if (connection === "close") {
        ses.state.connection = "close";
        const code = lastDisconnect?.error?.output?.statusCode;
        const reconectar = code !== DisconnectReason.loggedOut;
        logger.warn({ channelId: ses.channelId, code, reconectar }, "conexión cerrada");
        ses.arrancando = false;
        if (!reconectar) {
          // Sesión cerrada desde el celular: hay que borrar las credenciales
          // para que se genere un QR nuevo. Se vacía el CONTENIDO de la
          // carpeta y no la carpeta: puede ser un punto de montaje, y
          // borrarla falla dejando credenciales viejas que loopean en 401.
          try {
            for (const f of fs.readdirSync(dir)) {
              fs.rmSync(path.join(dir, f), { recursive: true, force: true });
            }
          } catch (e) {
            logger.warn({ channelId: ses.channelId, err: String(e) }, "no se pudo limpiar la carpeta");
          }
          ses.state.meNumber = null;
        }
        setTimeout(() => arrancar(ses).catch((e) => logger.error({ err: String(e) }, "reintento falló")), 2000);
      }
    });

    // Agenda del teléfono + altas y cambios en vivo.
    sock.ev.on("messaging-history.set", (h) => {
      for (const c of h?.contacts ?? []) rememberContactName(ses, c.id, c.name, c.verifiedName, c.notify);
    });
    sock.ev.on("contacts.upsert", (cs) => {
      for (const c of cs ?? []) rememberContactName(ses, c.id, c.name, c.verifiedName, c.notify);
    });
    sock.ev.on("contacts.update", (cs) => {
      for (const c of cs ?? []) rememberContactName(ses, c.id, c.name, c.verifiedName, c.notify);
    });

    sock.ev.on("messages.upsert", async ({ messages, type }) => {
      if (type !== "notify") return;
      for (const m of messages) {
        try {
          await handleInbound(ses, m);
        } catch (e) {
          logger.error({ channelId: ses.channelId, err: String(e) }, "handleInbound");
        }
      }
    });

    // Tildes: sin esto el que atiende cree que el mensaje no llegó.
    sock.ev.on("messages.update", async (updates) => {
      for (const u of updates ?? []) {
        try {
          await reportarEstado(u);
        } catch (e) {
          logger.warn({ err: String(e) }, "reportarEstado");
        }
      }
    });
  } catch (e) {
    ses.arrancando = false;
    throw e;
  }
}

// ---------------------------------------------------------------------------
// Entrada: mensaje → ERP
// ---------------------------------------------------------------------------

/** Qué clase de mensaje es, en los dos vocabularios. */
function clasificar(msg) {
  const tabla = [
    ["conversation",         "text",     false],
    ["extendedTextMessage",  "text",     false],
    ["imageMessage",         "image",    true],
    ["videoMessage",         "video",    true],
    ["audioMessage",         "audio",    true],
    ["documentMessage",      "document", true],
    ["stickerMessage",       "sticker",  true],
    ["locationMessage",      "location", false],
    ["contactMessage",       "contact",  false],
    ["contactsArrayMessage", "contact",  false],
    ["reactionMessage",      "reaction", false],
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

/** El mensaje al que este responde, para que el inbox muestre el hilo. */
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

/** Tarjetas de contacto compartidas, con la forma que el inbox sabe dibujar. */
function contactosDe(msg) {
  const uno = msg.contactMessage;
  const varios = msg.contactsArrayMessage?.contacts;
  const mapear = (c) => ({ name: { formatted_name: c?.displayName || "" }, vcard: c?.vcard || "" });
  if (Array.isArray(varios) && varios.length > 0) return varios.map(mapear);
  if (uno) return [mapear(uno)];
  return null;
}

async function handleInbound(ses, m) {
  // fromMe: lo mandó el mismo número desde el celular, no desde el ERP. Se
  // reenvía igual para que aparezca en el inbox; el ERP deduplica por el id
  // del mensaje, así que lo que salió del ERP no se duplica.
  const fromMe = m.key?.fromMe === true;
  const remoteJid = String(m.key?.remoteJid || "");
  // Solo conversaciones 1 a 1: grupos (@g.us) y estados se ignoran.
  if (!(remoteJid.endsWith("@s.whatsapp.net") || remoteJid.endsWith("@lid"))) return;

  // Con un @lid, el número real viene en `remoteJidAlt`; si no está, se le
  // pregunta al mapeo que Baileys mantiene.
  let pnJid = remoteJid;
  if (remoteJid.endsWith("@lid")) {
    const alt = String(m.key?.remoteJidAlt || "");
    if (alt.endsWith("@s.whatsapp.net")) {
      pnJid = alt;
    } else {
      try {
        const mapped = await ses.sock?.signalRepository?.lidMapping?.getPNForLID?.(remoteJid);
        if (mapped) pnJid = String(mapped);
      } catch (e) {
        logger.warn({ err: String(e) }, "no se pudo resolver LID->PN");
      }
    }
  }

  // El contacto se guarda con el identificador con el que llega el mensaje:
  // cambiarlo por el teléfono real duplicaría conversaciones. El teléfono va
  // aparte, en fromPhone, solo para mostrar.
  const fromDigits = remoteJid.split("@")[0].split(":")[0].replace(/\D/g, "");
  const fromPhone = pnJid.split("@")[0].split(":")[0].replace(/\D/g, "");
  if (!fromDigits) return;

  if (!fromMe && m.pushName) rememberContactName(ses, pnJid, m.pushName);

  const msg = m.message || {};
  const clase = clasificar(msg);
  const waMessageId = m.key?.id || null;
  if (!waMessageId) return;

  const payload = {
    channelId: ses.channelId,
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

  let aceptado = false;
  try {
    const res = await fetch(URL_INBOUND, {
      method: "POST",
      headers: { "content-type": "application/json", "x-bridge-secret": BRIDGE_SECRET },
      body: JSON.stringify(payload),
    });
    aceptado = res.ok;
    if (!res.ok) {
      logger.warn(
        { channelId: ses.channelId, status: res.status, body: await res.text().catch(() => "") },
        "el ERP rechazó el mensaje"
      );
    } else {
      logger.info({ channelId: ses.channelId, fromDigits, kind: payload.messageKind }, "mensaje reenviado");
    }
  } catch (e) {
    logger.error({ channelId: ses.channelId, err: String(e) }, "no se pudo avisar al ERP");
    return;
  }

  // Los bytes van después y solo si el mensaje quedó guardado: subirlos para
  // una fila que no existe deja el archivo colgado.
  if (aceptado && clase.hasMedia) {
    subirMedia(ses, m, waMessageId, clase.simple).catch((e) =>
      logger.warn({ err: String(e) }, "subirMedia")
    );
  }
}

/** Baja el archivo de WhatsApp y lo sube al ERP. */
async function subirMedia(ses, m, waMessageId, tipo) {
  let buffer;
  try {
    buffer = await downloadMediaMessage(m, "buffer", {}, {
      logger,
      reuploadRequest: ses.sock.updateMediaMessage,
    });
  } catch (e) {
    logger.warn({ err: String(e) }, "no se pudo bajar la media de WhatsApp");
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
  form.append("channelId", ses.channelId);
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
  // 2 = entregado al servidor, 3 = al celular, 4 = leído, 0/1 = en curso.
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
// 15mb alcanza para una factura en PDF mandada como base64.
app.use(express.json({ limit: "15mb" }));

function requireSecret(req, res, next) {
  if ((req.header("x-bridge-secret") || "") !== BRIDGE_SECRET) {
    return res.status(401).json({ ok: false, error: "bad secret" });
  }
  next();
}

/**
 * Resuelve de qué número habla este pedido.
 *
 * Con `/s/<id>/...` es ese canal. Sin prefijo, es el de CHANNEL_ID, que está
 * para no romper los puentes configurados antes de que esto soportara varios.
 */
function sesionDe(req, res) {
  const id = String(req.params.channelId || CHANNEL_ID || "").trim();
  if (!id) {
    res.status(400).json({ ok: false, error: "falta el canal: usá /s/<CHANNEL_ID>/..." });
    return null;
  }
  if (!RE_CANAL.test(id)) {
    res.status(400).json({ ok: false, error: "el canal tiene que ser un UUID" });
    return null;
  }
  try {
    return obtenerSesion(id);
  } catch (e) {
    res.status(503).json({ ok: false, error: e?.message || "no se pudo abrir la sesión" });
    return null;
  }
}

function exigirConexion(ses, res) {
  if (ses.state.connection !== "open" || !ses.sock) {
    res.status(503).json({ ok: false, error: "socket no conectado" });
    return false;
  }
  return true;
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

// ── Los handlers, una vez, montados en las dos formas de ruta ───────────────

const hStatus = (req, res) => {
  const ses = sesionDe(req, res);
  if (!ses) return;
  res.json({
    connection: ses.state.connection,
    lastQr: ses.state.lastQr,
    meNumber: ses.state.meNumber,
  });
};

const hContactName = (req, res) => {
  const ses = sesionDe(req, res);
  if (!ses) return;
  const to = String(req.query?.to || "").replace(/\D/g, "");
  res.json({ ok: true, name: (to && ses.contactNames.get(to)) || null });
};

const hSend = async (req, res) => {
  const ses = sesionDe(req, res);
  if (!ses) return;
  const jid = destino(req.body);
  const text = String(req.body?.text || "");
  const replyTo = String(req.body?.replyTo || "").trim();
  if (!jid || !text) return res.status(400).json({ ok: false, error: "to y text requeridos" });
  if (!exigirConexion(ses, res)) return;
  try {
    // Contestar citando: sin esto una respuesta sale suelta y el cliente no
    // ve a qué se le contestó.
    const opciones = replyTo
      ? { quoted: { key: { remoteJid: jid, id: replyTo, fromMe: false }, message: {} } }
      : undefined;
    const sent = await ses.sock.sendMessage(jid, { text }, opciones);
    res.json({ ok: true, id: sent?.key?.id || null });
  } catch (e) {
    res.status(500).json({ ok: false, error: e?.message || String(e) });
  }
};

const hReaction = async (req, res) => {
  const ses = sesionDe(req, res);
  if (!ses) return;
  const jid = destino(req.body);
  const targetId = String(req.body?.targetId || "").trim();
  // Un emoji vacío quita la reacción, igual que en WhatsApp.
  const emoji = req.body?.emoji == null ? "" : String(req.body.emoji);
  if (!jid || !targetId) return res.status(400).json({ ok: false, error: "to y targetId requeridos" });
  if (!exigirConexion(ses, res)) return;
  try {
    const sent = await ses.sock.sendMessage(jid, {
      react: { text: emoji, key: { remoteJid: jid, id: targetId, fromMe: false } },
    });
    res.json({ ok: true, id: sent?.key?.id || null });
  } catch (e) {
    res.status(500).json({ ok: false, error: e?.message || String(e) });
  }
};

/**
 * Manda un archivo.
 *
 * Acepta `url` (el ERP ya lo tiene en su storage y pasa el link, que es lo
 * barato) o `base64` para los ERP viejos que mandaban el binario.
 */
const hMedia = async (req, res) => {
  const ses = sesionDe(req, res);
  if (!ses) return;
  const jid = destino(req.body);
  const url = String(req.body?.url || "").trim();
  const b64 = String(req.body?.base64 || "");
  const caption = req.body?.caption == null ? "" : String(req.body.caption);
  const filename = String(req.body?.filename || "").trim();
  let mimetype = String(req.body?.mimetype || "").trim();
  const tipo = String(req.body?.tipo || "").trim().toLowerCase();
  if (!jid) return res.status(400).json({ ok: false, error: "to requerido" });
  if (!url && !b64) return res.status(400).json({ ok: false, error: "url o base64 requerido" });
  if (!exigirConexion(ses, res)) return;

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

    const sent = await ses.sock.sendMessage(jid, contenido);
    res.json({ ok: true, id: sent?.key?.id || null });
  } catch (e) {
    res.status(500).json({ ok: false, error: e?.message || String(e) });
  }
};

// Pantalla para escanear el QR desde el celular, sin pasar por el ERP.
const hQrPage = async (req, res) => {
  const ses = sesionDe(req, res);
  if (!ses) return;
  const st = ses.state;
  let body = "";
  if (st.connection === "open") {
    body = `<h1 style="color:#2a7">Conectado</h1><p>Número: ${st.meNumber || "-"}</p>`;
  } else if (st.connection === "qr" && st.lastQr) {
    const dataUrl = await QRCode.toDataURL(st.lastQr);
    body = `<h1>Escaneá con WhatsApp</h1><img src="${dataUrl}" style="max-width:320px" />
      <p>WhatsApp → Dispositivos vinculados → Vincular un dispositivo</p>`;
  } else {
    body = `<h1>Estado: ${st.connection}</h1><p>Recargá en unos segundos…</p>`;
  }
  res.send(`<!doctype html><meta charset="utf-8"><title>Puente WhatsApp</title>
    <body style="font-family:system-ui;max-width:520px;margin:40px auto;padding:0 16px">${body}
    <script>setTimeout(()=>location.reload(), 4000)</script></body>`);
};

const hQrPng = async (req, res) => {
  const ses = sesionDe(req, res);
  if (!ses) return;
  if (ses.state.connection !== "qr" || !ses.state.lastQr) return res.status(404).send("sin QR");
  const buf = await QRCode.toBuffer(ses.state.lastQr);
  res.setHeader("content-type", "image/png");
  res.send(buf);
};

// Por número.
app.get("/s/:channelId/status", requireSecret, hStatus);
app.get("/s/:channelId/contact-name", requireSecret, hContactName);
app.post("/s/:channelId/send", requireSecret, hSend);
app.post("/s/:channelId/send-reaction", requireSecret, hReaction);
app.post("/s/:channelId/send-media", requireSecret, hMedia);
app.get("/s/:channelId/qr.png", hQrPng);
app.get("/s/:channelId", hQrPage);
app.get("/s/:channelId/", hQrPage);

// Sin prefijo: el canal de CHANNEL_ID. Para los puentes de un solo número que
// ya estaban configurados así.
app.get("/status", requireSecret, hStatus);
app.get("/contact-name", requireSecret, hContactName);
app.post("/send", requireSecret, hSend);
app.post("/send-reaction", requireSecret, hReaction);
app.post("/send-media", requireSecret, hMedia);
app.get("/qr.png", hQrPng);

app.get("/health", (_req, res) => {
  const numeros = [...sesiones.values()].map((s) => ({
    channelId: s.channelId,
    connection: s.state.connection,
    meNumber: s.state.meNumber,
  }));
  res.json({ ok: true, sesiones: numeros.length, numeros });
});

// La portada: si hay un solo número configurado, su QR; si no, la lista.
app.get("/", async (req, res) => {
  if (CHANNEL_ID && sesiones.size <= 1) {
    req.params.channelId = CHANNEL_ID;
    return hQrPage(req, res);
  }
  const filas = [...sesiones.values()]
    .map((s) => {
      const estado = s.state.connection === "open" ? `Conectado · ${s.state.meNumber || "-"}` : s.state.connection;
      return `<li><a href="/s/${s.channelId}">${s.channelId}</a> — ${estado}</li>`;
    })
    .join("");
  res.send(`<!doctype html><meta charset="utf-8"><title>Puente WhatsApp</title>
    <body style="font-family:system-ui;max-width:640px;margin:40px auto;padding:0 16px">
    <h1>Puente WhatsApp</h1>
    <p>${sesiones.size} número(s). Para vincular uno nuevo, abrí <code>/s/&lt;CHANNEL_ID&gt;</code>.</p>
    <ul>${filas || "<li>Todavía no hay ninguno.</li>"}</ul>
    <script>setTimeout(()=>location.reload(), 6000)</script></body>`);
});

app.listen(PORT, () =>
  logger.info(
    { port: PORT, authDir: path.resolve(AUTH_DIR), erp: ERP_BASE, vocab: VOCAB, maxSesiones: MAX_SESIONES },
    "puente escuchando"
  )
);

/**
 * Mudanza del formato viejo.
 *
 * Los puentes de un solo número guardaban la sesión directamente en AUTH_DIR.
 * Acá cada número tiene su carpeta. Si encontramos credenciales sueltas en la
 * raíz y sabemos a qué canal son, se mudan adentro: así el número que ya
 * estaba vinculado sigue vinculado y nadie tiene que volver a escanear.
 *
 * Corre una sola vez: después de mudar, la raíz ya no tiene creds.json.
 */
function migrarSesionVieja() {
  if (!CHANNEL_ID || !RE_CANAL.test(CHANNEL_ID)) return;
  const credsRaiz = path.join(AUTH_DIR, "creds.json");
  if (!fs.existsSync(credsRaiz)) return;

  const destinoDir = carpetaDe(CHANNEL_ID);
  if (fs.existsSync(path.join(destinoDir, "creds.json"))) {
    logger.warn("hay credenciales en la raíz y en la carpeta del canal: se dejan como están");
    return;
  }
  try {
    fs.mkdirSync(destinoDir, { recursive: true });
    let movidos = 0;
    for (const f of fs.readdirSync(AUTH_DIR)) {
      const origen = path.join(AUTH_DIR, f);
      // Las carpetas de canales ya están en el formato nuevo.
      if (fs.statSync(origen).isDirectory()) continue;
      fs.renameSync(origen, path.join(destinoDir, f));
      movidos++;
    }
    logger.info({ channelId: CHANNEL_ID, archivos: movidos }, "sesión mudada al formato nuevo");
  } catch (e) {
    logger.error({ err: String(e) }, "no se pudo mudar la sesión vieja; puede hacer falta escanear de nuevo");
  }
}

migrarSesionVieja();

// El canal por defecto arranca solo, para que el QR esté listo sin esperar a
// que el ERP pregunte.
if (CHANNEL_ID && RE_CANAL.test(CHANNEL_ID)) {
  try {
    obtenerSesion(CHANNEL_ID);
  } catch (e) {
    logger.error({ err: String(e) }, "no se pudo arrancar el canal por defecto");
  }
}
