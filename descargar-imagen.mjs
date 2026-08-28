// Descarga una imagen del banco REMOTO al PC vía MCP:
//   node descargar-imagen.mjs <url-endpoint-mcp> <id-o-ruta> <archivo-destino>
import fs from "node:fs";
import path from "node:path";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";

const [url, imageRef, outPath] = process.argv.slice(2);
if (!url || !imageRef || !outPath) {
  console.error("Uso: node descargar-imagen.mjs <url-mcp> <id-o-ruta> <destino.jpg>");
  process.exit(1);
}
const transport = new StreamableHTTPClientTransport(new URL(url));
const client = new Client({ name: "descarga-banco", version: "1.0.0" });
await client.connect(transport);
const r = await client.callTool({ name: "show_image", arguments: { image: imageRef, max_side: 1536 } });
const img = (r.content || []).find((c) => c.type === "image");
const meta = (r.content || []).find((c) => c.type === "text");
if (!img) {
  console.error("El servidor no devolvió imagen:", meta?.text || "(sin detalle)");
  process.exit(1);
}
fs.mkdirSync(path.dirname(path.resolve(outPath)), { recursive: true });
fs.writeFileSync(outPath, Buffer.from(img.data, "base64"));
console.log(meta?.text || "");
console.log(`✔ guardada: ${outPath} (${Math.round((img.data.length * 0.75) / 1024)} KB)`);
await client.close();
