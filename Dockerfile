# Puente WhatsApp por QR (Baileys) para los ERP de Neura.
# Servicio Node sin paso de build: solo dependencias + server.mjs.
FROM node:20-slim

WORKDIR /app
ENV NODE_ENV=production

# curl: lo usa el healthcheck de Coolify (GET /health).
RUN apt-get update \
    && apt-get install -y --no-install-recommends curl ca-certificates \
    && rm -rf /var/lib/apt/lists/*

COPY package.json package-lock.json ./
RUN npm ci --omit=dev --omit=optional

COPY server.mjs ./

# La sesión de WhatsApp vive en AUTH_DIR (/app/auth): en Coolify va en un volumen persistente
# para no tener que escanear el QR de nuevo en cada deploy.
ENV PORT=3000
EXPOSE 3000
CMD ["node", "server.mjs"]
