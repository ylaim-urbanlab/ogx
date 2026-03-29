/* OpenGraphXplorer — working set, expansion, card render pipeline (no global indexing) */
(function (global) {
  const EP = {};

  // ── Filter handler registry ────────────────────────────────────────────────
  //
  // Invariant: FILTER → defines set membership. RENDER → defines display.
  // Filters must never read render output; render must never influence membership.
  //
  // Each descriptor:
  //   { phase: "pre", fn: (items, filterSpec, helpers) → filteredItems }
  //
  // phase "pre"  — runs before expansion (reduces the seed set)
  // Only "pre" is used today; "post" is reserved for future use.
  //
  // helpers available to handlers:
  //   getTagsForId(relPath)         → string[]
  //   getContentForRelPath(relPath) → string | null  (from content cache)

  EP.FILTER_HANDLERS = {};

  EP.registerFilter = function registerFilter(type, descriptor) {
    // Accept both plain function (legacy) and descriptor object.
    if (typeof descriptor === "function") {
      EP.FILTER_HANDLERS[type] = { phase: "pre", fn: descriptor };
    } else {
      EP.FILTER_HANDLERS[type] = { phase: descriptor.phase || "pre", fn: descriptor.fn };
    }
  };

  // ── Built-in filter handlers ──────────────────────────────────────────────

  // "name" — filter by item.name / item.relPath  (was "text")
  EP.registerFilter("name", function (items, filter) {
    const needle = (filter.value || "").toLowerCase();
    if (!needle) return items;
    return items.filter(
      (item) =>
        item.name.toLowerCase().includes(needle) ||
        item.relPath.toLowerCase().includes(needle),
    );
  });
  // Backward-compat alias
  EP.registerFilter("text", EP.FILTER_HANDLERS["name"]);

  // "content" / "body" — filter by file text (reads from helpers.getContentForRelPath)
  // Degrades gracefully: items without cached content are kept (not excluded) so
  // a warming cache never silently drops cards.
  EP.registerFilter("content", function (items, filter, helpers) {
    const needle = (filter.value || "").toLowerCase();
    if (!needle) return items;
    const getContent = helpers && helpers.getContentForRelPath;
    if (typeof getContent !== "function") return items; // cache not available
    return items.filter((item) => {
      const text = getContent(item.relPath);
      if (text == null) return true; // not yet cached → keep (degrade gracefully)
      return text.toLowerCase().includes(needle);
    });
  });
  EP.registerFilter("body", EP.FILTER_HANDLERS["content"]);

  // "tag" — filter by tag store
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

  // "ext" — filter by file extension
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

  // "meta" — filter by item metadata: size, type
  // Supported expressions (parsed from filter.value string):
  //   size>2mb  size<500kb  size>1024  (bytes when no unit)
  //   type:file  type:folder
  EP.registerFilter("meta", function (items, filter) {
    const expr = (filter.value || "").trim().toLowerCase();
    if (!expr) return items;

    // size comparison: size>2mb, size<500kb, size>=1024, size<=2048
    const sizeM = expr.match(/^size\s*([><=!]+)\s*([\d.]+)\s*(mb|kb|b)?$/);
    if (sizeM) {
      const op = sizeM[1];
      let val = parseFloat(sizeM[2]);
      const unit = sizeM[3] || "b";
      if (unit === "mb") val *= 1024 * 1024;
      else if (unit === "kb") val *= 1024;
      return items.filter((item) => {
        const s = item.size || 0;
        if (op === ">")  return s > val;
        if (op === ">=") return s >= val;
        if (op === "<")  return s < val;
        if (op === "<=") return s <= val;
        if (op === "=" || op === "==") return s === val;
        return true;
      });
    }

    // type: file | folder
    const typeM = expr.match(/^type\s*[:=]\s*(file|folder)$/);
    if (typeM) {
      const want = typeM[1];
      return items.filter((item) => item.type === want);
    }

    return items; // unknown meta expression — no-op
  });

  // ── Apply + build ─────────────────────────────────────────────────────────

  // Apply an ordered array of filter specs to an item list.
  EP.applyPreFilters = function applyPreFilters(items, filters, helpers) {
    let result = items;
    for (const filter of filters || []) {
      if (!filter || !filter.type) continue;
      const descriptor = EP.FILTER_HANDLERS[filter.type];
      if (!descriptor) continue;
      const kept = descriptor.fn(result, filter, helpers || {});
      if (filter.negate) {
        // Return items NOT in the kept set
        const keptSet = new Set(kept);
        result = result.filter((item) => !keptSet.has(item));
      } else {
        result = kept;
      }
    }
    return result;
  };

  // Derive the current filter spec array from state.
  //
  // Canonical source: state.view.filters[]  (new unified array)
  // Legacy fallback:  state.view.searchText / tagFilter / state.extSelection
  //   — kept for undo/bookmark deserialization only; never written by new code.
  //
  // De-duplication: if a type already appears in state.view.filters, the legacy
  // field for that type is ignored.
  EP.buildPreFilters = function buildPreFilters(state) {
    const filters = [];
    const seen = new Set();

    // Canonical filters first
    for (const f of (state.view && state.view.filters) || []) {
      if (f && f.type) {
        filters.push(f);
        seen.add(f.type);
      }
    }

    // Legacy fallbacks (backward compat with saved snapshots / undo stacks)
    if (!seen.has("name") && !seen.has("text") && state.view && state.view.searchText) {
      filters.push({ type: "name", value: state.view.searchText });
    }
    if (!seen.has("tag") && state.view && state.view.tagFilter) {
      filters.push({ type: "tag", value: state.view.tagFilter });
    }
    if (!seen.has("ext") && state.extSelection && state.extSelection.ext) {
      filters.push({ type: "ext", value: state.extSelection.ext });
    }

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
    const normRel = helpers.normRel || ((v) => v);
    const selectedId = state.view && state.view.selectedId;
    const findFn = helpers.findItemByRelPath || helpers.findItemById;

    const allFilters = EP.buildPreFilters(state);

    // Allowed set: text + tag (expansion cannot exceed this; ext is excluded
    // so that expansion can cross the ext boundary intentionally).
    const expansionFilters = allFilters.filter((f) => f.type !== "ext");
    const allowedSet = new Set(
      EP.applyPreFilters(allItems, expansionFilters, helpers).map((i) => i.relPath),
    );

    // Phase 1: working set base = all pre-filters including ext
    let base = EP.applyPreFilters(allItems, allFilters, helpers);

    // Selection scope: a selected file narrows to itself; a selected folder narrows
    // to its subtree. This keeps the reader + match counts aligned with graph selection.
    if (selectedId && selectedId !== ROOT_ID) {
      const anchor = findFn ? findFn(selectedId) : null;
      if (anchor) {
        if (anchor.type === "file") {
          base = base.filter((item) => normRel(item.relPath) === normRel(anchor.relPath));
        } else if (anchor.type === "folder") {
          const anchorRel = normRel(anchor.relPath);
          const prefix = anchorRel ? `${anchorRel}/` : "";
          base = base.filter((item) => {
            const rel = normRel(item.relPath);
            return rel === anchorRel || rel.startsWith(prefix);
          });
        }
      }
    }

    // Phase 2: expansion (optional)
    if (!state.wsExpansion) {
      return new Set(base.map((i) => i.relPath));
    }

    let seed = base;
    if (selectedId && selectedId !== ROOT_ID) {
      const anchor = findFn ? findFn(selectedId) : null;
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

  // ── Node type registry ────────────────────────────────────────────────────
  // Declares how each node type behaves in the graph and reader.
  //
  // Required fields:
  //   visibleInModes  — Set of view modes where this type is shown.
  //                     Use "*" to mean "always visible regardless of mode".
  //                     Current modes: "folders", "files", "hybrid".
  //
  // Optional fields (for future use, not enforced today):
  //   virtual         — true if node has no backing file (e.g. concept nodes)
  //   cardRenderer    — which card renderer to use (defaults to type name)
  //
  // Unknown types are treated as always visible (safe default).

  EP.NODE_TYPES = {};

  EP.registerNodeType = function registerNodeType(type, descriptor) {
    EP.NODE_TYPES[type] = descriptor;
  };

  EP.getNodeType = function getNodeType(type) {
    return EP.NODE_TYPES[type] || null;
  };

  // Returns true if a node of the given type should be visible in the given mode.
  // Falls back to true for unknown types so unregistered types are never silently hidden.
  EP.isNodeTypeVisibleInMode = function isNodeTypeVisibleInMode(type, mode) {
    const descriptor = EP.NODE_TYPES[type];
    if (!descriptor) return true; // unknown type: show by default
    if (descriptor.visibleInModes === "*") return true;
    return descriptor.visibleInModes.has(mode);
  };

  // ── Card renderer registry ────────────────────────────────────────────────
  // Each renderer: (item, cardEl, rowIndex1) → job | null
  //
  //   item      — working set item { relPath, name, type, ... }
  //   cardEl    — the card container div (class "file-card" already set by caller)
  //   rowIndex1 — 1-based position in the deck
  //
  // The renderer should populate cardEl's DOM children and return a job
  // descriptor for async content loading, or null for no async work.
  //
  // Unknown types fall back to the "file" renderer.

  EP.CARD_RENDERERS = {};

  EP.registerCardRenderer = function registerCardRenderer(type, fn) {
    EP.CARD_RENDERERS[type] = fn;
  };

  EP.getCardRenderer = function getCardRenderer(type) {
    return EP.CARD_RENDERERS[type] || EP.CARD_RENDERERS["file"] || null;
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
