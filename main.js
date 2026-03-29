const { app, BrowserWindow, ipcMain, dialog, Menu, shell } = require("electron");
const fs = require("node:fs/promises");
const path = require("node:path");
const { pathToFileURL, fileURLToPath } = require("node:url");
const { PDFParse } = require("pdf-parse");

const TAGS_FILE = ".ogx-tags.json";
const CARDS_FILE = ".ogx-view-cards.json";
const CONCEPTS_FILE = ".ogx-concepts.json";
const MEDIA_INDEX_FILE = ".ogx-media-index.json";

// Keep Chromium cache out of restricted synced folders (e.g. OneDrive).

function envFlagEnabled(name) {
  const raw = process.env[name];
  if (raw == null) {
    return false;
  }
  return !/^(0|false|no|off)$/i.test(String(raw).trim());
}

function hasArg(name) {
  return process.argv.includes(name);
}

function configureGraphicsFallback() {
  const forceGpu =
    envFlagEnabled("OGX_ENABLE_GPU") ||
    hasArg("--enable-gpu") ||
    hasArg("--force-gpu");
  const disableGpu =
    !forceGpu && (
      envFlagEnabled("OGX_DISABLE_GPU") ||
      hasArg("--disable-gpu") ||
      hasArg("--safe-gpu")
    );

  if (!disableGpu) {
    return { gpuDisabled: false };
  }

  app.disableHardwareAcceleration();
  app.commandLine.appendSwitch("disable-gpu-compositing");
  return { gpuDisabled: true };
}

const graphicsMode = configureGraphicsFallback();

function createWindow() {
  const win = new BrowserWindow({
    width: 1200,
    height: 800,
    webPreferences: {
      preload: path.join(__dirname, "preload.js"),
      contextIsolation: true,
      nodeIntegration: false,
    },
  });

  win.loadFile(path.join(__dirname, "renderer", "index.html"));
}

const BROWSE_TEXT_MAX = 750_000;
const BROWSE_IMAGE_MAX = 14 * 1024 * 1024;
const BROWSE_THUMB_MAX = 2 * 1024 * 1024;

function extToMime(extLower) {
  const m = {
    ".png": "image/png",
    ".jpg": "image/jpeg",
    ".jpeg": "image/jpeg",
    ".gif": "image/gif",
    ".webp": "image/webp",
    ".bmp": "image/bmp",
    ".svg": "image/svg+xml",
    ".ico": "image/x-icon",
  };
  return m[extLower] || "application/octet-stream";
}

async function resolveEntryUnderRoot(rootDir, inputPath) {
  const raw = String(inputPath || "").trim();
  if (!raw) {
    return null;
  }
  const candidate = path.isAbsolute(raw) ? path.normalize(raw) : path.resolve(rootDir, raw);
  if (!isPathInsideRoot(rootDir, candidate)) {
    return null;
  }
  try {
    const st = await fs.stat(candidate);
    return { fullPath: candidate, isDirectory: st.isDirectory(), size: st.size, mtimeMs: st.mtimeMs };
  } catch {
    return null;
  }
}

function createBrowseWindow(rootDir, targetPath, { layout = "detail", kind }) {
  const layoutNorm = layout === "grid" ? "grid" : "detail";
  const wide = kind === "dir" && layoutNorm === "grid";
  const win = new BrowserWindow({
    width: wide ? 1024 : 900,
    height: wide ? 780 : 680,
    webPreferences: {
      preload: path.join(__dirname, "preload.js"),
      contextIsolation: true,
      nodeIntegration: false,
    },
    title: path.basename(targetPath) || "OpenGraphXplorer",
  });

  win.loadFile(path.join(__dirname, "renderer", "browse-tab.html"), {
    query: {
      root: encodeURIComponent(rootDir),
      target: encodeURIComponent(targetPath),
      layout: layoutNorm,
      kind,
    },
  });
}

async function readJson(filePath, fallback) {
  try {
    const raw = await fs.readFile(filePath, "utf8");
    return JSON.parse(raw);
  } catch {
    return fallback;
  }
}

async function writeJson(filePath, value) {
  await fs.writeFile(filePath, `${JSON.stringify(value, null, 2)}\n`, "utf8");
}

function isPathInsideRoot(rootDir, targetPath) {
  const root = path.resolve(rootDir);
  const target = path.resolve(targetPath);
  if (target === root) {
    return true;
  }
  const sep = path.sep;
  const prefix = root.endsWith(sep) ? root : `${root}${sep}`;
  return target.startsWith(prefix);
}

const MD_EXT = new Set([".md", ".markdown", ".mdx"]);

const CSV_EXT = new Set([".csv", ".tsv"]);

const IPYNB_EXT = new Set([".ipynb"]);

const PDF_EXT = new Set([".pdf"]);

const IMAGE_EXT = new Set([".png", ".jpg", ".jpeg", ".gif", ".webp", ".bmp", ".svg", ".ico"]);

/** Extensions we always treat as UTF-8 text (no binary sniff). */
const ALWAYS_TEXT_EXT = new Set([
  ...MD_EXT,
  ...CSV_EXT,
  ...IPYNB_EXT,
  ".json", ".jsonl", ".txt", ".log", ".mdx",
  ".js", ".mjs", ".cjs", ".jsx", ".ts", ".tsx", ".vue", ".svelte",
  ".css", ".scss", ".less", ".html", ".htm", ".xml", ".svg",
  ".yaml", ".yml", ".toml", ".ini", ".cfg", ".conf", ".env",
  ".sh", ".bash", ".zsh", ".fish", ".py", ".rb", ".go", ".rs", ".java",
  ".c", ".h", ".cpp", ".hpp", ".cs", ".swift", ".kt", ".sql", ".graphql",
  ".gitignore", ".gitattributes", ".editorconfig",
]);

const pdfPreviewCache = new Map();

function escapeRegExp(s) {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function extractMarkdownSections(raw, names) {
  const out = {};
  for (const name of names) {
    if (!name || typeof name !== "string") {
      continue;
    }
    const re = new RegExp(`^##\\s+${escapeRegExp(name.trim())}\\s*$`, "gim");
    const m = re.exec(raw);
    if (!m) {
      continue;
    }
    const start = m.index + m[0].length;
    const rest = raw.slice(start);
    const nextHeader = rest.search(/^##\s+/m);
    const chunk = nextHeader === -1 ? rest : rest.slice(0, nextHeader);
    out[name.trim()] = chunk.replace(/^\s+/, "").replace(/\s+$/, "");
  }
  return out;
}

function parseMarkdownPreview(raw) {
  const titleMatch = raw.match(/^#\s+(.+)$/m);
  const title = titleMatch ? titleMatch[1].trim() : "";

  let abstract = "";
  const abstractRe = /^##\s+abstract\s*$/gim;
  const m = abstractRe.exec(raw);
  if (m) {
    const start = m.index + m[0].length;
    const rest = raw.slice(start);
    const nextHeader = rest.search(/^##\s+/m);
    const chunk = nextHeader === -1 ? rest : rest.slice(0, nextHeader);
    abstract = chunk.replace(/^\s+/, "").replace(/\s+$/, "");
  }

  let imageRef = null;
  const mdImg = raw.match(/!\[[^\]]*]\(\s*([^)]+?)\s*\)/);
  if (mdImg) {
    imageRef = mdImg[1].trim().replace(/^<|>$/g, "");
  } else {
    const htmlImg = raw.match(/<img[^>]+src=["']([^"']+)["']/i);
    if (htmlImg) {
      imageRef = htmlImg[1].trim();
    }
  }

  return { title, abstract, imageRef };
}

function splitCsvLine(line) {
  return line.split(/,(?=(?:[^"]*"[^"]*")*[^"]*$)/).map((c) => c.trim().replace(/^"|"$/g, ""));
}

function splitDataLine(line, delimiter) {
  if (delimiter === "\t") {
    return line.split("\t").map((c) => c.trim());
  }
  return splitCsvLine(line);
}

function inferCellType(cell) {
  const s = String(cell).trim();
  if (s === "") {
    return "empty";
  }
  if (/^(true|false)$/i.test(s)) {
    return "bool";
  }
  if (/^-?\d+$/.test(s)) {
    return "int";
  }
  if (/^-?\d+\.\d+$|^[-+]?\d*\.?\d+e[-+]?\d+$/i.test(s)) {
    return "float";
  }
  if (/^\d{4}-\d{2}-\d{2}/.test(s) || /^\d{1,2}\/\d{1,2}\/\d{2,4}/.test(s)) {
    return "date?";
  }
  return "string";
}

function inferColumnTypes(columns, dataLines, delimiter) {
  const n = columns.length;
  if (n === 0) {
    return [];
  }
  const types = new Array(n).fill("string");
  const counts = columns.map(() => ({}));
  for (const line of dataLines) {
    if (!line.trim()) {
      continue;
    }
    const cells = splitDataLine(line, delimiter);
    for (let i = 0; i < n && i < cells.length; i++) {
      const t = inferCellType(cells[i]);
      counts[i][t] = (counts[i][t] || 0) + 1;
    }
  }
  for (let i = 0; i < n; i++) {
    const c = counts[i];
    const entries = Object.entries(c).filter(([k]) => k !== "empty");
    const best = (entries.length ? entries : Object.entries(c)).sort((a, b) => b[1] - a[1])[0];
    if (best) {
      types[i] = best[0] === "empty" ? "string" : best[0];
    }
  }
  return types;
}

function parseCsvSnippet(text, fileSize, extLower) {
  const delimiter = extLower === ".tsv" ? "\t" : ",";
  const lines = text.split(/\r?\n/);
  const nonEmpty = lines.filter((l) => l.trim() !== "");
  const headerLine = nonEmpty[0] || "";
  const columns = splitDataLine(headerLine, delimiter);
  const dataLines = nonEmpty.slice(1, 51);
  const columnTypes = inferColumnTypes(columns, dataLines, delimiter);
  const rowsInSnippet = Math.max(0, nonEmpty.length - 1);
  const snippetTruncated = text.length >= 65535 || fileSize > 65536;
  const shape = {
    cols: columns.length,
    rowsInSnippet,
    truncated: snippetTruncated,
    fileBytes: fileSize,
  };
  return { columns, columnTypes, shape, delimiter };
}

function extractMarkdownH1(raw, maxN) {
  const out = [];
  const re = /^#\s+(.+)$/gm;
  let m;
  while ((m = re.exec(raw)) !== null && out.length < maxN) {
    out.push(m[1].trim());
  }
  return out;
}

function parseIpynbCheap(text) {
  try {
    const j = JSON.parse(text);
    const cells = Array.isArray(j.cells) ? j.cells : [];
    const nbformat =
      j.nbformat != null ? `${j.nbformat}.${j.nbformat_minor != null ? j.nbformat_minor : 0}` : "?";
    const language =
      (j.metadata && j.metadata.kernelspec && j.metadata.kernelspec.language) ||
      (j.metadata && j.metadata.language_info && j.metadata.language_info.name) ||
      "";
    return { cellCount: cells.length, nbformat, language: String(language) };
  } catch {
    return null;
  }
}

function bufferLooksBinary(buf) {
  const len = Math.min(buf.length, 8000);
  for (let i = 0; i < len; i++) {
    if (buf[i] === 0) {
      return true;
    }
  }
  return false;
}

function formatBytes(n) {
  if (n < 1024) {
    return `${n} B`;
  }
  if (n < 1024 * 1024) {
    return `${(n / 1024).toFixed(1)} KB`;
  }
  if (n < 1024 * 1024 * 1024) {
    return `${(n / (1024 * 1024)).toFixed(1)} MB`;
  }
  return `${(n / (1024 * 1024 * 1024)).toFixed(1)} GB`;
}

function normalizePdfText(text) {
  return String(text || "")
    .replace(/\r/g, "")
    .replace(/\u0000/g, "")
    .replace(/[ \t]+\n/g, "\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

async function extractPdfPreview(fullPath) {
  const stat = await fs.stat(fullPath);
  const cached = pdfPreviewCache.get(fullPath);
  if (cached && cached.mtimeMs === stat.mtimeMs && cached.sizeBytes === stat.size) {
    return cached.data;
  }

  const data = await fs.readFile(fullPath);
  const parser = new PDFParse({ data });
  try {
    const info = await parser.getInfo().catch(() => null);
    const textResult = await parser.getText().catch(() => null);
    const preview = {
      pageCount: info && Number.isFinite(info.total) ? info.total : null,
      text: normalizePdfText(textResult && textResult.text),
      sizeBytes: stat.size,
    };
    pdfPreviewCache.set(fullPath, { mtimeMs: stat.mtimeMs, sizeBytes: stat.size, data: preview });
    return preview;
  } finally {
    await parser.destroy().catch(() => {});
  }
}

async function getFileCardPreview(rootDir, fullPath, sectionNames = []) {
  if (!rootDir || !fullPath) {
    return { ok: false, error: "missing path" };
  }
  if (!isPathInsideRoot(rootDir, fullPath)) {
    return { ok: false, error: "outside root" };
  }

  let stat;
  try {
    stat = await fs.stat(fullPath);
  } catch {
    return { ok: false, error: "not found" };
  }
  if (!stat.isFile()) {
    return { ok: false, error: "not a file" };
  }

  const baseName = path.basename(fullPath);
  const ext = path.extname(fullPath).toLowerCase();

  if (PDF_EXT.has(ext)) {
    try {
      const pdf = await extractPdfPreview(fullPath);
      return {
        ok: true,
        kind: "pdf",
        name: baseName,
        ext,
        sizeBytes: stat.size,
        pageCount: pdf.pageCount,
      };
    } catch (err) {
      return {
        ok: true,
        kind: "binary",
        name: baseName,
        ext,
        sizeBytes: stat.size,
        sizeLabel: formatBytes(stat.size),
        error: String(err && err.message ? err.message : err),
      };
    }
  }

  if (IMAGE_EXT.has(ext)) {
    return {
      ok: true,
      kind: "image",
      name: baseName,
      ext,
      sizeBytes: stat.size,
      imageUrl: pathToFileURL(fullPath).href,
    };
  }

  if (CSV_EXT.has(ext)) {
    const sn = await readFileSnippet(rootDir, fullPath, 65536);
    if (!sn.ok) {
      return { ok: false, error: sn.error };
    }
    const parsed = parseCsvSnippet(sn.text, stat.size, ext);
    return {
      ok: true,
      kind: "csv",
      name: baseName,
      ext,
      columns: parsed.columns,
      columnTypes: parsed.columnTypes,
      shape: parsed.shape,
    };
  }

  if (IPYNB_EXT.has(ext)) {
    const maxBytes = Math.min(1024 * 1024, stat.size);
    const handle = await fs.open(fullPath, "r");
    let text = "";
    try {
      const buf = Buffer.alloc(maxBytes);
      const { bytesRead } = await handle.read(buf, 0, maxBytes, 0);
      text = buf.slice(0, bytesRead).toString("utf8");
    } finally {
      await handle.close();
    }
    const nb = parseIpynbCheap(text);
    if (!nb) {
      return { ok: true, kind: "text", name: baseName, ext, sizeBytes: stat.size };
    }
    return {
      ok: true,
      kind: "notebook",
      name: baseName,
      ext,
      sizeBytes: stat.size,
      cellCount: nb.cellCount,
      nbformat: nb.nbformat,
      language: nb.language,
    };
  }

  if (MD_EXT.has(ext)) {
    const maxBytes = 256 * 1024;
    const handle = await fs.open(fullPath, "r");
    try {
      const buf = Buffer.alloc(maxBytes);
      const { bytesRead } = await handle.read(buf, 0, maxBytes, 0);
      const raw = buf.slice(0, bytesRead).toString("utf8");
      const parsed = parseMarkdownPreview(raw);
      const h1Headings = extractMarkdownH1(raw, 10);
      const sections =
        Array.isArray(sectionNames) && sectionNames.length > 0
          ? extractMarkdownSections(raw, sectionNames)
          : {};
      let imageUrl = null;
      if (parsed.imageRef && !/^https?:\/\//i.test(parsed.imageRef)) {
        let absImage;
        if (parsed.imageRef.startsWith("file:")) {
          try {
            absImage = fileURLToPath(parsed.imageRef);
          } catch {
            absImage = null;
          }
        } else {
          absImage = path.resolve(path.dirname(fullPath), parsed.imageRef);
        }
        if (absImage && isPathInsideRoot(rootDir, absImage)) {
          try {
            const st = await fs.stat(absImage);
            if (st.isFile()) {
              imageUrl = pathToFileURL(absImage).href;
            }
          } catch {
            /* ignore missing image */
          }
        }
      }

      return {
        ok: true,
        kind: "markdown",
        name: baseName,
        title: parsed.title || baseName.replace(/\.(md|markdown|mdx)$/i, ""),
        h1Headings,
        abstract: parsed.abstract,
        imageUrl,
        sections,
      };
    } finally {
      await handle.close();
    }
  }

  if (!ALWAYS_TEXT_EXT.has(ext)) {
    const peek = Math.min(8192, stat.size);
    const handle = await fs.open(fullPath, "r");
    try {
      const buf = Buffer.alloc(peek);
      await handle.read(buf, 0, peek, 0);
      if (bufferLooksBinary(buf)) {
        return {
          ok: true,
          kind: "binary",
          name: baseName,
          ext,
          sizeBytes: stat.size,
          sizeLabel: formatBytes(stat.size),
        };
      }
    } finally {
      await handle.close();
    }
  }

  return {
    ok: true,
    kind: "text",
    name: baseName,
    ext,
    sizeBytes: stat.size,
  };
}

const LIST_ITEMS_MAX = 20000;

async function listItems(rootDir) {
  const items = [];
  let limited = false;
  const ignoredNames = new Set([TAGS_FILE, CARDS_FILE, "node_modules", ".git"]);

  async function walk(dir) {
    if (limited) return;
    let entries;
    try {
      entries = await fs.readdir(dir, { withFileTypes: true });
    } catch {
      return; // unreadable directory — skip
    }
    for (const entry of entries) {
      if (limited) return;
      if (entry.name.startsWith(".") || ignoredNames.has(entry.name)) continue;
      const fullPath = path.join(dir, entry.name);
      const relPath = path.relative(rootDir, fullPath);
      const type = entry.isDirectory() ? "folder" : "file";
      let size = 0, mtimeMs = 0;
      try { const st = await fs.stat(fullPath); size = st.size; mtimeMs = st.mtimeMs; } catch { /* skip */ }
      items.push({ name: entry.name, relPath, type, fullPath, size, mtimeMs });
      if (items.length >= LIST_ITEMS_MAX) {
        limited = true;
        return;
      }
      if (entry.isDirectory()) {
        await walk(fullPath);
      }
    }
  }

  await walk(rootDir);
  return { items, limited };
}

ipcMain.handle("pick-root", async () => {
  const result = await dialog.showOpenDialog({
    properties: ["openDirectory"],
  });

  if (result.canceled || !result.filePaths[0]) {
    return null;
  }

  return result.filePaths[0];
});

ipcMain.handle("get-testenv-path", async () => {
  const testEnvPath = path.join(app.getAppPath(), "testenv");
  try {
    await fs.access(testEnvPath);
    return testEnvPath;
  } catch {
    return null;
  }
});

ipcMain.handle("resolve-dir", async (_event, inputPath, basePath) => {
  try {
    const candidate = path.isAbsolute(inputPath)
      ? inputPath
      : path.resolve(basePath || app.getAppPath(), inputPath);
    const stats = await fs.stat(candidate);
    if (!stats.isDirectory()) {
      return null;
    }
    return candidate;
  } catch {
    return null;
  }
});

ipcMain.handle("load-data", async (_event, rootDir) => {
  const tagsPath = path.join(rootDir, TAGS_FILE);
  const tags = await readJson(tagsPath, {});
  const { items, limited } = await listItems(rootDir);
  return { items, tags, limited };
});

const HISTORY_FILE = ".ogx-history.log";

ipcMain.handle("append-history", async (_event, rootDir, lines) => {
  if (!rootDir || !Array.isArray(lines) || !lines.length) return false;
  const histPath = path.join(rootDir, HISTORY_FILE);
  const stamp = new Date().toISOString();
  const block = lines.map((l) => `${stamp}  ${l}`).join("\n") + "\n";
  try {
    await fs.appendFile(histPath, block, "utf8");
    return true;
  } catch {
    return false;
  }
});

ipcMain.handle("save-tags", async (_event, rootDir, tags) => {
  const tagsPath = path.join(rootDir, TAGS_FILE);
  await writeJson(tagsPath, tags);
  return true;
});

ipcMain.handle("load-concepts", async (_event, rootDir) => {
  const conceptsPath = path.join(rootDir, CONCEPTS_FILE);
  return readJson(conceptsPath, { concepts: {}, edges: [] });
});

ipcMain.handle("save-concepts", async (_event, rootDir, data) => {
  const conceptsPath = path.join(rootDir, CONCEPTS_FILE);
  await writeJson(conceptsPath, data);
  return true;
});

ipcMain.handle("load-media-index", async (_event, rootDir) => {
  const mediaIndexPath = path.join(rootDir, MEDIA_INDEX_FILE);
  return readJson(mediaIndexPath, { files: {} });
});

ipcMain.handle("save-media-index", async (_event, rootDir, data) => {
  const mediaIndexPath = path.join(rootDir, MEDIA_INDEX_FILE);
  await writeJson(mediaIndexPath, data);
  return true;
});

ipcMain.handle("load-cards", async (_event, folderPath) => {
  const cardsPath = path.join(folderPath, CARDS_FILE);
  const cards = await readJson(cardsPath, []);
  return cards;
});

ipcMain.handle("save-cards", async (_event, folderPath, cards) => {
  const cardsPath = path.join(folderPath, CARDS_FILE);
  await writeJson(cardsPath, cards);
  return true;
});

ipcMain.handle("file-card-preview", async (_event, rootDir, fullPath, sectionNames) => {
  return getFileCardPreview(rootDir, fullPath, sectionNames);
});

ipcMain.handle("graph-context-menu", async (event, { x, y, nodeId, pinned }) => {
  const win = BrowserWindow.fromWebContents(event.sender);
  if (!win) {
    return null;
  }
  return new Promise((resolve) => {
    let settled = false;
    const finish = (v) => {
      if (settled) {
        return;
      }
      settled = true;
      resolve(v);
    };
    const menu = Menu.buildFromTemplate([
      {
        label: pinned ? "Unpin node (physics)" : "Pin node (physics)",
        click: () => finish({ action: "togglePin", nodeId }),
      },
      { type: "separator" },
      { label: "Cancel", click: () => finish(null) },
    ]);
    menu.popup({
      window: win,
      x: Math.round(x),
      y: Math.round(y),
      callback: () => {
        setTimeout(() => finish(null), 40);
      },
    });
  });
});

function splitHeadTailLines(lines, headN, tailN) {
  const h = Math.max(0, headN | 0);
  const t = Math.max(0, tailN | 0);
  if (lines.length <= h + t) {
    return { head: lines.join("\n"), tail: "", merged: true };
  }
  return {
    head: lines.slice(0, h).join("\n"),
    tail: t > 0 ? lines.slice(-t).join("\n") : "",
    merged: false,
  };
}

async function readFileHeadTail(rootDir, fullPath, headN, tailN) {
  if (!rootDir || !fullPath) {
    return { ok: false, error: "missing path" };
  }
  if (!isPathInsideRoot(rootDir, fullPath)) {
    return { ok: false, error: "outside root" };
  }

  let stat;
  try {
    stat = await fs.stat(fullPath);
  } catch {
    return { ok: false, error: "not found" };
  }
  if (!stat.isFile()) {
    return { ok: false, error: "not a file" };
  }

  const ext = path.extname(fullPath).toLowerCase();
  if (PDF_EXT.has(ext)) {
    try {
      const pdf = await extractPdfPreview(fullPath);
      const lines = (pdf.text || "").split(/\r?\n/);
      const { head, tail, merged } = splitHeadTailLines(lines, headN, tailN);
      return { ok: true, head, tail, merged, truncated: false };
    } catch (err) {
      return { ok: false, error: String(err && err.message ? err.message : err) };
    }
  }

  const maxBytes = 2 * 1024 * 1024;
  if (stat.size <= maxBytes) {
    const raw = await fs.readFile(fullPath, "utf8");
    const lines = raw.split(/\r?\n/);
    const { head, tail, merged } = splitHeadTailLines(lines, headN, tailN);
    return { ok: true, head, tail, merged, truncated: false };
  }

  const headRead = Math.min(256 * 1024, stat.size);
  const handle = await fs.open(fullPath, "r");
  try {
    const headBuf = Buffer.alloc(headRead);
    await handle.read(headBuf, 0, headRead, 0);
    const headText = headBuf.toString("utf8");
    const headLines = headText.split(/\r?\n/);
    const head = headLines.slice(0, headN).join("\n");

    const tailLen = Math.min(256 * 1024, stat.size);
    const tailBuf = Buffer.alloc(tailLen);
    await handle.read(tailBuf, 0, tailLen, stat.size - tailLen);
    const tailText = tailBuf.toString("utf8");
    const tailLines = tailText.split(/\r?\n/);
    const tail = tailN > 0 ? tailLines.slice(-tailN).join("\n") : "";

    return { ok: true, head, tail, merged: false, truncated: true };
  } finally {
    await handle.close();
  }
}

ipcMain.handle("file-head-tail", async (_event, rootDir, fullPath, headN, tailN) => {
  return readFileHeadTail(rootDir, fullPath, headN, tailN);
});

async function readFileSnippet(rootDir, fullPath, maxBytes) {
  if (!rootDir || !fullPath || !isPathInsideRoot(rootDir, fullPath)) {
    return { ok: false, error: "bad path" };
  }
  let stat;
  try {
    stat = await fs.stat(fullPath);
  } catch {
    return { ok: false, error: "not found" };
  }
  if (!stat.isFile()) {
    return { ok: false, error: "not a file" };
  }
  const ext = path.extname(fullPath).toLowerCase();
  if (PDF_EXT.has(ext)) {
    try {
      const pdf = await extractPdfPreview(fullPath);
      const limit = Math.max(0, maxBytes || 262144);
      return { ok: true, text: limit ? (pdf.text || "").slice(0, limit) : "" };
    } catch (err) {
      return { ok: false, error: String(err && err.message ? err.message : err) };
    }
  }
  const n = Math.min(maxBytes || 262144, stat.size);
  const buf = Buffer.alloc(n);
  const handle = await fs.open(fullPath, "r");
  try {
    await handle.read(buf, 0, n, 0);
  } finally {
    await handle.close();
  }
  return { ok: true, text: buf.toString("utf8") };
}

ipcMain.handle("file-snippet", async (_event, rootDir, fullPath, maxBytes) => {
  return readFileSnippet(rootDir, fullPath, maxBytes);
});

// Batch-read text content for content-filter cache.
// Returns Map-serialisable array: [[relPath, text], ...] for files that are readable text.
// Binary files and read errors are silently skipped (no entry returned).
ipcMain.handle("read-files-batch", async (_event, rootDir, relPaths) => {
  const CONTENT_MAX = 512 * 1024; // 512 KB per file cap for content index
  const results = [];
  await Promise.all(
    relPaths.map(async (rel) => {
      const full = path.join(rootDir, rel);
      try {
        const sn = await readFileSnippet(rootDir, full, CONTENT_MAX);
        if (sn.ok && typeof sn.text === "string") {
          results.push([rel, sn.text]);
        }
      } catch { /* skip unreadable */ }
    })
  );
  return results;
});

async function csvPreview(rootDir, fullPath) {
  const sn = await readFileSnippet(rootDir, fullPath, 65536);
  if (!sn.ok) {
    return sn;
  }
  let stat;
  try {
    stat = await fs.stat(fullPath);
  } catch {
    return { ok: false, error: "not found" };
  }
  const ext = path.extname(fullPath).toLowerCase();
  const parsed = parseCsvSnippet(sn.text, stat.size, ext);
  return {
    ok: true,
    header: parsed.columns.join(","),
    sampleRow: "",
    columnCount: parsed.shape.cols,
    columns: parsed.columns,
    columnTypes: parsed.columnTypes,
    shape: parsed.shape,
  };
}

ipcMain.handle("csv-preview", async (_event, rootDir, fullPath) => {
  return csvPreview(rootDir, fullPath);
});

async function grepInFile(rootDir, fullPath, pattern, maxBytes) {
  const sn = await readFileSnippet(rootDir, fullPath, maxBytes || 262144);
  if (!sn.ok) {
    return sn;
  }
  let re;
  try {
    re = new RegExp(pattern, "im");
  } catch {
    return { ok: false, error: "invalid regex" };
  }
  const lines = sn.text.split(/\r?\n/);
  const out = [];
  for (const line of lines) {
    if (line.match(re)) {
      out.push(line);
    }
  }
  return { ok: true, lines: out.slice(0, 400).join("\n"), matchCount: out.length };
}

ipcMain.handle("grep-file", async (_event, rootDir, fullPath, pattern, maxBytes) => {
  return grepInFile(rootDir, fullPath, pattern, maxBytes);
});

const CONTENT_LINK_MAX_BYTES = 32768;

function extractImportPaths(text, ext) {
  const imports = new Set();
  if ([".js", ".mjs", ".cjs", ".jsx", ".ts", ".tsx"].includes(ext)) {
    const esRe = /\bimport\s+(?:[^'"\n]*?from\s+)?['"]([^'"]+)['"]/g;
    const cjsRe = /\brequire\s*\(\s*['"]([^'"]+)['"]\s*\)/g;
    let m;
    while ((m = esRe.exec(text)) !== null) imports.add(m[1]);
    while ((m = cjsRe.exec(text)) !== null) imports.add(m[1]);
  } else if (ext === ".py") {
    const pyRe = /^(?:from|import)\s+([\w.]+)/gm;
    let m;
    while ((m = pyRe.exec(text)) !== null) imports.add(m[1]);
  } else if (ext === ".go") {
    const goRe = /"([^"]+)"/g;
    let m;
    // only inside import blocks — cheap heuristic: extract all quoted strings, filter by path look
    while ((m = goRe.exec(text)) !== null) {
      if (m[1].includes("/") && !m[1].includes(" ")) imports.add(m[1]);
    }
  }
  // Normalize to bare module name (drop leading relative/absolute indicators)
  return [...imports]
    .map((s) => s.replace(/^[./\\]+/, "").replace(/\\/g, "/").toLowerCase())
    .filter(Boolean);
}

function extractMarkdownRefNames(text) {
  const refs = new Set();
  const wikiRe = /\[\[([^\]|#\n]+?)(?:\|[^\]]+)?\]\]/g;
  const mdLinkRe = /\[[^\]]*\]\(([^)#?\n]+)\)/g;
  let m;
  while ((m = wikiRe.exec(text)) !== null) {
    refs.add(m[1].trim().toLowerCase());
  }
  while ((m = mdLinkRe.exec(text)) !== null) {
    const ref = m[1].trim();
    if (!ref.startsWith("http") && !ref.startsWith("//") && !ref.startsWith("mailto:")) {
      refs.add(path.basename(ref, path.extname(ref)).toLowerCase());
    }
  }
  return [...refs];
}

ipcMain.handle("build-content-links", async (_event, { rootDir, files, strategy, pattern }) => {
  if (!rootDir || !Array.isArray(files) || !files.length) {
    return { ok: false, error: "missing args" };
  }

  // Limit to files inside root
  const safeFiles = files.filter(
    (f) => f && f.fullPath && isPathInsideRoot(rootDir, f.fullPath),
  );

  const links = [];
  const seen = new Set();

  function addLink(a, b, kind) {
    const key = a < b ? `${a}\x00${b}` : `${b}\x00${a}`;
    if (!seen.has(key)) {
      seen.add(key);
      links.push({ a, b, kind });
    }
  }

  // Hub-and-spoke within a group: first node as hub (up to 5 spokes), then chain rest
  function linkGroup(group, kind) {
    if (group.length < 2) return;
    const HUB = 5;
    for (let i = 1; i < Math.min(HUB + 1, group.length); i++) {
      addLink(group[0], group[i], kind);
    }
    for (let i = 1; i < group.length - 1; i++) {
      addLink(group[i], group[i + 1], kind);
    }
  }

  try {
    if (strategy === "grep") {
      if (!pattern) return { ok: false, error: "grep: pattern required" };
      let re;
      try {
        re = new RegExp(pattern, "im");
      } catch {
        return { ok: false, error: "grep: invalid regex" };
      }
      const matched = [];
      for (const file of safeFiles) {
        const sn = await readFileSnippet(rootDir, file.fullPath, CONTENT_LINK_MAX_BYTES);
        if (!sn.ok) continue;
        if (re.test(sn.text)) matched.push(file.relPath);
      }
      linkGroup(matched, "grep");
      return { ok: true, links, matched };
    }

    if (strategy === "imports") {
      const importsByFile = new Map();
      for (const file of safeFiles) {
        const ext = path.extname(file.fullPath).toLowerCase();
        const supported = [".js", ".mjs", ".cjs", ".jsx", ".ts", ".tsx", ".py", ".go"];
        if (!supported.includes(ext)) continue;
        const sn = await readFileSnippet(rootDir, file.fullPath, CONTENT_LINK_MAX_BYTES);
        if (!sn.ok) continue;
        const imports = extractImportPaths(sn.text, ext);
        if (imports.length) importsByFile.set(file.relPath, imports);
      }
      const byImport = new Map();
      for (const [relPath, imports] of importsByFile) {
        for (const imp of imports) {
          if (!byImport.has(imp)) byImport.set(imp, []);
          byImport.get(imp).push(relPath);
        }
      }
      for (const [, group] of byImport) {
        linkGroup(group, "imports");
      }
      return { ok: true, links };
    }

    if (strategy === "refs") {
      // Build a lookup: normalized basename → [relPath, ...]
      const byBasename = new Map();
      for (const file of safeFiles) {
        const base = path.basename(file.relPath, path.extname(file.relPath)).toLowerCase();
        if (!byBasename.has(base)) byBasename.set(base, []);
        byBasename.get(base).push(file.relPath);
      }
      for (const file of safeFiles) {
        const ext = path.extname(file.fullPath).toLowerCase();
        if (ext !== ".md" && ext !== ".markdown" && ext !== ".mdx" && ext !== ".txt") continue;
        const sn = await readFileSnippet(rootDir, file.fullPath, CONTENT_LINK_MAX_BYTES * 2);
        if (!sn.ok) continue;
        const refNames = extractMarkdownRefNames(sn.text);
        for (const ref of refNames) {
          const targets = byBasename.get(ref) || [];
          for (const target of targets) {
            if (target !== file.relPath) addLink(file.relPath, target, "refs");
          }
        }
      }
      return { ok: true, links };
    }

    return { ok: false, error: `unknown strategy: ${strategy}` };
  } catch (err) {
    return { ok: false, error: String(err.message || err) };
  }
});

async function buildBrowseFilePayload(rootDir, fullPath) {
  const ext = path.extname(fullPath).toLowerCase();
  const name = path.basename(fullPath);
  if (PDF_EXT.has(ext)) {
    try {
      const pdf = await extractPdfPreview(fullPath);
      const text = pdf.text || "";
      const truncated = text.length > BROWSE_TEXT_MAX;
      return {
        ok: true,
        mode: "file",
        variant: "pdf",
        name,
        pdfUrl: pathToFileURL(fullPath).href,
        text: truncated ? text.slice(0, BROWSE_TEXT_MAX) : text,
        truncated,
        pageCount: pdf.pageCount,
        size: pdf.sizeBytes,
        fullPath,
      };
    } catch {
      const st = await fs.stat(fullPath);
      return { ok: true, mode: "file", variant: "binary", name, size: st.size, fullPath };
    }
  }
  if (IMAGE_EXT.has(ext)) {
    const st = await fs.stat(fullPath);
    if (st.size > BROWSE_IMAGE_MAX) {
      return {
        ok: true,
        mode: "file",
        variant: "image-too-large",
        name,
        size: st.size,
        fullPath,
      };
    }
    try {
      const buf = await fs.readFile(fullPath);
      const mime = extToMime(ext);
      return {
        ok: true,
        mode: "file",
        variant: "image",
        name,
        dataUrl: `data:${mime};base64,${buf.toString("base64")}`,
        fullPath,
      };
    } catch {
      return { ok: true, mode: "file", variant: "binary", name, size: st.size, fullPath };
    }
  }
  if (ALWAYS_TEXT_EXT.has(ext)) {
    let buf;
    try {
      buf = await fs.readFile(fullPath);
    } catch {
      return { ok: true, mode: "file", variant: "binary", name, fullPath };
    }
    let text;
    try {
      text = buf.toString("utf8");
    } catch {
      return { ok: true, mode: "file", variant: "binary", name, fullPath };
    }
    const truncated = text.length > BROWSE_TEXT_MAX;
    if (truncated) {
      text = text.slice(0, BROWSE_TEXT_MAX);
    }
    return { ok: true, mode: "file", variant: "text", name, text, truncated, fullPath };
  }
  const st = await fs.stat(fullPath);
  return { ok: true, mode: "file", variant: "binary", name, size: st.size, fullPath };
}

async function buildBrowseDirPayload(rootDir, dirPath, layout) {
  const dirents = await fs.readdir(dirPath, { withFileTypes: true });
  const entries = [];
  for (const d of dirents) {
    const full = path.join(dirPath, d.name);
    if (!isPathInsideRoot(rootDir, full)) {
      continue;
    }
    let size = 0;
    let mtimeMs = 0;
    let isDirectory = d.isDirectory();
    try {
      const st = await fs.stat(full);
      size = st.size;
      mtimeMs = st.mtimeMs;
      isDirectory = st.isDirectory();
    } catch {
      continue;
    }
    const ext = path.extname(d.name).toLowerCase();
    const isImage = !isDirectory && IMAGE_EXT.has(ext);
    entries.push({
      name: d.name,
      fullPath: full,
      relPath: path.relative(rootDir, full).split(path.sep).join("/"),
      isDirectory,
      size,
      mtimeMs,
      isImage,
    });
  }
  entries.sort((a, b) => {
    if (a.isDirectory !== b.isDirectory) {
      return a.isDirectory ? -1 : 1;
    }
    return a.name.localeCompare(b.name);
  });
  return {
    ok: true,
    mode: "dir",
    layout: layout === "grid" ? "grid" : "detail",
    fullPath: dirPath,
    relDisplay: path.relative(rootDir, dirPath).split(path.sep).join("/") || ".",
    entries,
  };
}

ipcMain.handle("open-browse-tab", async (_e, payload) => {
  const rootDir = payload?.rootDir;
  const inputPath = String(payload?.inputPath || "").trim();
  const layoutIn = payload?.layout === "grid" ? "grid" : "detail";
  const forceKind = payload?.forceKind;
  if (!rootDir) {
    return { ok: false, error: "no root loaded" };
  }
  if (!inputPath) {
    return { ok: false, error: "missing path" };
  }
  const resolved = await resolveEntryUnderRoot(rootDir, inputPath);
  if (!resolved) {
    return { ok: false, error: "path not found or outside root" };
  }
  let kind = resolved.isDirectory ? "dir" : "file";
  if (forceKind === "dir") {
    if (!resolved.isDirectory) {
      return { ok: false, error: "not a directory (use open <file> for files)" };
    }
    kind = "dir";
  } else if (forceKind === "file") {
    if (resolved.isDirectory) {
      return { ok: false, error: "path is a directory — use: open dir <path>" };
    }
    kind = "file";
  }
  const layout = kind === "dir" ? layoutIn : "detail";
  if (payload.embed) {
    return { ok: true, fullPath: resolved.fullPath, kind, layout };
  }
  createBrowseWindow(rootDir, resolved.fullPath, { layout, kind });
  return { ok: true };
});

ipcMain.handle("browse-tab-load", async (_e, { rootDir, targetPath, layout, kind }) => {
  if (!rootDir || !targetPath) {
    return { ok: false, error: "missing path" };
  }
  const normTarget = path.normalize(targetPath);
  if (!isPathInsideRoot(rootDir, normTarget)) {
    return { ok: false, error: "outside root" };
  }
  let st;
  try {
    st = await fs.stat(normTarget);
  } catch {
    return { ok: false, error: "not found" };
  }
  const isDir = st.isDirectory();
  if (kind === "file" && isDir) {
    return { ok: false, error: "expected file" };
  }
  if (kind === "dir" && !isDir) {
    return { ok: false, error: "expected directory" };
  }
  if (isDir) {
    return buildBrowseDirPayload(rootDir, normTarget, layout === "grid" ? "grid" : "detail");
  }
  return buildBrowseFilePayload(rootDir, normTarget);
});

ipcMain.handle("browse-tab-thumb", async (_e, { rootDir, fullPath }) => {
  const norm = path.normalize(fullPath);
  if (!isPathInsideRoot(rootDir, norm)) {
    return { ok: false };
  }
  const ext = path.extname(norm).toLowerCase();
  if (!IMAGE_EXT.has(ext)) {
    return { ok: false, skip: true };
  }
  let st;
  try {
    st = await fs.stat(norm);
  } catch {
    return { ok: false };
  }
  if (!st.isFile() || st.size === 0) {
    return { ok: false };
  }
  if (st.size > BROWSE_THUMB_MAX) {
    return { ok: false, skip: true, reason: "large" };
  }
  const buf = await fs.readFile(norm);
  const mime = extToMime(ext);
  return { ok: true, dataUrl: `data:${mime};base64,${buf.toString("base64")}` };
});

ipcMain.handle("open-path-external", async (_e, fullPath) => {
  const p = path.normalize(String(fullPath || ""));
  try {
    await fs.access(p);
  } catch {
    return { ok: false, error: "not found" };
  }
  const err = await shell.openPath(p);
  return { ok: !err, error: err || null };
});

ipcMain.handle("reader-selection-save-copy", async (_e, { rootDir, destRel, relPaths }) => {
  if (!rootDir || destRel == null || !Array.isArray(relPaths)) {
    return { ok: false, error: "bad args" };
  }
  const destDir = path.resolve(rootDir, String(destRel).trim());
  if (!isPathInsideRoot(rootDir, destDir)) {
    return { ok: false, error: "dest outside root" };
  }
  await fs.mkdir(destDir, { recursive: true });
  let copied = 0;
  for (const rel of relPaths) {
    const src = path.resolve(rootDir, String(rel));
    if (!isPathInsideRoot(rootDir, src)) {
      continue;
    }
    let st;
    try {
      st = await fs.stat(src);
    } catch {
      continue;
    }
    if (!st.isFile()) {
      continue;
    }
    let base = path.basename(src);
    let out = path.join(destDir, base);
    let c = 0;
    for (;;) {
      try {
        await fs.access(out);
        c += 1;
        const ext = path.extname(base);
        const stem = ext ? base.slice(0, -ext.length) : base;
        base = ext ? `${stem}_${c}${ext}` : `${base}_${c}`;
        out = path.join(destDir, base);
      } catch {
        break;
      }
    }
    try {
      await fs.copyFile(src, out);
      copied += 1;
    } catch {
      /* skip */
    }
  }
  return { ok: true, copied };
});

ipcMain.handle("reader-selection-save-list", async (_e, { rootDir, destRel, lines }) => {
  if (!rootDir || destRel == null || !Array.isArray(lines)) {
    return { ok: false, error: "bad args" };
  }
  const full = path.resolve(rootDir, String(destRel).trim());
  if (!isPathInsideRoot(rootDir, full)) {
    return { ok: false, error: "outside root" };
  }
  const dir = path.dirname(full);
  await fs.mkdir(dir, { recursive: true });
  const body = lines.map((l) => String(l).replace(/\r\n|\r|\n/g, " ")).join("\n");
  await fs.writeFile(full, `${body}\n`, "utf8");
  return { ok: true };
});

ipcMain.handle("browse-tab-parent", async (_e, { rootDir, dirPath }) => {
  if (!rootDir || !dirPath) {
    return { ok: false, parentPath: null };
  }
  const r = path.normalize(rootDir);
  const d = path.normalize(dirPath);
  if (d === r) {
    return { ok: true, parentPath: null };
  }
  const p = path.dirname(d);
  if (p === d || !isPathInsideRoot(rootDir, p)) {
    return { ok: true, parentPath: null };
  }
  return { ok: true, parentPath: p };
});

app.whenReady().then(() => {
  const userDataDir = path.join(app.getPath("temp"), "OpenGraphXplorer-user-data");
  app.setPath("userData", userDataDir);
  if (graphicsMode.gpuDisabled) {
    console.warn("[OpenGraphXplorer] GPU acceleration disabled; using software rendering.");
  }
  createWindow();
  app.on("activate", () => {
    if (BrowserWindow.getAllWindows().length === 0) {
      createWindow();
    }
  });
});

app.on("window-all-closed", () => {
  if (process.platform !== "darwin") {
    app.quit();
  }
});
