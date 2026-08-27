// Prueba del modo HTTP sin necesidad de hosting:  node test-http.mjs
// Arranca server-http.mjs en un puerto libre con un token de prueba, se conecta
// con el cliente oficial Streamable HTTP y llama a un par de herramientas.
import { spawn } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const PORT = 8917;
const TOKEN = "token-de-prueba-local-123456";

const child = spawn(process.execPath, [path.join(HERE, "server-http.mjs")], {
  env: { ...process.env, PORT: String(PORT), MCP_TOKEN: TOKEN },
  stdio: ["ignore", "inherit", "inherit"]
});
child.on("exit", (code) => {
  if (code !== null && code !== 0) {
    console.error(`El servidor HTTP terminó con código ${code}`);
    process.exit(1);
  }
});

// Espera a que /salud responda
let ready = false;
for (let i = 0; i < 40 && !ready; i++) {
  await new Promise((r) => setTimeout(r, 250));
  try {
    const res = await fetch(`http://localhost:${PORT}/salud`);
    ready = res.ok;
  } catch {}
}
if (!ready) {
  console.error("El servidor HTTP no arrancó a tiempo");
  child.kill();
  process.exit(1);
}
console.log("✔ /salud responde");

// 1) Sin token → debe rechazar
const bad = await fetch(`http://localhost:${PORT}/mcp`, {
  method: "POST",
  headers: { "Content-Type": "application/json", Accept: "application/json, text/event-stream" },
  body: JSON.stringify({ jsonrpc: "2.0", method: "ping", id: 1 })
});
console.log(bad.status === 401 ? "✔ sin token → 401 (protegido)" : `✘ esperaba 401, llegó ${bad.status}`);

// 2) Con token en la ruta secreta → conexión MCP completa
const transport = new StreamableHTTPClientTransport(new URL(`http://localhost:${PORT}/mcp/${TOKEN}`));
const client = new Client({ name: "test-http", version: "1.0.0" });
await client.connect(transport);

const { tools } = await client.listTools();
console.log(`✔ conectado por HTTP · ${tools.length} herramientas: ${tools.map((t) => t.name).join(", ")}`);

const r = await client.callTool({ name: "usage_report", arguments: {} });
console.log("✔ usage_report:\n" + (r.content?.[0]?.text || "").split("\n").slice(0, 2).join("\n"));

await client.close();
child.kill();
console.log("\n✔ Modo HTTP verificado — listo para desplegar");
process.exit(0);
