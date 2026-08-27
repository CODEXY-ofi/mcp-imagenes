// Prueba rápida del servidor MCP sin necesidad de Claude:  node test-client.mjs
// Lista las herramientas, consulta modelos, informe de gasto y prueba show_image.
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import path from "node:path";
import { fileURLToPath } from "node:url";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const transport = new StdioClientTransport({
  command: process.execPath,
  args: [path.join(HERE, "server.mjs")],
  // Entorno COMPLETO: en Windows con antivirus (Avast) la red TLS de Node
  // depende de NODE_EXTRA_CA_CERTS, que el entorno por defecto del SDK recorta.
  env: { ...process.env },
  stderr: "inherit"
});
const client = new Client({ name: "test-client", version: "1.0.0" });
await client.connect(transport);

const { tools } = await client.listTools();
console.log("\n== Herramientas ==");
console.log(tools.map((t) => t.name).join(", "));

async function call(name, args = {}) {
  console.log(`\n== ${name} ${JSON.stringify(args)} ==`);
  const r = await client.callTool({ name, arguments: args });
  for (const c of r.content || []) {
    if (c.type === "text") console.log(c.text.slice(0, 1200));
    else if (c.type === "image") console.log(`(imagen adjunta: ${c.mimeType}, ${Math.round(c.data.length * 0.75 / 1024)} KB)`);
  }
  return r;
}

await call("usage_report");
await call("list_brands");
await call("list_image_models");

// show_image sobre una imagen de prueba generada localmente con sharp
try {
  const sharp = (await import("sharp")).default;
  const testPng = path.join(HERE, "test-imagen.png");
  await sharp({
    create: { width: 640, height: 360, channels: 3, background: { r: 30, g: 120, b: 200 } }
  })
    .png()
    .toFile(testPng);
  await call("show_image", { image: testPng });
} catch (e) {
  console.log("(saltada prueba show_image:", e.message + ")");
}

// Si hay key, genera una imagen real barata; si no, muestra el error esperado
await call("generate_image", { prompt: "un cubo azul minimalista sobre fondo blanco, render 3d suave", preview: false });

await client.close();
console.log("\n✔ Pruebas terminadas");
