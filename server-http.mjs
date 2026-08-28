#!/usr/bin/env node
// Entrada ONLINE (Streamable HTTP): para desplegar en Railway/Render/Fly/VPS y
// conectar desde claude.ai (conector personalizado) o Claude Code de cualquier equipo.
//
// Seguridad: el endpoint MCP vive en una ruta secreta /mcp/<MCP_TOKEN> y además
// acepta "Authorization: Bearer <MCP_TOKEN>". Sin MCP_TOKEN el servidor no arranca.
//
// Variables de entorno:
//   MCP_TOKEN            (obligatoria) token largo aleatorio que protege el endpoint
//   OPENROUTER_API_KEY   (obligatoria) tu clave de OpenRouter
//   PORT                 puerto HTTP (por defecto 8787; Railway/Render la inyectan)
//   BANCO_DIR            carpeta persistente del banco (ej. /data en un volumen)

import express from "express";
import fs from "node:fs";
import path from "node:path";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { createServer, BANK_ROOT, findLedgerEntry } from "./server-core.mjs";

const PORT = Number(process.env.PORT) || 8787;
const TOKEN = process.env.MCP_TOKEN;

if (!TOKEN || TOKEN.length < 16) {
  console.error(
    "[banco-imagenes] ERROR: define MCP_TOKEN (mínimo 16 caracteres) en las variables de entorno.\n" +
      "  Genera uno con:  node -e \"console.log(crypto.randomBytes(24).toString('base64url'))\""
  );
  process.exit(1);
}

const app = express();
app.use(express.json({ limit: "8mb" }));

function authorized(req) {
  if (req.params.token === TOKEN) return true;
  const h = req.headers.authorization || "";
  return h === `Bearer ${TOKEN}`;
}

// Comprobación de vida (sin datos sensibles)
app.get("/salud", (_req, res) => {
  res.json({ ok: true, servicio: "banco-imagenes", version: "1.2.0" });
});

// Modo "stateless": una instancia de servidor MCP por petición — simple y robusto
async function handleMcp(req, res) {
  if (!authorized(req)) {
    res.status(401).json({
      jsonrpc: "2.0",
      error: { code: -32001, message: "No autorizado" },
      id: null
    });
    return;
  }
  try {
    const server = createServer();
    const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined });
    res.on("close", () => {
      transport.close();
      server.close();
    });
    await server.connect(transport);
    await transport.handleRequest(req, res, req.body);
  } catch (err) {
    console.error("[banco-imagenes] error HTTP:", err);
    if (!res.headersSent) {
      res.status(500).json({
        jsonrpc: "2.0",
        error: { code: -32603, message: "Error interno del servidor" },
        id: null
      });
    }
  }
}

app.post("/mcp/:token", handleMcp);
app.post("/mcp", handleMcp);

// Ver/descargar un archivo del banco por su id del ledger (videos e imágenes)
const FILE_MIMES = {
  ".mp4": "video/mp4", ".webm": "video/webm",
  ".png": "image/png", ".jpg": "image/jpeg", ".jpeg": "image/jpeg", ".webp": "image/webp"
};
app.get("/archivo/:token/:id", (req, res) => {
  if (req.params.token !== TOKEN) return res.status(401).send("No autorizado");
  const entry = findLedgerEntry(req.params.id);
  if (!entry) return res.status(404).send("No existe ese id en el banco");
  const fp = path.join(BANK_ROOT, entry.file);
  if (!fs.existsSync(fp)) return res.status(404).send("El archivo ya no está en el banco");
  const mime = FILE_MIMES[path.extname(fp).toLowerCase()] || "application/octet-stream";
  res.setHeader("Content-Type", mime);
  res.setHeader("Content-Length", fs.statSync(fp).size);
  res.setHeader("Content-Disposition", `inline; filename="${path.basename(fp)}"`);
  fs.createReadStream(fp).pipe(res);
});

// En modo stateless no hay sesiones que reanudar ni cerrar
const notAllowed = (_req, res) =>
  res.status(405).json({
    jsonrpc: "2.0",
    error: { code: -32000, message: "Método no permitido en modo stateless" },
    id: null
  });
app.get(["/mcp/:token", "/mcp"], notAllowed);
app.delete(["/mcp/:token", "/mcp"], notAllowed);

app.listen(PORT, () => {
  console.error(
    `[banco-imagenes] servidor MCP (HTTP) escuchando en :${PORT} · banco: ${BANK_ROOT} · ` +
      `key OpenRouter: ${process.env.OPENROUTER_API_KEY ? "OK" : "FALTA"}\n` +
      `  endpoint: /mcp/<MCP_TOKEN>  (o /mcp con cabecera Authorization: Bearer <MCP_TOKEN>)`
  );
});
