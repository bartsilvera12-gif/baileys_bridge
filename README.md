# baileys-bridge

Puente de WhatsApp por QR para los ERP de Neura. **Uno solo para todos los
clientes**: no hay nada específico de una empresa en el código, lo que cambia
son las variables de entorno.

Antes había un repo copiado por cliente (`baileys-bridge-asociacion-azulgrana`,
`baileys-bridge-contable`, `baileys-bridge-neura`). Eran idénticos salvo el
nombre en el `package.json`, así que cada arreglo había que aplicarlo tres
veces.

## Qué hace

Sostiene la sesión de WhatsApp de **un** número, como WhatsApp Web, y hace de
intermediario con el ERP:

- vincula el número por QR y lo reconecta solo cuando se cae;
- cuando entra un mensaje, se lo avisa al ERP y le sube el archivo si lo tiene;
- cuando el ERP quiere responder, manda el texto, el archivo o la reacción;
- avisa cuando un mensaje saliente se entregó o se leyó.

**Un número = un contenedor = un volumen.** La sesión vive en `AUTH_DIR`, y dos
procesos sobre la misma carpeta se desconectan entre sí. Para un segundo número
se despliega este mismo repo otra vez, con su propio volumen.

## Variables

| Variable | Obligatoria | Qué es |
|---|---|---|
| `BRIDGE_SECRET` | sí | Secreto compartido con el ERP. Allá se llama `BAILEYS_BRIDGE_SECRET` y tiene que ser **el mismo valor**. Uno distinto por cliente. |
| `ERP_BASE_URL` | sí | La base del ERP, ej. `https://roldanehijos.neura.com.py`. Sin la ruta. |
| `EMPRESA_ID` | sí | El `empresa_id` del cliente en el ERP. |
| `CHANNEL_ID` | sí | El id del canal. Lo da la pantalla de alta del canal en el ERP, así que se carga **después** de crearlo. |
| `AUTH_DIR` | recomendada | Dónde vive la sesión. En Coolify, `/app/auth` sobre un volumen persistente: sin volumen hay que escanear el QR en cada deploy. |
| `PORT` | no | 3000 por defecto. |
| `KIND_VOCAB` | no | `baileys` (por defecto) o `simple`. Ver abajo. |
| `LOG_LEVEL` | no | `info` por defecto. |

`ERP_WEBHOOK_URL` se sigue aceptando por compatibilidad con los puentes viejos:
si trae la ruta puesta, se le recorta y queda la base.

### KIND_VOCAB: leer esto antes de migrar un cliente viejo

El puente le dice al ERP qué clase de mensaje llegó, y hay dos vocabularios
dando vueltas:

- `baileys` → `conversation`, `imageMessage`, `documentMessage`… el nombre
  crudo de la librería. Es lo que esperan los ERP nuevos.
- `simple` → `text`, `image`, `document`… es lo que mandaban los puentes
  viejos.

**Si el ERP no reconoce el tipo, saltea el mensaje**: el número queda
vinculado, el puente reenvía, el ERP contesta 200 y al inbox no entra nada. El
único rastro es una línea de log.

Antes de apuntar un cliente que ya venía andando a este repo: o le ponés
`KIND_VOCAB=simple`, o le enseñás a su ERP a aceptar los dos (es un `switch`,
diez líneas; en `neura-erp-roldan` ya está hecho, en
`src/app/api/webhooks/baileys/inbound/route.ts`).

## Puesta en marcha

1. En el ERP (Coolify): `BAILEYS_BRIDGE_SECRET` y redeploy.
2. En el ERP: Configuración → Canales → Nuevo → WhatsApp → **WhatsApp por QR**,
   con la URL de este puente. La pantalla muestra `CHANNEL_ID` y `EMPRESA_ID`.
3. Crear en Coolify una app **nueva** desde este repo (no clonar otra: clonar
   puede arrastrar el volumen de la sesión del original y tumbar los dos
   números). Dockerfile, puerto 3000, healthcheck `GET /health`.
4. Cargar las variables y un volumen nuevo en `/app/auth`. Encender.
5. Volver a la pantalla del ERP: aparece el QR. Escanear desde el celular del
   número (WhatsApp → Dispositivos vinculados → Vincular un dispositivo).

El QR también se puede escanear directo desde `GET /` del puente, sin pasar por
el ERP.

## Endpoints

Todos menos `/`, `/qr.png` y `/health` piden el header `x-bridge-secret`.

### Los que el ERP consume

| Endpoint | Cuerpo | Devuelve |
|---|---|---|
| `GET /status` | — | `{ connection, lastQr, meNumber }`, con `connection` en `starting`, `qr`, `open` o `close`. |
| `GET /contact-name?to=<dígitos>` | — | `{ ok, name }`. El nombre que WhatsApp conoce, o `null`. |
| `POST /send` | `{ to, toJid?, text, replyTo? }` | `{ ok, id }` |
| `POST /send-reaction` | `{ to, toJid?, targetId, emoji }` | `{ ok, id }`. Emoji vacío quita la reacción. |
| `POST /send-media` | `{ to, toJid?, url \| base64, tipo?, caption?, filename?, mimetype? }` | `{ ok, id }` |

`toJid` manda sobre `to`: trae el sufijo real del contacto (`@lid` o
`@s.whatsapp.net`). Forzar siempre `@s.whatsapp.net` sobre un contacto `@lid`
manda el mensaje a un número que no existe.

`/send-media` prefiere `url` (el archivo ya está en el storage del ERP y no
viajan megabytes por el cuerpo del pedido) y acepta `base64` para los ERP
viejos.

### Los que el puente llama en el ERP

| Endpoint | Cuándo |
|---|---|
| `POST {ERP}/api/webhooks/baileys/inbound` | Cada mensaje que entra. |
| `POST {ERP}/api/webhooks/baileys/inbound/media` | Los bytes del archivo, multipart, después de que el ERP aceptó el mensaje. |
| `POST {ERP}/api/webhooks/baileys/status` | `sent` / `delivered` / `read`. |

Los bytes van **después** y solo si el mensaje quedó guardado: subir un archivo
para una fila que no existe lo deja colgado.

La media de WhatsApp viaja cifrada con la clave de la sesión, así que el ERP no
puede ir a buscarla ni teniendo la URL: solo el puente puede descifrarla. Por
eso la baja y la sube, en vez de pasar un link.

## Lo que no hace

- **Grupos.** Solo conversaciones 1 a 1; los mensajes de grupo y los estados se
  ignoran.
- **Campañas.** Es un número personal vinculado por QR: mandar masivos por acá
  es la forma más rápida de que WhatsApp lo bloquee.
