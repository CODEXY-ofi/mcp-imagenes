# Imagen para desplegar el servidor MCP online (Railway, Render, Fly.io, VPS…)
# El banco de imágenes se guarda en /data → móntalo como volumen persistente.
FROM node:22-slim

WORKDIR /app

COPY package.json package-lock.json* ./
RUN npm ci --omit=dev || npm install --omit=dev

COPY server-core.mjs server.mjs server-http.mjs ./

ENV NODE_ENV=production \
    BANCO_DIR=/data \
    CONFIG_FILE=/data/config.json \
    PORT=8787

VOLUME /data
EXPOSE 8787

CMD ["node", "server-http.mjs"]
