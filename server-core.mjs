// Núcleo del servidor MCP "banco-imagenes": lógica compartida por los dos modos
// de transporte (stdio local → server.mjs, HTTP remoto → server-http.mjs).
//
// IMPORTANTE: nunca usar console.log (en modo stdio rompe el protocolo). Logs → console.error.

import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

let sharp = null;
try {
  sharp = (await import("sharp")).default;
} catch {
  console.error("[banco-imagenes] aviso: 'sharp' no disponible; las vistas previas usarán el archivo original");
}

// ---------------------------------------------------------------------------
// Rutas y configuración
// ---------------------------------------------------------------------------
const SERVER_DIR = path.dirname(fileURLToPath(import.meta.url));
export const BANK_ROOT = process.env.BANCO_DIR || path.dirname(SERVER_DIR);
const IMG_DIR = path.join(BANK_ROOT, "imagenes");
const BRANDS_DIR = path.join(BANK_ROOT, "marcas");
const LEDGER_FILE = path.join(IMG_DIR, "ledger.jsonl");
const CONFIG_FILE = process.env.CONFIG_FILE || path.join(SERVER_DIR, "config.json");

fs.mkdirSync(IMG_DIR, { recursive: true });
fs.mkdirSync(BRANDS_DIR, { recursive: true });

// Carga .env local (KEY=VALOR por línea) sin dependencias
const ENV_FILE = path.join(SERVER_DIR, ".env");
if (fs.existsSync(ENV_FILE)) {
  for (const line of fs.readFileSync(ENV_FILE, "utf8").split(/\r?\n/)) {
    const m = line.match(/^\s*([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*?)\s*$/);
    if (m && !line.trim().startsWith("#") && !process.env[m[1]]) {
      process.env[m[1]] = m[2].replace(/^["']|["']$/g, "");
    }
  }
}

const DEFAULT_CONFIG = {
  daily_limit_usd: 2.0,
  default_model: "google/gemini-3.1-flash-image",
  aliases: {
    flash: "google/gemini-3.1-flash-image",
    "flash-2.5": "google/gemini-2.5-flash-image",
    "nano-banana": "google/gemini-3.1-flash-image",
    pro: "google/gemini-3-pro-image",
    "nano-banana-pro": "google/gemini-3-pro-image",
    gpt: "openai/gpt-5-image",
    "gpt-mini": "openai/gpt-5-image-mini"
  },
  max_refs: 4
};

function loadConfig() {
  try {
    return { ...DEFAULT_CONFIG, ...JSON.parse(fs.readFileSync(CONFIG_FILE, "utf8")) };
  } catch {
    return { ...DEFAULT_CONFIG };
  }
}
function saveConfig(cfg) {
  fs.writeFileSync(CONFIG_FILE, JSON.stringify(cfg, null, 2));
}
let config = loadConfig();
if (!fs.existsSync(CONFIG_FILE)) saveConfig(config);

// ---------------------------------------------------------------------------
// Utilidades
// ---------------------------------------------------------------------------
const todayStr = () => new Date().toLocaleDateString("sv"); // YYYY-MM-DD local

function slugify(text, max = 40) {
  return (
    text
      .normalize("NFD")
      .replace(/[̀-ͯ]/g, "")
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, "-")
      .replace(/^-+|-+$/g, "")
      .slice(0, max) || "imagen"
  );
}

function shortId() {
  return (
    Date.now().toString(36).slice(-5) + Math.random().toString(36).slice(2, 5)
  );
}

function readLedger() {
  if (!fs.existsSync(LEDGER_FILE)) return [];
  const out = [];
  for (const line of fs.readFileSync(LEDGER_FILE, "utf8").split(/\r?\n/)) {
    if (!line.trim()) continue;
    try { out.push(JSON.parse(line)); } catch {}
  }
  return out;
}
function appendLedger(entry) {
  fs.appendFileSync(LEDGER_FILE, JSON.stringify(entry) + "\n");
}
function spentOn(datePrefix) {
  return readLedger()
    .filter((e) => (e.date || "").startsWith(datePrefix))
    .reduce((s, e) => s + (Number(e.cost_usd) || 0), 0);
}

function checkBudget() {
  const limit = Number(config.daily_limit_usd);
  const spent = spentOn(todayStr());
  if (limit <= 0) {
    throw new Error(
      `El presupuesto diario está en $${limit.toFixed(2)} (bloqueado). Usa set_daily_budget para asignar presupuesto.`
    );
  }
  if (spent >= limit) {
    throw new Error(
      `Límite diario alcanzado: gastados $${spent.toFixed(3)} de $${limit.toFixed(2)}. ` +
        `Sube el límite con set_daily_budget o espera a mañana.`
    );
  }
  return { limit, spent };
}

const IMG_EXTS = new Set([".png", ".jpg", ".jpeg", ".webp", ".gif"]);
function extMime(fp) {
  const e = path.extname(fp).toLowerCase();
  return (
    { ".png": "image/png", ".jpg": "image/jpeg", ".jpeg": "image/jpeg", ".webp": "image/webp", ".gif": "image/gif" }[e] ||
    "image/png"
  );
}

// Acepta un id del ledger o una ruta (absoluta / relativa al banco)
function resolveImageRef(ref) {
  const ledger = readLedger();
  const byId = ledger.find((e) => e.id === ref);
  if (byId) {
    const fp = path.join(BANK_ROOT, byId.file);
    if (fs.existsSync(fp)) return { filePath: fp, entry: byId };
  }
  const candidates = [ref, path.join(BANK_ROOT, ref), path.join(IMG_DIR, ref), path.join(BRANDS_DIR, ref)];
  for (const c of candidates) {
    if (fs.existsSync(c) && fs.statSync(c).isFile()) {
      const rel = path.relative(BANK_ROOT, c).replaceAll("\\", "/");
      const entry = ledger.find((e) => e.file === rel) || null;
      return { filePath: c, entry };
    }
  }
  throw new Error(
    `No encuentro la imagen "${ref}". Usa un id del ledger (ver list_images) o una ruta dentro del banco.`
  );
}

async function fileToJpegBase64(fp, maxSide = 1024) {
  if (sharp) {
    const buf = await sharp(fp)
      .rotate()
      .resize({ width: maxSide, height: maxSide, fit: "inside", withoutEnlargement: true })
      .jpeg({ quality: 88 })
      .toBuffer();
    return { base64: buf.toString("base64"), mime: "image/jpeg" };
  }
  const buf = fs.readFileSync(fp);
  if (buf.length > 4 * 1024 * 1024) {
    throw new Error("Imagen demasiado grande para enviar sin 'sharp' instalado (máx 4MB).");
  }
  return { base64: buf.toString("base64"), mime: extMime(fp) };
}

async function imagePartFromFile(fp, maxSide = 1024) {
  const { base64, mime } = await fileToJpegBase64(fp, maxSide);
  return { type: "image_url", image_url: { url: `data:${mime};base64,${base64}` } };
}

function saveDataUrl(dataUrl, dir, baseName) {
  const m = dataUrl.match(/^data:(image\/[a-z0-9.+-]+);base64,(.+)$/s);
  if (!m) throw new Error("El modelo devolvió una imagen en un formato inesperado.");
  const ext = { "image/png": ".png", "image/jpeg": ".jpg", "image/webp": ".webp" }[m[1]] || ".png";
  fs.mkdirSync(dir, { recursive: true });
  let fp = path.join(dir, baseName + ext);
  let n = 2;
  while (fs.existsSync(fp)) fp = path.join(dir, `${baseName}-${n++}${ext}`);
  fs.writeFileSync(fp, Buffer.from(m[2], "base64"));
  return fp;
}

// ---------------------------------------------------------------------------
// OpenRouter
// ---------------------------------------------------------------------------
function apiKey() {
  const k = process.env.OPENROUTER_API_KEY;
  if (!k) {
    throw new Error(
      "Falta OPENROUTER_API_KEY. Crea el archivo mcp-imagenes/.env con la línea " +
        "OPENROUTER_API_KEY=sk-or-v1-... y reinicia el servidor MCP."
    );
  }
  return k;
}

async function openrouterFetch(url, options, retries = 1) {
  const res = await fetch(url, { ...options, signal: AbortSignal.timeout(180000) });
  if (!res.ok && retries > 0 && (res.status === 429 || res.status >= 500)) {
    await new Promise((r) => setTimeout(r, 3000));
    return openrouterFetch(url, options, retries - 1);
  }
  return res;
}

let modelsCache = { at: 0, list: [] };
async function fetchImageModels() {
  if (Date.now() - modelsCache.at < 10 * 60 * 1000 && modelsCache.list.length) return modelsCache.list;
  const res = await openrouterFetch("https://openrouter.ai/api/v1/models", {});
  if (!res.ok) throw new Error(`OpenRouter /models devolvió ${res.status}`);
  const json = await res.json();
  const list = (json.data || []).filter((m) =>
    (m.architecture?.output_modalities || []).includes("image")
  );
  modelsCache = { at: Date.now(), list };
  return list;
}

function estimateCost(modelId) {
  const m = modelsCache.list.find((x) => x.id === modelId);
  const perImage = Number(m?.pricing?.image);
  if (perImage > 0) return perImage;
  // Las imágenes de Gemini se facturan como ~1290 tokens de salida
  const perTokenOut = Number(m?.pricing?.completion);
  if (perTokenOut > 0) return perTokenOut * 1290;
  return 0.04;
}

function resolveModel(nameOrAlias) {
  if (!nameOrAlias) return config.default_model;
  return config.aliases[nameOrAlias.toLowerCase()] || nameOrAlias;
}

// Devuelve { dataUrls, cost, text } de una petición de generación/edición
async function callImageModel(model, messages) {
  const res = await openrouterFetch("https://openrouter.ai/api/v1/chat/completions", {
    method: "POST",
    headers: {
      Authorization: `Bearer ${apiKey()}`,
      "Content-Type": "application/json",
      "HTTP-Referer": "https://codexyoficial.com",
      "X-Title": "Banco de Imagenes MCP"
    },
    body: JSON.stringify({
      model,
      messages,
      modalities: ["image", "text"],
      usage: { include: true }
    })
  });
  const json = await res.json().catch(() => null);
  if (!res.ok) {
    const msg = json?.error?.message || JSON.stringify(json)?.slice(0, 300) || res.statusText;
    throw new Error(`OpenRouter ${res.status}: ${msg}`);
  }
  const message = json.choices?.[0]?.message || {};
  const dataUrls = (message.images || [])
    .map((im) => im?.image_url?.url)
    .filter((u) => typeof u === "string" && u.startsWith("data:"));
  const text = typeof message.content === "string" ? message.content : "";
  let cost = json.usage?.cost != null ? Number(json.usage.cost) : NaN;
  if (!Number.isFinite(cost)) cost = estimateCost(model);
  if (!dataUrls.length) {
    throw new Error(
      `El modelo ${model} no devolvió ninguna imagen.` + (text ? ` Respuesta: ${text.slice(0, 400)}` : "")
    );
  }
  return { dataUrls, cost, text };
}

// ---------------------------------------------------------------------------
// Marcas (manual de marca + anuncios de referencia)
// ---------------------------------------------------------------------------
function listBrandDirs() {
  if (!fs.existsSync(BRANDS_DIR)) return [];
  return fs
    .readdirSync(BRANDS_DIR, { withFileTypes: true })
    .filter((d) => d.isDirectory() && !d.name.startsWith("_"))
    .map((d) => d.name);
}

function loadBrand(name) {
  const dir = path.join(BRANDS_DIR, name);
  if (!fs.existsSync(dir)) {
    const avail = listBrandDirs();
    throw new Error(
      `La marca "${name}" no existe.` +
        (avail.length ? ` Disponibles: ${avail.join(", ")}.` : " Crea la carpeta marcas/<nombre>/ con manual.md y refs/.")
    );
  }
  let manual = "";
  const manualFile = path.join(dir, "manual.md");
  if (fs.existsSync(manualFile)) manual = fs.readFileSync(manualFile, "utf8").trim().slice(0, 4000);
  const refsDir = path.join(dir, "refs");
  let refs = [];
  if (fs.existsSync(refsDir)) {
    refs = fs
      .readdirSync(refsDir)
      .filter((f) => IMG_EXTS.has(path.extname(f).toLowerCase()))
      .sort()
      .slice(0, config.max_refs)
      .map((f) => path.join(refsDir, f));
  }
  return { name, manual, refs };
}

// ---------------------------------------------------------------------------
// Construcción del servidor MCP (una instancia por conexión en modo HTTP)
// ---------------------------------------------------------------------------
function textResult(text) {
  return { content: [{ type: "text", text }] };
}
function errorResult(err) {
  return { content: [{ type: "text", text: `❌ ${err.message || err}` }], isError: true };
}

async function previewBlock(filePath, maxSide = 512) {
  try {
    const { base64, mime } = await fileToJpegBase64(filePath, maxSide);
    return { type: "image", data: base64, mimeType: mime };
  } catch {
    return null;
  }
}

function budgetLine() {
  const limit = Number(config.daily_limit_usd);
  const spent = spentOn(todayStr());
  return `Hoy: $${spent.toFixed(3)} / $${limit.toFixed(2)} (queda $${Math.max(0, limit - spent).toFixed(3)})`;
}

export function createServer() {
  const server = new McpServer({ name: "banco-imagenes", version: "1.1.0" });

  function registerTool(name, def, handler) {
    server.registerTool(name, def, async (args) => {
      try {
        return await handler(args || {});
      } catch (err) {
        console.error(`[banco-imagenes] ${name}:`, err);
        return errorResult(err);
      }
    });
  }

  // --- generate_image -------------------------------------------------------
  registerTool(
    "generate_image",
    {
      title: "Generar imagen",
      description:
        "Genera imágenes con modelos de OpenRouter y las guarda en el banco de imágenes. " +
        "Modelos: alias 'flash' (rápido/barato, por defecto), 'pro' (Nano Banana Pro: máxima calidad, texto legible en anuncios), " +
        "'gpt' (GPT-5 Image) o cualquier id de list_image_models. Acepta imágenes de referencia (ids o rutas) y una marca " +
        "(carpeta marcas/<nombre>/ con manual.md + refs/) para replicar su estilo. Respeta el límite de gasto diario.",
      inputSchema: {
        prompt: z.string().min(1).describe("Descripción de la imagen a generar (cuanto más concreta, mejor)"),
        model: z.string().optional().describe("Alias ('flash', 'pro', 'gpt') o id completo del modelo. Por defecto: flash"),
        count: z.number().int().min(1).max(4).optional().describe("Número de variantes (1-4, por defecto 1)"),
        aspect_ratio: z
          .string()
          .optional()
          .describe("Relación de aspecto: 1:1 (post IG), 4:5 (feed IG), 9:16 (story/reel), 16:9 (YouTube/web), 3:2, 21:9"),
        brand: z.string().optional().describe("Nombre de la marca en marcas/ para aplicar su manual y referencias"),
        reference_images: z
          .array(z.string())
          .max(4)
          .optional()
          .describe("Ids del ledger o rutas de imágenes a usar como referencia de estilo/contenido"),
        project: z.string().optional().describe("Subcarpeta del proyecto donde guardar (por defecto, carpeta por fecha)"),
        preview: z.boolean().optional().describe("Adjuntar vista previa en la respuesta para verla (por defecto true)")
      }
    },
    async (a) => {
      const model = resolveModel(a.model);
      const count = a.count || 1;
      try { await fetchImageModels(); } catch {} // solo para estimaciones de coste

      // Referencias: marca + explícitas
      const parts = [];
      let brandBlock = "";
      if (a.brand) {
        const b = loadBrand(a.brand);
        if (b.manual) brandBlock = `Directrices de marca (${b.name}):\n${b.manual}\n\n`;
        for (const fp of b.refs) parts.push(await imagePartFromFile(fp));
      }
      for (const ref of a.reference_images || []) {
        const { filePath } = resolveImageRef(ref);
        parts.push(await imagePartFromFile(filePath));
      }
      if (parts.length > 6) parts.length = 6;

      let promptText = brandBlock + a.prompt;
      if (parts.length) {
        promptText +=
          "\n\nUsa las imágenes adjuntas como referencia de estilo, composición y marca. Mantén la coherencia visual con ellas.";
      }
      if (a.aspect_ratio) promptText += `\n\nGenera la imagen en relación de aspecto ${a.aspect_ratio}.`;
      const messages = [{ role: "user", content: [...parts, { type: "text", text: promptText }] }];

      const folder = a.project ? path.join(IMG_DIR, slugify(a.project)) : path.join(IMG_DIR, todayStr());
      const slug = slugify(a.prompt);
      const saved = [];
      let totalCost = 0;

      for (let i = 0; i < count; i++) {
        checkBudget();
        const { dataUrls, cost } = await callImageModel(model, messages);
        totalCost += cost;
        for (const du of dataUrls) {
          const id = shortId();
          const fp = saveDataUrl(du, folder, `${slug}-${id}`);
          const rel = path.relative(BANK_ROOT, fp).replaceAll("\\", "/");
          const entry = {
            id,
            ts: new Date().toISOString(),
            date: todayStr(),
            kind: "generate",
            model,
            prompt: a.prompt,
            brand: a.brand || null,
            project: a.project || null,
            aspect_ratio: a.aspect_ratio || null,
            file: rel,
            cost_usd: Number((cost / dataUrls.length).toFixed(6))
          };
          appendLedger(entry);
          saved.push(entry);
        }
      }

      const lines = saved.map((s) => `  [${s.id}] ${s.file}`);
      const text =
        `✅ ${saved.length} imagen(es) generada(s) con ${model}\n` +
        lines.join("\n") +
        `\nCoste: $${totalCost.toFixed(4)} · ${budgetLine()}`;
      const content = [{ type: "text", text }];
      if (a.preview !== false && saved.length) {
        const block = await previewBlock(path.join(BANK_ROOT, saved[0].file));
        if (block) content.push(block);
      }
      return { content };
    }
  );

  // --- edit_image -----------------------------------------------------------
  registerTool(
    "edit_image",
    {
      title: "Editar imagen",
      description:
        "Edita una imagen existente (generada o de referencia) con una instrucción: cambiar fondo, texto, colores, " +
        "quitar/añadir elementos, adaptar un anuncio existente a otro mensaje, etc. Guarda el resultado como nueva imagen.",
      inputSchema: {
        image: z.string().describe("Id del ledger o ruta de la imagen a editar"),
        instruction: z.string().min(1).describe("Qué cambiar en la imagen"),
        model: z.string().optional().describe("Alias o id del modelo (por defecto: flash)"),
        project: z.string().optional().describe("Subcarpeta del proyecto donde guardar"),
        preview: z.boolean().optional().describe("Adjuntar vista previa (por defecto true)")
      }
    },
    async (a) => {
      const model = resolveModel(a.model);
      try { await fetchImageModels(); } catch {}
      const { filePath, entry } = resolveImageRef(a.image);
      checkBudget();

      const messages = [
        {
          role: "user",
          content: [
            await imagePartFromFile(filePath, 1280),
            { type: "text", text: `Edita esta imagen: ${a.instruction}. Conserva todo lo demás igual.` }
          ]
        }
      ];
      const { dataUrls, cost } = await callImageModel(model, messages);

      const folder = a.project ? path.join(IMG_DIR, slugify(a.project)) : path.join(IMG_DIR, todayStr());
      const saved = [];
      for (const du of dataUrls) {
        const id = shortId();
        const fp = saveDataUrl(du, folder, `${slugify(a.instruction)}-${id}`);
        const rel = path.relative(BANK_ROOT, fp).replaceAll("\\", "/");
        const led = {
          id,
          ts: new Date().toISOString(),
          date: todayStr(),
          kind: "edit",
          model,
          prompt: a.instruction,
          parent: entry?.id || path.relative(BANK_ROOT, filePath).replaceAll("\\", "/"),
          file: rel,
          cost_usd: Number((cost / dataUrls.length).toFixed(6))
        };
        appendLedger(led);
        saved.push(led);
      }

      const text =
        `✅ Edición guardada (${model})\n` +
        saved.map((s) => `  [${s.id}] ${s.file}`).join("\n") +
        `\nCoste: $${cost.toFixed(4)} · ${budgetLine()}`;
      const content = [{ type: "text", text }];
      if (a.preview !== false && saved.length) {
        const block = await previewBlock(path.join(BANK_ROOT, saved[0].file));
        if (block) content.push(block);
      }
      return { content };
    }
  );

  // --- show_image -----------------------------------------------------------
  registerTool(
    "show_image",
    {
      title: "Ver imagen",
      description:
        "Devuelve una imagen del banco (generada, de una marca, o cualquier archivo de imagen) para que Claude pueda " +
        "VERLA y usarla como referencia visual: criticarla, describirla, comparar variantes o inspirar un diseño.",
      inputSchema: {
        image: z.string().describe("Id del ledger o ruta de la imagen"),
        max_side: z.number().int().min(256).max(1536).optional().describe("Lado máximo en px de la vista (por defecto 1024)")
      }
    },
    async (a) => {
      const { filePath, entry } = resolveImageRef(a.image);
      const { base64, mime } = await fileToJpegBase64(filePath, a.max_side || 1024);
      const rel = path.relative(BANK_ROOT, filePath).replaceAll("\\", "/");
      let meta = `📷 ${rel}`;
      if (entry) {
        meta += `\nId: ${entry.id} · ${entry.date} · ${entry.model} · $${Number(entry.cost_usd || 0).toFixed(4)}`;
        if (entry.prompt) meta += `\nPrompt: ${entry.prompt}`;
        if (entry.brand) meta += `\nMarca: ${entry.brand}`;
      }
      return { content: [{ type: "text", text: meta }, { type: "image", data: base64, mimeType: mime }] };
    }
  );

  // --- list_images ----------------------------------------------------------
  registerTool(
    "list_images",
    {
      title: "Buscar en el banco",
      description: "Lista/busca imágenes generadas en el banco por texto del prompt, marca, proyecto o fecha.",
      inputSchema: {
        query: z.string().optional().describe("Texto a buscar en los prompts"),
        brand: z.string().optional().describe("Filtrar por marca"),
        project: z.string().optional().describe("Filtrar por proyecto"),
        date: z.string().optional().describe("Filtrar por fecha YYYY-MM-DD o mes YYYY-MM"),
        limit: z.number().int().min(1).max(100).optional().describe("Máximo de resultados (por defecto 20)")
      }
    },
    async (a) => {
      let entries = readLedger().reverse();
      if (a.query) entries = entries.filter((e) => (e.prompt || "").toLowerCase().includes(a.query.toLowerCase()));
      if (a.brand) entries = entries.filter((e) => (e.brand || "").toLowerCase() === a.brand.toLowerCase());
      if (a.project) entries = entries.filter((e) => (e.project || "").toLowerCase() === a.project.toLowerCase());
      if (a.date) entries = entries.filter((e) => (e.date || "").startsWith(a.date));
      const total = entries.length;
      entries = entries.slice(0, a.limit || 20);
      if (!entries.length) return textResult("No hay imágenes que coincidan. Genera alguna con generate_image.");
      const lines = entries.map(
        (e) =>
          `[${e.id}] ${e.date} · ${e.kind} · ${(e.model || "").split("/").pop()} · $${Number(e.cost_usd || 0).toFixed(3)}\n` +
          `    ${e.file}\n    "${(e.prompt || "").slice(0, 90)}"`
      );
      return textResult(`${total} resultado(s), mostrando ${entries.length}:\n\n` + lines.join("\n"));
    }
  );

  // --- list_image_models ----------------------------------------------------
  registerTool(
    "list_image_models",
    {
      title: "Modelos de imagen disponibles",
      description: "Consulta en vivo los modelos de OpenRouter capaces de generar imágenes, con sus precios.",
      inputSchema: {}
    },
    async () => {
      const models = await fetchImageModels();
      if (!models.length) return textResult("OpenRouter no devolvió modelos con salida de imagen.");
      const aliasRev = {};
      for (const [al, id] of Object.entries(config.aliases)) (aliasRev[id] ||= []).push(al);
      const lines = models
        .sort((x, y) => x.id.localeCompare(y.id))
        .map((m) => {
          const est = estimateCost(m.id);
          const price = est >= 0.001 ? `~$${est.toFixed(3)}/imagen` : "precio según uso real";
          const als = aliasRev[m.id] ? `  ← alias: ${aliasRev[m.id].join(", ")}` : "";
          const def = m.id === config.default_model ? "  ★ por defecto" : "";
          return `${m.id} — ${price}${als}${def}`;
        });
      return textResult(
        `Modelos con generación de imagen en OpenRouter (${models.length}):\n\n` +
          lines.join("\n") +
          `\n\nUsa el id completo o un alias en generate_image. Precios estimados; el coste real se registra por generación.`
      );
    }
  );

  // --- usage_report ---------------------------------------------------------
  registerTool(
    "usage_report",
    {
      title: "Informe de gasto",
      description: "Muestra el gasto de hoy, del mes y total, el presupuesto diario restante y el desglose por modelo.",
      inputSchema: {}
    },
    async () => {
      const ledger = readLedger();
      const today = todayStr();
      const month = today.slice(0, 7);
      const sum = (f) => ledger.filter(f).reduce((s, e) => s + (Number(e.cost_usd) || 0), 0);
      const spentToday = sum((e) => e.date === today);
      const spentMonth = sum((e) => (e.date || "").startsWith(month));
      const spentTotal = sum(() => true);
      const byModel = {};
      for (const e of ledger) {
        const k = e.model || "?";
        byModel[k] = byModel[k] || { n: 0, usd: 0 };
        byModel[k].n++;
        byModel[k].usd += Number(e.cost_usd) || 0;
      }
      const modelLines = Object.entries(byModel)
        .sort((a, b) => b[1].usd - a[1].usd)
        .map(([m, v]) => `  ${m}: ${v.n} img · $${v.usd.toFixed(3)}`);
      const limit = Number(config.daily_limit_usd);
      return textResult(
        `💰 Informe de gasto\n` +
          `Hoy (${today}): $${spentToday.toFixed(3)} de $${limit.toFixed(2)} → queda $${Math.max(0, limit - spentToday).toFixed(3)}\n` +
          `Mes (${month}): $${spentMonth.toFixed(3)}\n` +
          `Total histórico: $${spentTotal.toFixed(3)} · ${ledger.length} imágenes\n` +
          (modelLines.length ? `\nPor modelo:\n${modelLines.join("\n")}` : "")
      );
    }
  );

  // --- set_daily_budget -----------------------------------------------------
  registerTool(
    "set_daily_budget",
    {
      title: "Fijar presupuesto diario",
      description:
        "Configura el límite de gasto diario en USD. Con 0 se bloquea toda generación. El límite se aplica antes de cada petición.",
      inputSchema: {
        usd: z.number().min(0).max(1000).describe("Límite diario en USD (ej. 2.5). 0 = bloquear generación")
      }
    },
    async (a) => {
      config.daily_limit_usd = a.usd;
      saveConfig(config);
      const spent = spentOn(todayStr());
      return textResult(
        `✅ Presupuesto diario fijado en $${a.usd.toFixed(2)}. Gastado hoy: $${spent.toFixed(3)} → queda $${Math.max(0, a.usd - spent).toFixed(3)}.`
      );
    }
  );

  // --- list_brands ----------------------------------------------------------
  registerTool(
    "list_brands",
    {
      title: "Marcas disponibles",
      description:
        "Lista las marcas configuradas en marcas/ (manual de marca + anuncios/imágenes de referencia) que generate_image puede replicar.",
      inputSchema: {}
    },
    async () => {
      const names = listBrandDirs();
      if (!names.length) {
        return textResult(
          "No hay marcas configuradas todavía.\n\nPara crear una:\n" +
            "1. Crea la carpeta marcas/<nombre>/\n" +
            "2. Escribe marcas/<nombre>/manual.md (colores, tipografía, tono, estilo — hay plantilla en marcas/_plantilla/)\n" +
            "3. Copia 3-5 anuncios o imágenes de referencia en marcas/<nombre>/refs/\n" +
            'Luego genera con generate_image(brand: "<nombre>").'
        );
      }
      const lines = names.map((n) => {
        const b = loadBrand(n);
        const excerpt = b.manual ? b.manual.replace(/\s+/g, " ").slice(0, 120) : "(sin manual.md)";
        return `• ${n} — ${b.refs.length} referencia(s)\n  ${excerpt}${b.manual.length > 120 ? "…" : ""}`;
      });
      return textResult(`Marcas configuradas (${names.length}):\n\n` + lines.join("\n\n"));
    }
  );

  return server;
}
