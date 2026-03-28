/* OpenGraphXplorer — working set, expansion, card render pipeline (no global indexing) */
(function (global) {
  const EP = {};

  EP.getBaseWorkingSetItems = function getBaseWorkingSetItems(state, getFilteredSortedItems) {
    let items = getFilteredSortedItems();
    if (state.extSelection) {
      const ext = state.extSelection.ext;
      items = items.filter((i) => {
        if (i.type !== "file") {
          return false;
        }
        const idx = i.name.lastIndexOf(".");
        const fe = idx >= 0 && idx < i.name.length - 1 ? i.name.slice(idx + 1).toLowerCase() : "";
        return fe === ext;
      });
    }
    return items;
  };

  EP.applyWsExpansion = function applyWsExpansion(items, expansion, fsItems, helpers) {
    if (!expansion) {
      return items;
    }
    const normRel = helpers.normRel;
    const parentRelPath = helpers.parentRelPath;
    const itemIdFromRelPath = helpers.itemIdFromRelPath;
    const set = new Set(items.map((i) => i.relPath));

    if (expansion === "children") {
      for (const item of items) {
        for (const it of fsItems) {
          if (normRel(parentRelPath(it.relPath)) === normRel(item.relPath)) {
            set.add(it.relPath);
          }
        }
      }
    } else if (expansion === "parents") {
      for (const item of items) {
        let p = parentRelPath(item.relPath);
        while (p) {
          set.add(p);
          p = parentRelPath(p);
        }
      }
    } else if (expansion === "siblings") {
      for (const item of items) {
        const p = parentRelPath(item.relPath);
        for (const it of fsItems) {
          if (normRel(parentRelPath(it.relPath)) === normRel(p)) {
            set.add(it.relPath);
          }
        }
      }
    } else if (expansion === "hop1") {
      const linkNeighbors = helpers.getGraphNeighborIds;
      if (typeof linkNeighbors === "function") {
        for (const item of items) {
          const id = itemIdFromRelPath(item.relPath);
          for (const nid of linkNeighbors(id)) {
            set.add(nid);
          }
        }
      }
    }

    return [...set]
      .map((rel) => helpers.findItemByRelPath(rel))
      .filter(Boolean);
  };

  EP.parseCardRenderPipeline = function parseCardRenderPipeline(str) {
    if (!str || !str.trim()) {
      return [];
    }
    const parts = str.split("|").map((s) => s.trim()).filter(Boolean);
    const pipeline = [];
    for (const part of parts) {
      const m = part.match(/^(\w+)\s*(.*)$/);
      if (!m) {
        continue;
      }
      const op = m[1].toLowerCase();
      const rest = m[2].trim();
      if (op === "head") {
        const n = Math.max(0, parseInt(rest, 10) || 0);
        pipeline.push({ op: "head", n: n || 6 });
      } else if (op === "grep") {
        let pat = rest;
        const q = rest.match(/^"([^"]*)"$|^'([^']*)'$/);
        if (q) {
          pat = q[1] !== undefined ? q[1] : q[2];
        }
        pipeline.push({ op: "grep", pattern: pat });
      } else if (op === "regex") {
        let pat = rest;
        const q = rest.match(/^"([^"]*)"$|^'([^']*)'$/);
        if (q) {
          pat = q[1] !== undefined ? q[1] : q[2];
        }
        pipeline.push({ op: "regex", pattern: pat });
      } else if (op === "col") {
        const cols = rest
          .split(/[, ]+/)
          .map((s) => parseInt(s, 10) - 1)
          .filter((n) => Number.isFinite(n) && n >= 0);
        pipeline.push({ op: "col", cols });
      }
    }
    return pipeline;
  };

  EP.applyPipelineToText = function applyPipelineToText(text, pipeline) {
    let t = text == null ? "" : String(text);
    for (const step of pipeline) {
      if (step.op === "head") {
        const lines = t.split(/\r?\n/);
        const n = step.n || 6;
        t = lines.slice(0, n).join("\n");
      } else if (step.op === "grep") {
        const pat = step.pattern || "";
        const lines = t.split(/\r?\n/);
        let re;
        try {
          re = new RegExp(pat, "im");
        } catch {
          re = null;
        }
        if (re) {
          t = lines.filter((line) => re.test(line)).join("\n");
        } else {
          const needle = pat.toLowerCase();
          t = lines.filter((l) => l.toLowerCase().includes(needle)).join("\n");
        }
      } else if (step.op === "regex") {
        try {
          const re = new RegExp(step.pattern, "im");
          const lines = t.split(/\r?\n/);
          t = lines.filter((line) => re.test(line)).join("\n");
        } catch {
          t = "";
        }
      } else if (step.op === "col" && step.cols && step.cols.length) {
        const lines = t.split(/\r?\n/);
        t = lines
          .map((line) => {
            const cells = line.split(/,(?=(?:[^"]*"[^"]*")*[^"]*$)/).map((c) => c.trim().replace(/^"|"$/g, ""));
            if (cells.length === 1 && !line.includes(",") && line.includes("\t")) {
              const tab = line.split("\t");
              return step.cols.map((c) => tab[c] ?? "").join(" | ");
            }
            return step.cols.map((c) => cells[c] ?? "").join(" | ");
          })
          .join("\n");
      }
    }
    return t;
  };

  EP.parseCardRenderCommand = function parseCardRenderCommand(input) {
    const rest = input.replace(/^card\s+render\s*/i, "").trim();
    if (!rest || rest.toLowerCase() === "reset") {
      return { reset: true, pipeline: [] };
    }
    const s = rest
      .replace(/--index\s+\d+/gi, "")
      .replace(/--selected\b/gi, "")
      .replace(/--ws\b/gi, "")
      .trim();
    return { reset: false, pipeline: EP.parseCardRenderPipeline(s) };
  };

  global.EP = EP;
})(typeof window !== "undefined" ? window : globalThis);
