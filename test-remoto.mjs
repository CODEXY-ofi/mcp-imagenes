// Verifica un servidor MCP remoto:  node test-remoto.mjs https://dominio/mcp/TOKEN
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";

const url = process.argv[2];
if (!url) {
  console.error("Uso: node test-remoto.mjs <url-completa-del-endpoint-mcp>");
  process.exit(1);
}
const transport = new StreamableHTTPClientTransport(new URL(url));
const client = new Client({ name: "verificacion-remota", version: "1.0.0" });
await client.connect(transport);
const { tools } = await client.listTools();
console.log(`✔ conectado · ${tools.length} herramientas: ${tools.map((t) => t.name).join(", ")}`);
const r = await client.callTool({ name: "usage_report", arguments: {} });
console.log("✔ usage_report:\n" + (r.content?.[0]?.text || "").split("\n").slice(0, 3).join("\n"));
await client.close();
console.log("✔ Servidor remoto operativo");
