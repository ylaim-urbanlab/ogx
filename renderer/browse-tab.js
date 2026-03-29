/* global explorerApi */
(function () {
  const params = new URLSearchParams(window.location.search);
  function decQuery(v) {
    if (v == null || v === "") {
      return "";
    }
    try {
      return decodeURIComponent(v);
    } catch {
      return v;
    }
  }
  const rootDir = decQuery(params.get("root"));
  const targetPath = decQuery(params.get("target"));
  const layout = params.get("layout") === "grid" ? "grid" : "detail";
  const kind = params.get("kind") === "file" ? "file" : "dir";

  const pathLabel = document.getElementById("pathLabel");
  const actions = document.getElementById("actions");
  const main = document.getElementById("main");

  const api = window.explorerApi;
  if (!api || !rootDir || !targetPath) {
    main.innerHTML = '<p class="err">Missing browse parameters.</p>';
    return;
  }

  pathLabel.textContent = targetPath;

  function esc(s) {
    const d = document.createElement("div");
    d.textContent = s;
    return d.innerHTML;
  }

  function fmtSize(n) {
    if (n < 1024) {
      return `${n} B`;
    }
    if (n < 1024 * 1024) {
      return `${(n / 1024).toFixed(1)} KB`;
    }
    return `${(n / (1024 * 1024)).toFixed(1)} MB`;
  }

  function openEntry(entry, dirLayout) {
    if (entry.isDirectory) {
      void api.openBrowseTab({
        rootDir,
        inputPath: entry.fullPath,
        layout: dirLayout || "detail",
        forceKind: "dir",
      });
    } else {
      void api.openBrowseTab({
        rootDir,
        inputPath: entry.fullPath,
        forceKind: "file",
      });
    }
  }

  async function addDirActions(dirPath) {
    actions.innerHTML = "";
    const frag = document.createDocumentFragment();
    const pr = await api.browseTabParent({ rootDir, dirPath });
    if (pr.ok && pr.parentPath) {
      const up = document.createElement("button");
      up.type = "button";
      up.textContent = "Up";
      up.addEventListener("click", () => {
        void api.openBrowseTab({
          rootDir,
          inputPath: pr.parentPath,
          layout,
          forceKind: "dir",
        });
      });
      frag.appendChild(up);
    }
    if (layout === "grid") {
      const det = document.createElement("button");
      det.type = "button";
      det.textContent = "Detail list";
      det.addEventListener("click", () => {
        void api.openBrowseTab({ rootDir, inputPath: dirPath, layout: "detail", forceKind: "dir" });
      });
      frag.appendChild(det);
    } else {
      const gr = document.createElement("button");
      gr.type = "button";
      gr.textContent = "Image grid";
      gr.addEventListener("click", () => {
        void api.openBrowseTab({ rootDir, inputPath: dirPath, layout: "grid", forceKind: "dir" });
      });
      frag.appendChild(gr);
    }
    actions.appendChild(frag);
  }

  async function renderDir(data) {
    pathLabel.textContent = data.relDisplay || data.fullPath;
    await addDirActions(data.fullPath);

    const entries = data.entries || [];
    if (!entries.length) {
      main.innerHTML = '<p class="err">Empty folder.</p>';
      return;
    }

    if (layout === "grid") {
      const images = entries.filter((e) => !e.isDirectory && e.isImage);
      const other = entries.filter((e) => e.isDirectory || !e.isImage);

      if (images.length) {
        const h = document.createElement("h2");
        h.className = "section";
        h.textContent = "Images";
        main.appendChild(h);
        const grid = document.createElement("div");
        grid.className = "grid";
        main.appendChild(grid);
        for (const e of images) {
          const tile = document.createElement("div");
          tile.className = "tile";
          tile.addEventListener("click", () => openEntry(e, layout));
          const img = document.createElement("img");
          img.alt = e.name;
          const cap = document.createElement("div");
          cap.className = "cap";
          cap.textContent = e.name;
          tile.appendChild(img);
          tile.appendChild(cap);
          grid.appendChild(tile);
          void api.browseTabThumb({ rootDir, fullPath: e.fullPath }).then((r) => {
            if (r.ok && r.dataUrl) {
              img.src = r.dataUrl;
            } else {
              const ph = document.createElement("div");
              ph.className = "ph";
              ph.textContent = r.reason === "large" ? "Large" : "Open";
              img.replaceWith(ph);
            }
          });
        }
      }

      if (other.length) {
        const h2 = document.createElement("h2");
        h2.className = "section";
        h2.textContent = "Folders & files";
        main.appendChild(h2);
        const tbl = document.createElement("table");
        tbl.className = "detail";
        tbl.innerHTML =
          "<thead><tr><th>Name</th><th>Size</th></tr></thead><tbody></tbody>";
        const tb = tbl.querySelector("tbody");
        for (const e of other) {
          const tr = document.createElement("tr");
          tr.innerHTML = `<td>${esc(e.name)}${e.isDirectory ? " /" : ""}</td><td>${e.isDirectory ? "—" : esc(fmtSize(e.size))}</td>`;
          tr.addEventListener("click", () => openEntry(e, layout));
          tb.appendChild(tr);
        }
        main.appendChild(tbl);
      }
      return;
    }

    const tbl = document.createElement("table");
    tbl.className = "detail";
    tbl.innerHTML =
      "<thead><tr><th>Name</th><th>Size</th><th>Modified</th></tr></thead><tbody></tbody>";
    const tb = tbl.querySelector("tbody");
    for (const e of entries) {
      const tr = document.createElement("tr");
      const dt = e.mtimeMs ? new Date(e.mtimeMs).toLocaleString() : "—";
      tr.innerHTML = `<td>${esc(e.name)}${e.isDirectory ? " /" : ""}</td><td>${e.isDirectory ? "—" : esc(fmtSize(e.size))}</td><td>${esc(dt)}</td>`;
      tr.addEventListener("click", () => openEntry(e, layout));
      tb.appendChild(tr);
    }
    main.appendChild(tbl);
  }

  async function renderFile(data) {
    const wrap = document.createElement("div");
    if (data.variant === "image") {
      const div = document.createElement("div");
      div.className = "img-wrap";
      const img = document.createElement("img");
      img.src = data.dataUrl;
      img.alt = data.name;
      div.appendChild(img);
      wrap.appendChild(div);
    } else if (data.variant === "image-too-large") {
      const p = document.createElement("p");
      p.textContent = `Image is large (${fmtSize(data.size)}).`;
      wrap.appendChild(p);
      const b = document.createElement("button");
      b.type = "button";
      b.textContent = "Open with system viewer";
      b.addEventListener("click", () => void api.openPathExternal(data.fullPath));
      wrap.appendChild(b);
    } else if (data.variant === "text") {
      if (data.truncated) {
        const p = document.createElement("p");
        p.className = "err";
        p.textContent = "Preview truncated (very large text file).";
        wrap.appendChild(p);
      }
      const pre = document.createElement("pre");
      pre.className = "text-preview";
      pre.textContent = data.text || "";
      wrap.appendChild(pre);
    } else if (data.variant === "pdf") {
      const meta = document.createElement("p");
      meta.textContent = `PDF${data.pageCount != null ? ` · ${data.pageCount} page${data.pageCount === 1 ? "" : "s"}` : ""}${
        data.size != null ? ` · ${fmtSize(data.size)}` : ""
      }`;
      wrap.appendChild(meta);
      const frameWrap = document.createElement("div");
      frameWrap.className = "browse-embed-pdfwrap";
      const frame = document.createElement("iframe");
      frame.className = "browse-embed-pdf";
      frame.src = data.pdfUrl;
      frame.title = data.name;
      frameWrap.appendChild(frame);
      wrap.appendChild(frameWrap);
      if (data.text) {
        const sec = document.createElement("p");
        sec.className = "browse-embed-section";
        sec.textContent = data.truncated ? "Extracted text (partial)" : "Extracted text";
        wrap.appendChild(sec);
        const pre = document.createElement("pre");
        pre.className = "browse-embed-pre";
        pre.textContent = data.text;
        wrap.appendChild(pre);
      }
    } else {
      const p = document.createElement("p");
      p.innerHTML = `Binary or unknown type — <strong>${esc(data.name)}</strong>${
        data.size != null ? ` (${esc(fmtSize(data.size))})` : ""
      }`;
      wrap.appendChild(p);
      const b = document.createElement("button");
      b.type = "button";
      b.textContent = "Open externally";
      b.addEventListener("click", () => void api.openPathExternal(data.fullPath));
      wrap.appendChild(b);
    }
    main.appendChild(wrap);
  }

  void (async () => {
    const data = await api.browseTabLoad({
      rootDir,
      targetPath,
      layout,
      kind,
    });
    if (!data.ok) {
      main.innerHTML = `<p class="err">${esc(data.error || "Load failed")}</p>`;
      return;
    }
    if (data.mode === "dir") {
      await renderDir(data);
    } else {
      await renderFile(data);
    }
  })();
})();
