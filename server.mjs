#!/usr/bin/env node
// Entrada LOCAL (stdio): la que usan Claude Code / Claude Desktop en este PC.
// La lógica vive en server-core.mjs; la versión online es server-http.mjs.
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { createServer, BANK_ROOT } from "./server-core.mjs";

const server = createServer();
await server.connect(new StdioServerTransport());
console.error(
  `[banco-imagenes] servidor MCP (stdio) listo · banco: ${BANK_ROOT} · key: ${process.env.OPENROUTER_API_KEY ? "OK" : "FALTA"}`
);
