/* OpenGraphXplorer — working set, expansion, card render pipeline (no global indexing) */
(function (global) {
  const EP = {};

  // ── Filter handler registry ────────────────────────────────────────────────
  // Each handler: (items, filterSpec, helpers) → filteredItems
  // Register new filter types here without touching the pipeline logic.

  EP.FILTER_HANDLERS = {};

  EP.registerFilter = function registerFilter(type, handler) {
    EP.FILTER_HANDLERS[type] = handler;
  };

  EP.registerFilter("text", function (items, filter) {
    const needle = (filter.value || "").toLowerCase();
    if (!needle) return items;
    return items.filter(
      (item) =>
        item.name.toLowerCase().includes(needle) ||
        item.relPath.toLowerCase().includes(needle),
    );
  });

  EP.registerFilter("tag", function (items, filter, helpers) {
    const needle = (filter.value || "").toLowerCase();
    if (!needle) return items;
    const getTagsForId = helpers && helpers.getTagsForId;
    if (!getTagsForId) return items;
    return items.filter((item) => {
      const tags = (getTagsForId(item.relPath) || []).map((t) => t.toLowerCase());
      return tags.some((t) => t.includes(needle));
    });
  });

  EP.registerFilter("ext", function (items, filter) {
    const ext = (filter.value || "").toLowerCase();
    if (!ext) return items;
    return items.filter((item) => {
      if (item.type !== "file") return false;
      const idx = item.name.lastIndexOf(".");
      const fe =
        idx >= 0 && idx < item.name.length - 1
          ? item.name.slice(idx + 1).toLowerCase()
          : "";
      return fe === ext;
    });
  });

  // Apply an ordered array of filter specs to an item list.
  EP.applyPreFilters = function applyPreFilters(items, filters, helpers) {
    let result = items;
    for (const filter of filters || []) {
      if (!filter || !filter.type) continue;
      const handler = EP.FILTER_HANDLERS[filter.type];
      if (handler) result = handler(result, filter, helpers || {});
    }
    return result;
  };

  // Derive the current filter spec array from state.
  // New filter types (e.g. "concept") just need to push onto state.view.filters
  // and register a handler — no pipeline changes required.
  EP.buildPreFilters = function buildPreFilters(state) {
    const filters = [];
    if (state.view && state.view.searchText) {
      filters.push({ type: "text", value: state.view.searchText });
    }
    if (state.view && state.view.tagFilter) {
      filters.push({ type: "tag", value: state.view.tagFilter });
    }
    if (state.extSelection && state.extSelection.ext) {
      filters.push({ type: "ext", value: state.extSelection.ext });
    }
    // Future: merge state.view.filters[] here for concept/semantic filter types
    return filters;
  };

  // ── Three-phase working set pipeline ──────────────────────────────────────
  //
  //   Phase 1 (pre-filter)  — reduce: text, tag, ext
  //   Phase 2 (expansion)   — add: children, siblings, +1, parents
  //   Phase 3 (post-filter) — refine: intersect expanded set with allowed set
  //
  // Returns Set<relPath>. Rendering and sorting happen downstream.
  //
  // Allowed-set note: expansion is constrained by text+tag only, NOT by ext.
  // This preserves the existing behaviour where "expand children" shows all
  // text/tag-matching children even when an ext filter is active.
  EP.buildWorkingSet = function buildWorkingSet(allItems, state, helpers) {
    const ROOT_ID = helpers.ROOT_ID || "__root__";

    const allFilters = EP.buildPreFilters(state);

    // Allowed set: text + tag (expansion cannot exceed this; ext is excluded
    // so that expansion can cross the ext boundary intentionally).
    const expansionFilters = allFilters.filter((f) => f.type !== "ext");
    const allowedSet = new Set(
      EP.applyPreFilters(allItems, expansionFilters, helpers).map((i) => i.relPath),
    );

    // Phase 1: working set base = all pre-filters including ext
    const base = EP.applyPreFilters(allItems, allFilters, helpers);

    // Phase 2: expansion (optional)
    if (!state.wsExpansion) {
      return new Set(base.map((i) => i.relPath));
    }

    let seed = base;
    if (state.view && state.view.selectedId && state.view.selectedId !== ROOT_ID) {
      const findFn = helpers.findItemByRelPath || helpers.findItemById;
      const anchor = findFn ? findFn(state.view.selectedId) : null;
      if (anchor) seed = [anchor];
    }

    const expanded = EP.applyWsExpansion(seed, state.wsExpansion, allItems, helpers);

    // Phase 3: post-filter — intersect with allowed set (text+tag, not ext)
    return new Set(expanded.filter((i) => allowedSet.has(i.relPath)).map((i) => i.relPath));
  };

  // ── Graph source registry ──────────────────────────────────────────────────
  // Each source: { id, getNodes(ctx), getLinks(ctx) }
  //
  //   getNodes(ctx) → Array<{ id, x?, y?, meta? }>
  //     x/y are used as initial position only when the node isn't already in
  //     ctx.existing. Omit for random placement.
  //
  //   getLinks(ctx) → Array<{ a, b, kind? }>
  //     These feed state.graph.links (structural, full-strength spring).
  //     Extra/semantic links with different physics stay out of this registry.
  //
  // Register a source once at startup. Re-registering an existing id replaces it.

  EP.GRAPH_SOURCES = [];

  EP.registerGraphSource = function registerGraphSource(source) {
    const idx = EP.GRAPH_SOURCES.findIndex((s) => s.id === source.id);
    if (idx >= 0) {
      EP.GRAPH_SOURCES[idx] = source;
    } else {
      EP.GRAPH_SOURCES.push(source);
    }
  };

  EP.unregisterGraphSource = function unregisterGraphSource(id) {
    EP.GRAPH_SOURCES = EP.GRAPH_SOURCES.filter((s) => s.id !== id);
  };

  // Merge all active sources into { nodesById, links }.
  //
  // ctx must contain:
  //   existing  — current state.graph.nodesById (Map) for position preservation
  //   world     — { w, h } for default initial scatter
  //
  // Merge rules:
  //   - Node IDs are deduplicated: first source wins for position; later sources
  //     enrich meta (Object.assign order).
  //   - Links are concatenated; deduplication is the caller's responsibility if needed.
  EP.mergeGraphSources = function mergeGraphSources(sources, ctx) {
    const { existing, world } = ctx;
    const cx = world.w * 0.5;
    const cy = world.h * 0.5;

    // Collect all node descriptors (id → merged descriptor)
    const descriptors = new Map(); // id → { x?, y?, meta: {} }
    const allLinks = [];

    for (const source of sources) {
      for (const descriptor of source.getNodes(ctx)) {
        if (!descriptors.has(descriptor.id)) {
          descriptors.set(descriptor.id, {
            x: descriptor.x,
            y: descriptor.y,
            meta: {},
          });
        }
        if (descriptor.meta) {
          Object.assign(descriptors.get(descriptor.id).meta, descriptor.meta);
        }
      }
      for (const link of source.getLinks(ctx)) {
        allLinks.push(link);
      }
    }

    // Build nodesById, preserving physics state from existing
    const nodesById = new Map();
    for (const [id, desc] of descriptors) {
      const prev = existing.get(id);
      const base = prev || {
        id,
        x: desc.x !== undefined ? desc.x : cx + (Math.random() - 0.5) * 900,
        y: desc.y !== undefined ? desc.y : cy + (Math.random() - 0.5) * 700,
        vx: 0,
        vy: 0,
      };
      nodesById.set(id, { ...base, ...desc.meta, id });
    }

    return { nodesById, links: allLinks };
  };

  // ── Backward-compatible wrapper ────────────────────────────────────────────
  // Kept so existing call-sites (tests, etc.) continue to work unchanged.
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
