/* Embedded browse pane for in-app tabs — uses window.explorerApi + onOpenBrowse callback */
(function (global) {
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

  function mount(container, spec) {
    const api = global.explorerApi;
    if (!api || !container || !spec) {
      return;
    }
    const { rootDir, targetPath, layout: layoutIn, kind: kindIn, onOpenBrowse } = spec;
    const layout = layoutIn === "grid" ? "grid" : "detail";
    const kind = kindIn === "file" ? "file" : "dir";
    const openNested =
      typeof onOpenBrowse === "function"
        ? onOpenBrowse
        : (p) => {
            void api.openBrowseTab({ ...p, embed: false });
          };

    container.innerHTML = "";
    container.classList.add("browse-mount-inner");

    const wrap = document.createElement("div");
    wrap.className = "browse-embed";
    const header = document.createElement("header");
    header.className = "browse-embed-header";
    const pathLabel = document.createElement("span");
    pathLabel.className = "browse-embed-path";
    const actions = document.createElement("span");
    actions.className = "browse-embed-actions";
    header.appendChild(pathLabel);
    header.appendChild(actions);
    const main = document.createElement("main");
    main.className = "browse-embed-main";
    wrap.appendChild(header);
    wrap.appendChild(main);
    container.appendChild(wrap);

    pathLabel.textContent = targetPath;

    function openEntry(entry, dirLayout) {
      if (entry.isDirectory) {
        openNested({
          rootDir,
          inputPath: entry.fullPath,
          layout: dirLayout || "detail",
          forceKind: "dir",
        });
      } else {
        openNested({
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
        up.className = "browse-embed-btn";
        up.textContent = "Up";
        up.addEventListener("click", () => {
          openNested({
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
        det.className = "browse-embed-btn";
        det.textContent = "Detail list";
        det.addEventListener("click", () => {
          openNested({ rootDir, inputPath: dirPath, layout: "detail", forceKind: "dir" });
        });
        frag.appendChild(det);
      } else {
        const gr = document.createElement("button");
        gr.type = "button";
        gr.className = "browse-embed-btn";
        gr.textContent = "Image grid";
        gr.addEventListener("click", () => {
          openNested({ rootDir, inputPath: dirPath, layout: "grid", forceKind: "dir" });
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
        main.innerHTML = '<p class="browse-embed-err">Empty folder.</p>';
        return;
      }

      if (layout === "grid") {
        const images = entries.filter((e) => !e.isDirectory && e.isImage);
        const other = entries.filter((e) => e.isDirectory || !e.isImage);

        if (images.length) {
          const h = document.createElement("h2");
          h.className = "browse-embed-section";
          h.textContent = "Images";
          main.appendChild(h);
          const grid = document.createElement("div");
          grid.className = "browse-embed-grid";
          main.appendChild(grid);
          for (const e of images) {
            const tile = document.createElement("div");
            tile.className = "browse-embed-tile";
            tile.addEventListener("click", () => openEntry(e, layout));
            const img = document.createElement("img");
            img.alt = e.name;
            const cap = document.createElement("div");
            cap.className = "browse-embed-tile-cap";
            cap.textContent = e.name;
            tile.appendChild(img);
            tile.appendChild(cap);
            grid.appendChild(tile);
            void api.browseTabThumb({ rootDir, fullPath: e.fullPath }).then((r) => {
              if (r.ok && r.dataUrl) {
                img.src = r.dataUrl;
              } else {
                const ph = document.createElement("div");
                ph.className = "browse-embed-ph";
                ph.textContent = r.reason === "large" ? "Large" : "Open";
                img.replaceWith(ph);
              }
            });
          }
        }

        if (other.length) {
          const h2 = document.createElement("h2");
          h2.className = "browse-embed-section";
          h2.textContent = "Folders & files";
          main.appendChild(h2);
          const tbl = document.createElement("table");
          tbl.className = "browse-embed-table";
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
      tbl.className = "browse-embed-table";
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
        div.className = "browse-embed-imgwrap";
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
        b.className = "browse-embed-btn";
        b.textContent = "Open with system viewer";
        b.addEventListener("click", () => void api.openPathExternal(data.fullPath));
        wrap.appendChild(b);
      } else if (data.variant === "text") {
        if (data.truncated) {
          const p = document.createElement("p");
          p.className = "browse-embed-err";
          p.textContent = "Preview truncated (very large text file).";
          wrap.appendChild(p);
        }
        const pre = document.createElement("pre");
        pre.className = "browse-embed-pre";
        pre.textContent = data.text || "";
        wrap.appendChild(pre);
      } else {
        const p = document.createElement("p");
        p.innerHTML = `Binary or unknown — <strong>${esc(data.name)}</strong>${
          data.size != null ? ` (${esc(fmtSize(data.size))})` : ""
        }`;
        wrap.appendChild(p);
        const b = document.createElement("button");
        b.type = "button";
        b.className = "browse-embed-btn";
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
        main.innerHTML = `<p class="browse-embed-err">${esc(data.error || "Load failed")}</p>`;
        return;
      }
      if (data.mode === "dir") {
        await renderDir(data);
      } else {
        await renderFile(data);
      }
    })();
  }

  function unmount(container) {
    if (container) {
      container.innerHTML = "";
      container.classList.remove("browse-mount-inner");
    }
  }

  global.EPBrowsePane = { mount, unmount };
})(typeof window !== "undefined" ? window : globalThis);
