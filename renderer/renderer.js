const ROOT_ID = "__root__";

const PASTEL = ["#9ec9f0", "#c4b5fd", "#f9b4c8", "#b8e8d0", "#ffe1a8", "#a6e3e9", "#e2c2ff", "#c7f0c2"];

const DEFAULT_SETTINGS = {
  logFadeMs: 9000,
  cardHeadLines: 4,
  cardTailLines: 4,
  graphGravity: 0.00022,
  graphRepulsion: 0.078,
  graphLinkStrength: 0.00085,
  graphDamping: 0.94,
  mdSectionTitles: [],
  /** "top" | "bottom" — reader selection / pipeline panel in the right column */
  selectionHudPosition: "bottom",
  /** "top" | "bottom" — CLI input bar on the graph */
  cliInputAnchor: "bottom",
};

function loadSettings() {
  try {
    const raw = localStorage.getItem("ogx-settings");
    if (!raw) {
      return { ...DEFAULT_SETTINGS };
    }
    return { ...DEFAULT_SETTINGS, ...JSON.parse(raw) };
  } catch {
    return { ...DEFAULT_SETTINGS };
  }
}

function saveSettings() {
  localStorage.setItem("ogx-settings", JSON.stringify(state.settings));
}

const state = {
  rootDir: "",
  settings: loadSettings(),
  world: { w: 4200, h: 3200 },
  camera: { x: 2100, y: 1600, scale: 1, min: 0.35, max: 2.75 },
  interaction: {
    mode: null,
    pointerId: null,
    startSx: 0,
    startSy: 0,
    startCamX: 0,
    startCamY: 0,
    nodeId: null,
    moved: false,
  },
  logLines: [],
  cliLogHovered: false,
  cliHistory: [],
  cliUndoStack: [],
  cliRedoStack: [],
  cliHistIndex: -1,
  cliHistDraft: "",
  /** Persistent selection narrative (not the fading CLI log). */
  selectHistory: [],
  readerPipelineMatchByRel: new Map(),
  extraLinks: [],
  extraLinkEndpoints: new Set(), // relPaths of nodes that have ≥1 extra link
  highlight: null,
  extSelection: null,
  wsExpansion: null,
  selection: { relPath: null },
  cardRender: { pipeline: [] },
  fsSnapshot: {
    items: [],
    itemsById: new Map(),
    fileCountByFolder: new Map(),
    typeCountsByFolder: new Map(),
  },
  overlay: {
    tagsByPath: {},
    cards: [],
  },
  workspace: {
    entries: [],
    filterText: "",
    sortMode: "manual",
    selectedCardRelPath: null,
    /** null | "matched" | "empty" — filter reader to pipeline hit/miss (after cards load) */
    pipelineResultFilter: null,
  },
  view: {
    searchText: "",
    tagFilter: "",
    sortMode: "name-asc",
    selectedId: ROOT_ID,
    mode: "folders",
    visibleNodeIds: new Set(),
    labelFields: new Set(),
  },
  graph: {
    nodesById: new Map(),
    links: [],
    rafId: null,
    pinnedIds: new Set(),
  },
  appTabs: {
    seq: 1,
    list: [{ id: "ws", kind: "workspace", label: "Workspace" }],
    activeId: "ws",
  },
};

const els = {
  pickRootBtn: document.getElementById("pickRootBtn"),
  useTestenvBtn: document.getElementById("useTestenvBtn"),
  refreshBtn: document.getElementById("refreshBtn"),
  rootLabel: document.getElementById("rootLabel"),
  graphCanvas: document.getElementById("graphCanvas"),
  terminalForm: document.getElementById("terminalForm"),
  terminalInput: document.getElementById("terminalInput"),
  workspaceDeck: document.getElementById("workspaceDeck"),
  resizeCol: document.getElementById("resizeCol"),
  wsStatusBar: document.getElementById("wsStatusBar"),
  selectHistory: document.getElementById("selectHistory"),
  selectionHud: document.getElementById("selectionHud"),
  tagBar: document.getElementById("tagBar"),
  appTabStrip: document.getElementById("appTabStrip"),
  workspaceStage: document.getElementById("workspaceStage"),
  browseMount: document.getElementById("browseMount"),
};

const EP = window.EP;

const STORAGE_PRESETS = "ogx-presets-v1";
const STORAGE_WS_BOOKMARKS = "ogx-ws-bookmarks-v1";
const STORAGE_CARD_RENDER_SAVED = "ogx-card-render-saved-v1";

const ctx = els.graphCanvas.getContext("2d");

function normRel(p) {
  return String(p).replace(/\\/g, "/");
}

function baseNamePath(p) {
  const n = normRel(p);
  const i = n.lastIndexOf("/");
  return i >= 0 ? n.slice(i + 1) : n;
}

function stripOuterQuotes(s) {
  const t = String(s || "").trim();
  const m = t.match(/^"([^"]*)"$|^'([^']*)'$/);
  if (m) {
    return m[1] !== undefined ? m[1] : m[2];
  }
  return t;
}

/** Parse `open dir …` path and optional --grid / --detail (leading or trailing). */
function parseOpenDirPathAndLayout(rest) {
  let t = rest.trim();
  let layout = "detail";
  for (let pass = 0; pass < 6; pass += 1) {
    const low = t.toLowerCase();
    if (low.startsWith("--grid ")) {
      layout = "grid";
      t = t.slice(7).trim();
      continue;
    }
    if (low === "--grid") {
      layout = "grid";
      t = "";
      break;
    }
    if (low.startsWith("--detail ")) {
      layout = "detail";
      t = t.slice(9).trim();
      continue;
    }
    if (low === "--detail") {
      layout = "detail";
      t = "";
      break;
    }
    if (/\s--grid\s*$/i.test(t)) {
      layout = "grid";
      t = t.replace(/\s--grid\s*$/i, "").trim();
      continue;
    }
    if (/\s--detail\s*$/i.test(t)) {
      layout = "detail";
      t = t.replace(/\s--detail\s*$/i, "").trim();
      continue;
    }
    break;
  }
  return { layout, path: stripOuterQuotes(t) };
}

function pastelForId(id) {
  let h = 0;
  for (let i = 0; i < id.length; i += 1) {
    h = (h * 31 + id.charCodeAt(i)) | 0;
  }
  return PASTEL[Math.abs(h) % PASTEL.length];
}

function normalizeTags(input) {
  return input
    .split(",")
    .map((v) => v.trim())
    .filter(Boolean);
}

function itemIdFromRelPath(relPath) {
  return relPath || ROOT_ID;
}

function findItemById(id) {
  if (id === ROOT_ID) {
    return null;
  }
  return state.fsSnapshot.itemsById.get(id) || null;
}

function findItemByRelPathFlexible(rel) {
  const n = normRel(rel);
  for (const item of state.fsSnapshot.items) {
    if (normRel(item.relPath) === n) {
      return item;
    }
  }
  return null;
}

function getTagsForId(id) {
  if (id === ROOT_ID) {
    return [];
  }
  return state.overlay.tagsByPath[id] || [];
}

function setTagsForId(id, tagsText) {
  if (id === ROOT_ID) {
    return;
  }
  const tags = normalizeTags(tagsText);
  if (tags.length === 0) {
    delete state.overlay.tagsByPath[id];
    return;
  }
  state.overlay.tagsByPath[id] = tags;
}

function parentRelPath(relPath) {
  const slash = Math.max(relPath.lastIndexOf("/"), relPath.lastIndexOf("\\"));
  if (slash < 0) {
    return "";
  }
  return relPath.slice(0, slash);
}

function sortItems(items) {
  const sorted = [...items];
  const byName = (a, b) => a.name.localeCompare(b.name);
  const byType = (a, b) => a.type.localeCompare(b.type);

  switch (state.view.sortMode) {
    case "name-desc":
      sorted.sort((a, b) => byName(b, a));
      break;
    case "type-asc":
      sorted.sort((a, b) => byType(a, b) || byName(a, b));
      break;
    case "type-desc":
      sorted.sort((a, b) => byType(b, a) || byName(a, b));
      break;
    default:
      sorted.sort(byName);
  }
  return sorted;
}

function filterItems(items) {
  // text + tag only (no ext) — used for graph visibility and allowed-set derivation
  const filters = EP.buildPreFilters(state).filter((f) => f.type !== "ext");
  return EP.applyPreFilters(items, filters, { getTagsForId });
}

function pruneStaleTags() {
  const valid = new Set(state.fsSnapshot.items.map((item) => item.relPath));
  for (const relPath of Object.keys(state.overlay.tagsByPath)) {
    if (!valid.has(relPath)) {
      delete state.overlay.tagsByPath[relPath];
    }
  }
}

function getFilteredSortedItems() {
  return sortItems(filterItems(state.fsSnapshot.items));
}

function getWorkingSetItems() {
  if (!EP) {
    return getFilteredSortedItems();
  }
  const workingSet = EP.buildWorkingSet(state.fsSnapshot.items, state, {
    ROOT_ID,
    getTagsForId,
    normRel,
    parentRelPath,
    itemIdFromRelPath,
    findItemByRelPath: (rel) => findItemByRelPathFlexible(rel),
    findItemById,
    getGraphNeighborIds: (id) => getNeighborIds(id),
  });
  return state.fsSnapshot.items.filter((i) => workingSet.has(i.relPath));
}

function snapshotCliState() {
  const ext = state.extSelection;
  return {
    cardRender: { pipeline: [...(state.cardRender.pipeline || [])] },
    selectionRel: state.selection.relPath,
    selectedCardRel: state.workspace.selectedCardRelPath,
    extSelection: ext ? { ext: ext.ext, folderIds: [...ext.folderIds] } : null,
    pipelineResultFilter: state.workspace.pipelineResultFilter,
    wsExpansion: state.wsExpansion,
    selectedGraphId: state.view.selectedId,
    readerFilterText: state.workspace.filterText,
    readerSortMode: state.workspace.sortMode,
  };
}

function restoreCliState(s) {
  state.cardRender = { pipeline: [...(s.cardRender.pipeline || [])] };
  state.selection.relPath = s.selectionRel;
  state.workspace.selectedCardRelPath = s.selectedCardRel;
  if (s.extSelection) {
    state.extSelection = {
      ext: s.extSelection.ext,
      folderIds: new Set(s.extSelection.folderIds),
    };
  } else {
    state.extSelection = null;
  }
  state.workspace.pipelineResultFilter = s.pipelineResultFilter ?? null;
  if ("wsExpansion" in s) {
    state.wsExpansion = s.wsExpansion != null ? s.wsExpansion : null;
  }
  if ("selectedGraphId" in s) {
    const gid = s.selectedGraphId;
    if (gid != null && state.graph.nodesById.has(gid)) {
      state.view.selectedId = gid;
    } else {
      state.view.selectedId = ROOT_ID;
    }
  }
  if ("readerFilterText" in s) {
    state.workspace.filterText = s.readerFilterText != null ? String(s.readerFilterText) : "";
  }
  if ("readerSortMode" in s) {
    state.workspace.sortMode = s.readerSortMode || "manual";
  }
  if (state.selection.relPath || state.workspace.selectedCardRelPath) {
    const r = state.selection.relPath || state.workspace.selectedCardRelPath;
    setHighlightForCardFile(r);
  } else {
    state.highlight = null;
  }
}

function pushCliUndo() {
  state.cliRedoStack = [];
  state.cliUndoStack.push(snapshotCliState());
  while (state.cliUndoStack.length > 30) {
    state.cliUndoStack.shift();
  }
}

function cliUndoPop() {
  const s = state.cliUndoStack.pop();
  if (!s) {
    return false;
  }
  state.cliRedoStack.push(snapshotCliState());
  while (state.cliRedoStack.length > 30) {
    state.cliRedoStack.shift();
  }
  restoreCliState(s);
  return true;
}

function cliRedoPop() {
  const s = state.cliRedoStack.pop();
  if (!s) {
    return false;
  }
  state.cliUndoStack.push(snapshotCliState());
  while (state.cliUndoStack.length > 30) {
    state.cliUndoStack.shift();
  }
  restoreCliState(s);
  return true;
}

function finishUndoRedoNavigation(message) {
  buildGraph();
  renderWorkspaceDeck();
  updateWsBar();
  logLine(message);
}

function runCliBack() {
  if (!cliUndoPop()) {
    logLine("nothing to undo");
    return;
  }
  finishUndoRedoNavigation("back: restored previous pipeline / selection / ext / reader filter");
}

function runCliForward() {
  if (!cliRedoPop()) {
    logLine("nothing to redo");
    return;
  }
  finishUndoRedoNavigation("forward: restored next state");
}

function appendSelectHistory(text) {
  const t = new Date().toLocaleTimeString(undefined, {
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
  });
  state.selectHistory.push(`[${t}] ${String(text)}`);
  while (state.selectHistory.length > 120) {
    state.selectHistory.shift();
  }
  renderSelectHistory();
}

function renderSelectHistory() {
  if (!els.selectHistory) {
    return;
  }
  els.selectHistory.textContent = state.selectHistory.join("\n");
  els.selectHistory.scrollTop = els.selectHistory.scrollHeight;
}

function applyChromeLayout() {
  const cli = state.settings.cliInputAnchor === "top" ? "top" : "bottom";
  const hud = state.settings.selectionHudPosition === "top" ? "top" : "bottom";
  document.documentElement.dataset.epCliAnchor = cli;
  document.documentElement.dataset.epSelectionHud = hud;
}

function updateSelectionHud() {
  if (!els.selectionHud) {
    return;
  }
  const steps = state.cardRender.pipeline || [];
  const pipe =
    steps.length > 0
      ? steps
          .map((s) => {
            if (s.op === "grep" || s.op === "regex") {
              return `${s.op} ${s.pattern != null ? JSON.stringify(s.pattern) : ""}`;
            }
            if (s.op === "head") {
              return `head ${s.n}`;
            }
            if (s.op === "col") {
              return `col ${(s.cols || []).map((c) => c + 1).join(",")}`;
            }
            return s.op;
          })
          .join(" | ")
      : "(default card previews)";
  const focusRel = state.selection.relPath || state.workspace.selectedCardRelPath;
  const focus = focusRel ? focusRel.split("/").pop() : "all reader cards";
  const pf = state.workspace.pipelineResultFilter;
  const ext = state.extSelection ? `ext=.${state.extSelection.ext}` : "ext=off";
  const anchorItem = state.view.selectedId !== ROOT_ID ? findItemById(state.view.selectedId) : null;
  const expandAnchor = state.wsExpansion
    ? anchorItem
      ? `node: ${anchorItem.name}`
      : "root (expand from full working set)"
    : "—";
  const pipeActive = steps.length > 0;
  const graphPipeHint =
    pipeActive && (pf === "matched" || pf === "empty")
      ? "Graph: teal = in reader · dim = not in reader · light ring = pipeline preview pending"
      : "";
  const hudLines = [
    `Pipeline: ${pipe}`,
    `Render scope: ${focus}`,
    `Pipeline result: ${pf || "off"} (reader matched | empty | all)`,
    ext,
    `expand: ${state.wsExpansion || "none"} · anchor ${expandAnchor}`,
    `undo / redo: ${state.cliUndoStack.length} / ${state.cliRedoStack.length} — back (4) · forward (6)`,
  ];
  if (graphPipeHint) {
    hudLines.splice(3, 0, graphPipeHint);
  }
  els.selectionHud.textContent = hudLines.join("\n");
}

function renderTagBar() {
  if (!els.tagBar) return;
  els.tagBar.innerHTML = "";
  // Collect all unique tags from the overlay
  const allTags = new Set();
  for (const tags of Object.values(state.overlay.tagsByPath)) {
    if (Array.isArray(tags)) for (const t of tags) allTags.add(t);
  }
  const active = state.view.tagFilter;
  for (const tag of [...allTags].sort()) {
    const chip = document.createElement("button");
    chip.type = "button";
    chip.className = "tag-chip" + (tag.toLowerCase() === active ? " tag-chip--active" : "");
    chip.textContent = tag;
    chip.title = `Filter by tag: ${tag}`;
    chip.addEventListener("click", () => {
      const isActive = state.view.tagFilter === tag.toLowerCase();
      state.view.tagFilter = isActive ? "" : tag.toLowerCase();
      buildGraph();
      renderWorkspaceDeck();
      renderTagBar();
    });
    els.tagBar.appendChild(chip);
  }
}

function updateWsBar() {
  if (!els.wsStatusBar) {
    return;
  }
  if (!state.rootDir) {
    els.wsStatusBar.textContent = "";
    return;
  }
  const ws = getWorkingSetItems();
  const files = ws.filter((i) => i.type === "file");
  const bits = [];
  if (state.view.searchText) {
    bits.push(`filter="${state.view.searchText}"`);
  }
  if (state.view.tagFilter) {
    bits.push(`tag="${state.view.tagFilter}"`);
  }
  if (state.extSelection) {
    bits.push(`ext=${state.extSelection.ext}`);
  }
  if (state.wsExpansion) {
    bits.push(`expand=${state.wsExpansion}`);
  }
  const rdf = state.workspace.filterText.trim();
  if (rdf) {
    bits.push(`reader~="${rdf.length > 18 ? `${rdf.slice(0, 18)}…` : rdf}"`);
  }
  if (state.workspace.sortMode && state.workspace.sortMode !== "manual") {
    bits.push(`rsort=${state.workspace.sortMode}`);
  }
  const sel = state.selection.relPath ? state.selection.relPath.split("/").pop() : "—";
  const readerCount = getWorkspaceRowsForDisplay().length;
  els.wsStatusBar.textContent = `WS: ${ws.length} items (${files.length} files) · reader: ${readerCount} · selection: ${sel} · ${bits.join(" · ") || "no filters"}`;
  updateSelectionHud();
}

/** Pipeline applies to all reader cards when nothing is selected; otherwise only the active file. */
function shouldApplyCardRender(relPath) {
  const cr = state.cardRender;
  if (!cr.pipeline || !cr.pipeline.length) {
    return false;
  }
  const focus = state.selection.relPath || state.workspace.selectedCardRelPath;
  if (!focus) {
    return true;
  }
  return normRel(relPath) === normRel(focus);
}

function cardsAddFromWorkingSet() {
  renderWorkspaceDeck();
  logLine("reader already mirrors the working set (filter, tag, select ext, expand); nothing to add");
}

function cardsAddSelected() {
  renderWorkspaceDeck();
  logLine("reader already mirrors the working set; click a card to set pipeline scope");
}

function snapshotViewAndSettings() {
  return {
    rootDir: state.rootDir,
    ext: state.extSelection ? state.extSelection.ext : null,
    view: {
      searchText: state.view.searchText,
      tagFilter: state.view.tagFilter,
      sortMode: state.view.sortMode,
      mode: state.view.mode,
      labelFields: [...state.view.labelFields],
    },
    settings: { ...state.settings },
    wsExpansion: state.wsExpansion,
  };
}

function snapshotPreset() {
  return {
    ...snapshotViewAndSettings(),
    cardRender: { pipeline: [...(state.cardRender.pipeline || [])] },
  };
}

function loadJsonStorage(key, fallback) {
  try {
    const raw = localStorage.getItem(key);
    return raw ? JSON.parse(raw) : fallback;
  } catch {
    return fallback;
  }
}

function saveJsonStorage(key, value) {
  localStorage.setItem(key, JSON.stringify(value));
}

function loadPresetsMap() {
  return loadJsonStorage(STORAGE_PRESETS, {});
}

function savePresetsMap(map) {
  saveJsonStorage(STORAGE_PRESETS, map);
}

function loadWsBookmarksMap() {
  return loadJsonStorage(STORAGE_WS_BOOKMARKS, {});
}

function saveWsBookmarksMap(map) {
  saveJsonStorage(STORAGE_WS_BOOKMARKS, map);
}

function snapshotWsBookmark() {
  return {
    rootDir: state.rootDir,
    ext: state.extSelection ? state.extSelection.ext : null,
    view: {
      searchText: state.view.searchText,
      tagFilter: state.view.tagFilter,
      sortMode: state.view.sortMode,
      mode: state.view.mode,
      labelFields: [...state.view.labelFields],
    },
    wsExpansion: state.wsExpansion,
  };
}

async function applyPresetAsync(snap) {
  if (!snap) {
    return;
  }
  if (snap.rootDir && snap.rootDir !== state.rootDir) {
    await loadRoot(snap.rootDir);
  }
  if (snap.view) {
    state.view.searchText = snap.view.searchText || "";
    state.view.tagFilter = snap.view.tagFilter || "";
    state.view.sortMode = snap.view.sortMode || "name-asc";
    state.view.mode = snap.view.mode || "folders";
    state.view.labelFields = new Set(snap.view.labelFields || []);
  }
  if (snap.settings) {
    state.settings = { ...DEFAULT_SETTINGS, ...snap.settings };
    saveSettings();
  }
  state.wsExpansion = snap.wsExpansion || null;
  if (snap.ext) {
    applyExtSelection(snap.ext, { silent: true });
  } else {
    clearExtSelection();
    syncWorkspaceFromGraphSelection();
  }
  if (snap.cardRender) {
    state.cardRender = {
      pipeline: snap.cardRender.pipeline || [],
    };
  }
  buildGraph();
  renderWorkspaceDeck();
}

async function applyWsBookmarkAsync(snap) {
  if (!snap) {
    return;
  }
  if (snap.rootDir && snap.rootDir !== state.rootDir) {
    await loadRoot(snap.rootDir);
  }
  if (snap.view) {
    state.view.searchText = snap.view.searchText || "";
    state.view.tagFilter = snap.view.tagFilter || "";
    state.view.sortMode = snap.view.sortMode || "name-asc";
    state.view.mode = snap.view.mode || "folders";
    state.view.labelFields = new Set(snap.view.labelFields || []);
  }
  state.wsExpansion = snap.wsExpansion || null;
  if (snap.ext) {
    applyExtSelection(snap.ext, { silent: true });
  } else {
    clearExtSelection();
    syncWorkspaceFromGraphSelection();
  }
  buildGraph();
  renderWorkspaceDeck();
}

function applySnapshot(snap) {
  if (!snap) {
    return;
  }
  if (snap.view) {
    state.view.searchText = snap.view.searchText || "";
    state.view.tagFilter = snap.view.tagFilter || "";
    state.view.sortMode = snap.view.sortMode || "name-asc";
    state.view.mode = snap.view.mode || "folders";
    state.view.labelFields = new Set(snap.view.labelFields || []);
  }
  if (snap.settings) {
    state.settings = { ...DEFAULT_SETTINGS, ...snap.settings };
    saveSettings();
  }
  state.wsExpansion = snap.wsExpansion || null;
  buildGraph();
  if (snap.ext) {
    applyExtSelection(snap.ext, { silent: true });
  } else {
    clearExtSelection();
    syncWorkspaceFromGraphSelection();
  }
  renderWorkspaceDeck();
}

function selectGraphSiblings() {
  const id = state.view.selectedId;
  if (id === ROOT_ID) {
    logLine("select a node first");
    return;
  }
  const p = parentRelPath(id);
  const files = state.fsSnapshot.items.filter(
    (i) => normRel(parentRelPath(i.relPath)) === normRel(p) && i.type === "file",
  );
  state.selection.relPath = files[0]?.relPath || null;
  logLine(`selection: ${state.selection.relPath || "none"}`);
  appendSelectHistory(`Select siblings → ${state.selection.relPath || "none"}`);
  updateWsBar();
}

function selectGraphChildren() {
  const id = state.view.selectedId;
  if (id === ROOT_ID) {
    logLine("select a node first");
    return;
  }
  const files = state.fsSnapshot.items.filter(
    (i) => normRel(parentRelPath(i.relPath)) === normRel(id) && i.type === "file",
  );
  state.selection.relPath = files[0]?.relPath || null;
  logLine(`selection: ${state.selection.relPath || "none"}`);
  appendSelectHistory(`Select children → ${state.selection.relPath || "none"}`);
  updateWsBar();
}

function selectVisibleFiles() {
  const files = [];
  for (const [nid] of state.graph.nodesById.entries()) {
    if (!nodeIsVisible(nid)) {
      continue;
    }
    const it = findItemById(nid);
    if (it && it.type === "file") {
      files.push(it.relPath);
    }
  }
  state.selection.relPath = files[0] || null;
  logLine(`selection: ${state.selection.relPath || "none"} (${files.length} visible files)`);
  appendSelectHistory(`Select visible files → ${state.selection.relPath || "none"} (${files.length})`);
  updateWsBar();
}

function clearExtSelection() {
  state.extSelection = null;
}

function applyExtSelection(ext, opts = {}) {
  const silent = Boolean(opts.silent);
  const extLower = String(ext).trim().replace(/^\./, "").toLowerCase();
  if (!extLower) {
    return;
  }
  if (!silent) {
    pushCliUndo();
  }
  clearCardSelection();
  const files = [];
  const folderIds = new Set();
  for (const item of state.fsSnapshot.items) {
    if (item.type !== "file") {
      continue;
    }
    const idx = item.name.lastIndexOf(".");
    const fe = idx >= 0 && idx < item.name.length - 1 ? item.name.slice(idx + 1).toLowerCase() : "";
    if (fe !== extLower) {
      continue;
    }
    files.push(item.relPath);
    let p = parentRelPath(item.relPath);
    while (true) {
      folderIds.add(itemIdFromRelPath(p));
      if (!p) {
        break;
      }
      p = parentRelPath(p);
    }
  }
  state.extSelection = { ext: extLower, folderIds };
  state.workspace.sortMode = "name-asc";
  if (!silent) {
    logLine(`select ext ${extLower}: ${files.length} files, ${folderIds.size} folder nodes highlighted`);
    appendSelectHistory(`Ext filter: .${extLower} (${files.length} files)`);
  }
}

function syncWorkspaceFromGraphSelection() {
  /* Reader rows come from getWorkingSetItems(); graph folder selection does not maintain a separate list. */
}

function getBaseReaderRowsForDisplay() {
  let rows = getWorkingSetItems().filter((i) => i.type === "file");
  const f = state.workspace.filterText.trim().toLowerCase();
  if (f) {
    rows = rows.filter(
      (i) =>
        i.name.toLowerCase().includes(f) || normRel(i.relPath).toLowerCase().includes(f),
    );
  }
  const sortMode = state.workspace.sortMode === "manual" ? "name-asc" : state.workspace.sortMode;
  const byName = (a, b) => a.name.localeCompare(b.name);
  const byType = (a, b) => a.type.localeCompare(b.type);
  const sorted = [...rows];
  switch (sortMode) {
    case "name-desc":
      sorted.sort((a, b) => byName(b, a));
      break;
    case "type-asc":
      sorted.sort((a, b) => byType(a, b) || byName(a, b));
      break;
    case "type-desc":
      sorted.sort((a, b) => byType(b, a) || byName(a, b));
      break;
    default:
      sorted.sort(byName);
  }
  return sorted;
}

function getWorkspaceRowsForDisplay() {
  const base = getBaseReaderRowsForDisplay();
  const pf = state.workspace.pipelineResultFilter;
  const pipeActive = state.cardRender.pipeline && state.cardRender.pipeline.length > 0;
  if (!pf || !pipeActive) {
    return base;
  }
  const map = state.readerPipelineMatchByRel;
  return base.filter((i) => {
    const k = normRel(i.relPath);
    if (!map.has(k)) {
      return true;
    }
    const hit = map.get(k);
    if (pf === "matched") {
      return hit;
    }
    if (pf === "empty") {
      return !hit;
    }
    return true;
  });
}

function applyPipelineResultFilterToDeck() {
  if (!els.workspaceDeck) {
    return;
  }
  const pf = state.workspace.pipelineResultFilter;
  const pipeActive = state.cardRender.pipeline && state.cardRender.pipeline.length > 0;
  if (!pf || !pipeActive) {
    for (const c of els.workspaceDeck.querySelectorAll(".file-card")) {
      c.classList.remove("file-card--pf-hidden");
    }
    return;
  }
  const map = state.readerPipelineMatchByRel;
  for (const card of els.workspaceDeck.querySelectorAll(".file-card")) {
    const rp = card.dataset.relPath;
    if (!rp) {
      continue;
    }
    const k = normRel(rp);
    let show = true;
    if (map.has(k)) {
      const hit = map.get(k);
      if (pf === "matched") {
        show = hit;
      } else if (pf === "empty") {
        show = !hit;
      }
    }
    card.classList.toggle("file-card--pf-hidden", !show);
  }
}

function moveWorkspaceEntryBefore(_dragRel, _targetRel) {
  /* Reader order follows working set + sort; drag reorder disabled. */
}

function getCanvasCssSize() {
  const rect = els.graphCanvas.getBoundingClientRect();
  return { w: rect.width, h: rect.height };
}

function screenToWorld(sx, sy) {
  const { w, h } = getCanvasCssSize();
  const cam = state.camera;
  return {
    x: cam.x + (sx - w * 0.5) / cam.scale,
    y: cam.y + (sy - h * 0.5) / cam.scale,
  };
}

function hitTestNodeId(sx, sy) {
  const wpos = screenToWorld(sx, sy);
  let best = "";
  let bestD = Infinity;
  const hitPad = 10;
  for (const [id, node] of state.graph.nodesById.entries()) {
    if (!nodeIsVisible(id)) {
      continue;
    }
    const d = Math.hypot(node.x - wpos.x, node.y - wpos.y);
    const r = id === state.view.selectedId ? 14 : 11;
    if (d < r + hitPad && d < bestD) {
      bestD = d;
      best = id;
    }
  }
  return best;
}

function setHighlightForCardFile(relPath) {
  const p = parentRelPath(relPath);
  const parentId = itemIdFromRelPath(p);
  const siblingIds = new Set();
  const fileId = itemIdFromRelPath(relPath);
  for (const item of state.fsSnapshot.items) {
    const id = itemIdFromRelPath(item.relPath);
    if (normRel(parentRelPath(item.relPath)) !== normRel(p)) {
      continue;
    }
    if (id !== fileId) {
      siblingIds.add(id);
    }
  }
  state.highlight = { parentId, siblingIds, fileId };
}

function selectCardInDeck(relPath) {
  state.workspace.selectedCardRelPath = relPath;
  state.selection.relPath = relPath;
  setHighlightForCardFile(relPath);
  appendSelectHistory(`Reader card (render scope): ${relPath.split("/").pop() || relPath}`);
  renderWorkspaceDeck();
  updateSelectionHud();
}

function clearCardSelection() {
  state.workspace.selectedCardRelPath = null;
  state.highlight = null;
  state.selection.relPath = null;
}

function logLine(text) {
  state.logLines.push({ text: String(text), t0: performance.now() });
  while (state.logLines.length > 140) {
    state.logLines.shift();
  }
}

function updateControlInputs() {
  /* Deck filter/sort are CLI-only (reader filter, reader sort). */
}

function getSelectedItem() {
  return findItemById(state.view.selectedId);
}

function getNeighborIds(id) {
  const neighbors = new Set();
  for (const link of state.graph.links) {
    if (link.a === id) {
      neighbors.add(link.b);
    } else if (link.b === id) {
      neighbors.add(link.a);
    }
  }
  neighbors.delete(id);
  return [...neighbors];
}

function isHighlightId(id) {
  const h = state.highlight;
  if (!h) {
    return false;
  }
  if (id === h.parentId) {
    return "parent";
  }
  if (id === h.fileId) {
    return "self";
  }
  if (h.siblingIds.has(id)) {
    return "sibling";
  }
  return false;
}

function isGraphFocusNode(id) {
  if (state.highlight) {
    const h = state.highlight;
    return id === h.parentId || id === h.fileId || h.siblingIds.has(id);
  }
  if (state.extSelection) {
    return id === ROOT_ID || state.extSelection.folderIds.has(id);
  }
  return true;
}

function graphDimActive() {
  return Boolean(state.highlight || state.extSelection);
}

/** When reader matched/empty + card render: tint file nodes by pipeline hit vs current reader filter. */
function getPipelineReaderGraphTint(id, item, hi, extHi) {
  if (hi || extHi || id === ROOT_ID) {
    return null;
  }
  if (!item || item.type !== "file") {
    return null;
  }
  const pf = state.workspace.pipelineResultFilter;
  if (!pf || (pf !== "matched" && pf !== "empty")) {
    return null;
  }
  if (!state.cardRender.pipeline || !state.cardRender.pipeline.length) {
    return null;
  }
  const k = normRel(item.relPath);
  const map = state.readerPipelineMatchByRel;
  if (!map.has(k)) {
    return { fill: pastelForId(id), r: 9, pending: true };
  }
  const hit = map.get(k);
  const inReader = pf === "matched" ? hit : !hit;
  if (inReader) {
    return { fill: "#4a9e7e", r: 11, inReader: true };
  }
  return { fill: "#3d4a5c", r: 9, inReader: false };
}

function formatBytes(n) {
  if (n == null || !Number.isFinite(n)) {
    return "";
  }
  const k = 1024;
  if (n < k) {
    return `${Math.round(n)} B`;
  }
  if (n < k * k) {
    return `${(n / k).toFixed(1)} KB`;
  }
  if (n < k * k * k) {
    return `${(n / (k * k)).toFixed(1)} MB`;
  }
  return `${(n / (k * k * k)).toFixed(1)} GB`;
}

function scheduleAfterFrame(fn) {
  requestAnimationFrame(() => requestAnimationFrame(fn));
}

/** When there is a graph/deck selection, load previews for the active set (selection + working set) before other deck-only rows. */
function prioritizeDeckJobs(jobs) {
  if (!jobs.length) {
    return;
  }
  jobs.forEach((job, i) => {
    job._deckOrder = i;
  });
  const activeSel = state.selection.relPath || state.workspace.selectedCardRelPath;
  if (!activeSel) {
    return;
  }
  const selKey = normRel(activeSel);
  let wsFiles;
  try {
    wsFiles = new Set(
      getWorkingSetItems()
        .filter((i) => i.type === "file")
        .map((i) => normRel(i.relPath)),
    );
  } catch {
    wsFiles = new Set();
  }
  jobs.sort((a, b) => {
    const ar = normRel(a.relPath);
    const br = normRel(b.relPath);
    const rank = (rel) => {
      if (rel === selKey) {
        return 0;
      }
      if (wsFiles.has(rel)) {
        return 1;
      }
      return 2;
    };
    const ra = rank(ar);
    const rb = rank(br);
    if (ra !== rb) {
      return ra - rb;
    }
    return a._deckOrder - b._deckOrder;
  });
}

function setHeadTailSectionsVisible(headWrap, tailWrap, visible) {
  headWrap.classList.toggle("file-card-seg-hidden", !visible);
  tailWrap.classList.toggle("file-card-seg-hidden", !visible);
}

function loadCardRenderSavedMap() {
  try {
    const raw = localStorage.getItem(STORAGE_CARD_RENDER_SAVED);
    return raw ? JSON.parse(raw) : {};
  } catch {
    return {};
  }
}

function saveCardRenderSavedMap(map) {
  localStorage.setItem(STORAGE_CARD_RENDER_SAVED, JSON.stringify(map));
}

async function runPipelinedCardPreview(job) {
  const {
    card,
    item,
    titleEl,
    abstractEl,
    sectionsHost,
    headWrap,
    tailWrap,
    body,
    pipelineHost,
    hl,
    tl,
  } = job;
  if (!card.isConnected || !state.rootDir || !EP) {
    return;
  }

  abstractEl.classList.add("hidden");
  abstractEl.textContent = "";
  sectionsHost.classList.add("hidden");
  sectionsHost.innerHTML = "";
  setHeadTailSectionsVisible(headWrap, tailWrap, false);
  pipelineHost.classList.remove("hidden");
  pipelineHost.textContent = "Loading…";
  titleEl.textContent = item.name;

  body.querySelectorAll("img.file-card-hero").forEach((el) => el.remove());

  const ht = await window.explorerApi.fileHeadTail(state.rootDir, item.fullPath, hl, tl);
  if (!card.isConnected) {
    return;
  }
  let merged = "";
  if (ht.ok) {
    merged = ht.merged ? ht.head : [ht.head, ht.tail].filter(Boolean).join("\n---\n");
  }
  const rawOut = EP.applyPipelineToText(merged, state.cardRender.pipeline);
  if (!card.isConnected) {
    return;
  }
  const displayOut = ht.ok ? rawOut || "—" : rawOut || ht.error || "—";
  pipelineHost.textContent = displayOut;
  state.readerPipelineMatchByRel.set(normRel(item.relPath), Boolean(String(rawOut || "").trim()));
  updateWsBar();
  applyPipelineResultFilterToDeck();
}

async function runDeckCardLoad(job) {
  const {
    card,
    relPath,
    item,
    abstractEl,
    titleEl,
    headWrap,
    tailWrap,
    headSeg,
    tailSeg,
    sectionsHost,
    body,
    pathEl,
    pipelineHost,
    hl,
    tl,
  } = job;

  if (!card.isConnected || !state.rootDir) {
    return;
  }

  if (EP && shouldApplyCardRender(relPath) && state.cardRender.pipeline && state.cardRender.pipeline.length) {
    await runPipelinedCardPreview(job);
    return;
  }

  pipelineHost.classList.add("hidden");
  pipelineHost.textContent = "";

  const idxDot = item.name.lastIndexOf(".");
  const extLower =
    idxDot >= 0 && idxDot < item.name.length - 1 ? item.name.slice(idxDot + 1).toLowerCase() : "";
  const isCsvLike = extLower === "csv" || extLower === "tsv";

  let res;
  try {
    res = await window.explorerApi.fileCardPreview(
      state.rootDir,
      item.fullPath,
      state.settings.mdSectionTitles,
    );
  } catch {
    abstractEl.textContent = "Preview failed";
    return;
  }

  if (!res.ok) {
    abstractEl.classList.remove("hidden");
    abstractEl.textContent = res.error || "No preview";
    if (isCsvLike) {
      const csv = await window.explorerApi.csvPreview(state.rootDir, item.fullPath);
      if (csv.ok && csv.columns && csv.columns.length) {
        const lines = csv.columns.map((c, i) => {
          const ty = csv.columnTypes && csv.columnTypes[i];
          return ty && ty !== "string" ? `${c} (${ty})` : c;
        });
        abstractEl.textContent = lines.join(" · ");
      }
    }
    sectionsHost.classList.remove("hidden");
    setHeadTailSectionsVisible(headWrap, tailWrap, false);
    return;
  }

  const kind = res.kind === "file" ? "text" : res.kind;

  if (kind === "image") {
    abstractEl.classList.add("hidden");
    abstractEl.textContent = "";
    sectionsHost.classList.add("hidden");
    setHeadTailSectionsVisible(headWrap, tailWrap, false);
    titleEl.textContent = res.name || item.name;
    if (res.imageUrl) {
      const img = document.createElement("img");
      img.src = res.imageUrl;
      img.alt = "";
      img.className = "file-card-hero";
      body.insertBefore(img, pathEl);
    }
    return;
  }

  abstractEl.classList.remove("hidden");
  sectionsHost.classList.remove("hidden");

  if (kind === "binary") {
    abstractEl.textContent = `Binary · ${res.ext || ""} · ${res.sizeLabel || formatBytes(res.sizeBytes)}`;
    setHeadTailSectionsVisible(headWrap, tailWrap, false);
    return;
  }

  if (kind === "csv") {
    const cols = res.columns || [];
    const types = res.columnTypes || [];
    const shape = res.shape || {};
    const colParts = cols.map((c, i) => {
      const ty = types[i];
      return ty && ty !== "string" ? `${c} (${ty})` : c;
    });
    let shapeStr = `${shape.cols ?? cols.length} columns`;
    if (shape.rowsInSnippet != null) {
      shapeStr += shape.truncated
        ? ` · ≥${shape.rowsInSnippet} rows (partial)`
        : ` · ${shape.rowsInSnippet} rows in view`;
    }
    if (shape.fileBytes != null) {
      shapeStr += ` · ${formatBytes(shape.fileBytes)}`;
    }
    abstractEl.textContent = colParts.join(" · ") + `\n${shapeStr}`;
    setHeadTailSectionsVisible(headWrap, tailWrap, false);
    return;
  }

  if (kind === "notebook") {
    const bits = [
      `Notebook · ${res.cellCount ?? "?"} cells`,
      res.nbformat ? `nbformat ${res.nbformat}` : "",
      res.language ? String(res.language) : "",
    ].filter(Boolean);
    abstractEl.textContent = bits.join(" · ") + (res.sizeBytes != null ? ` · ${formatBytes(res.sizeBytes)}` : "");
    setHeadTailSectionsVisible(headWrap, tailWrap, false);
    return;
  }

  if (kind === "markdown") {
    titleEl.textContent = res.title || item.name;
    const h1 = res.h1Headings || [];
    abstractEl.textContent = h1.length ? h1.map((h) => `· ${h}`).join("\n") : "—";
    sectionsHost.innerHTML = "";
    const secObj = res.sections && typeof res.sections === "object" ? res.sections : {};
    for (const name of state.settings.mdSectionTitles) {
      const text = secObj[name];
      if (text === undefined || text === "") {
        continue;
      }
      const wrap = document.createElement("div");
      wrap.className = "file-card-mdsec";
      const lab = document.createElement("div");
      lab.className = "seg-label";
      lab.textContent = name;
      const seg = document.createElement("div");
      seg.className = "file-card-seg file-card-seg-md";
      seg.textContent = text;
      wrap.appendChild(lab);
      wrap.appendChild(seg);
      sectionsHost.appendChild(wrap);
    }
    if (res.imageUrl) {
      const img = document.createElement("img");
      img.src = res.imageUrl;
      img.alt = "";
      img.className = "file-card-hero";
      body.insertBefore(img, pathEl);
    }
    setHeadTailSectionsVisible(headWrap, tailWrap, false);
    return;
  }

  titleEl.textContent = res.name || item.name;
  abstractEl.textContent = `Text · ${res.ext || ""}${res.sizeBytes != null ? ` · ${formatBytes(res.sizeBytes)}` : ""}`;
  setHeadTailSectionsVisible(headWrap, tailWrap, true);
  const ht = await window.explorerApi.fileHeadTail(state.rootDir, item.fullPath, hl, tl);
  if (!card.isConnected) {
    return;
  }
  if (ht.ok) {
    headSeg.textContent = ht.head || "—";
    tailSeg.textContent = ht.tail || (ht.merged ? "(same as head — short file)" : "—");
  } else {
    headSeg.textContent = ht.error || "—";
    tailSeg.textContent = "—";
  }
}

// Build the DOM for a single file card and return a job descriptor for async
// content loading. Returns null if there is no root loaded yet.
// Registered as the "file" card renderer via EP.registerCardRenderer.
function buildFileCard(item, card, rowIndex1) {
  const relPath = item.relPath;

  const row = document.createElement("div");
  row.style.display = "flex";
  row.style.gap = "8px";
  row.style.alignItems = "flex-start";

  const grip = document.createElement("button");
  grip.type = "button";
  grip.className = "file-card-open";
  grip.textContent = "↗";
  grip.title = "Open file in tab";
  grip.addEventListener("click", (e) => {
    e.stopPropagation();
    parseCommand(`open "${relPath}"`);
  });

  const body = document.createElement("div");
  body.style.flex = "1";
  body.style.minWidth = "0";

  const titleEl = document.createElement("h3");
  titleEl.className = "file-card-title";
  titleEl.textContent = item.name;

  const abstractEl = document.createElement("p");
  abstractEl.className = "file-card-abstract";
  abstractEl.textContent = "Loading preview…";

  const pipelineHost = document.createElement("div");
  pipelineHost.className = "file-card-pipeline-out hidden";
  pipelineHost.setAttribute("aria-label", "Custom render output");

  const headWrap = document.createElement("div");
  const headLabel = document.createElement("div");
  headLabel.className = "seg-label";
  headLabel.textContent = `head(${state.settings.cardHeadLines})`;
  const headSeg = document.createElement("div");
  headSeg.className = "file-card-seg file-card-seg-head";
  headSeg.textContent = "…";

  const tailWrap = document.createElement("div");
  const tailLabel = document.createElement("div");
  tailLabel.className = "seg-label";
  tailLabel.textContent = `tail(${state.settings.cardTailLines})`;
  const tailSeg = document.createElement("div");
  tailSeg.className = "file-card-seg file-card-seg-tail";
  tailSeg.textContent = "…";

  headWrap.appendChild(headLabel);
  headWrap.appendChild(headSeg);
  tailWrap.appendChild(tailLabel);
  tailWrap.appendChild(tailSeg);

  const pathEl = document.createElement("div");
  pathEl.className = "file-card-path";
  pathEl.textContent = relPath;

  const sectionsHost = document.createElement("div");
  sectionsHost.className = "file-card-sections";

  body.appendChild(titleEl);
  body.appendChild(abstractEl);
  body.appendChild(pipelineHost);
  body.appendChild(sectionsHost);
  body.appendChild(headWrap);
  body.appendChild(tailWrap);
  body.appendChild(pathEl);

  row.appendChild(grip);
  row.appendChild(body);
  card.appendChild(row);

  body.addEventListener("click", () => {
    selectCardInDeck(relPath);
  });

  if (!state.rootDir) return null;
  return {
    card,
    rowIndex1,
    relPath,
    item,
    abstractEl,
    titleEl,
    headWrap,
    tailWrap,
    headSeg,
    tailSeg,
    sectionsHost,
    body,
    pathEl,
    pipelineHost,
    hl: state.settings.cardHeadLines,
    tl: state.settings.cardTailLines,
  };
}

function renderWorkspaceDeck() {
  const basePrune = getBaseReaderRowsForDisplay();
  const allowedRel = new Set(basePrune.map((r) => normRel(r.relPath)));
  for (const k of [...state.readerPipelineMatchByRel.keys()]) {
    if (!allowedRel.has(k)) {
      state.readerPipelineMatchByRel.delete(k);
    }
  }

  els.workspaceDeck.innerHTML = "";
  const rows = getWorkspaceRowsForDisplay();
  if (rows.length === 0) {
    const empty = document.createElement("p");
    empty.className = "muted";
    empty.textContent =
      "No files in the reader. Widen the working set (clear filters / select ext / expand) or load a root with matching files.";
    els.workspaceDeck.appendChild(empty);
    updateWsBar();
    return;
  }

  const deckJobs = [];

  for (let idx = 0; idx < rows.length; idx += 1) {
    const item = rows[idx];
    const rowIndex1 = idx + 1;

    const card = document.createElement("div");
    card.className = "file-card";
    if (state.workspace.selectedCardRelPath === item.relPath) {
      card.classList.add("selected");
    }
    card.dataset.relPath = item.relPath;

    const nodeType = item.nodeType || item.type || "file";
    const renderer = EP.getCardRenderer(nodeType);
    if (renderer) {
      const job = renderer(item, card, rowIndex1);
      if (job) deckJobs.push(job);
    }

    els.workspaceDeck.appendChild(card);
  }

  prioritizeDeckJobs(deckJobs);

  updateWsBar();
  applyPipelineResultFilterToDeck();

  if (deckJobs.length && state.rootDir) {
    scheduleAfterFrame(() => {
      deckJobs.forEach((job, i) => {
        setTimeout(() => {
          void runDeckCardLoad(job);
        }, 36 + i * 24);
      });
    });
  }
}

function buildGraph() {
  // Update visible node set for nodeIsVisible() — text+tag pre-filter, no ext
  state.view.visibleNodeIds = new Set(getFilteredSortedItems().map((i) => i.relPath));

  const ctx = {
    state,
    existing: state.graph.nodesById,
    world: state.world,
  };

  const { nodesById, links } = EP.mergeGraphSources(EP.GRAPH_SOURCES, ctx);
  state.graph.nodesById = nodesById;
  state.graph.links = links;
}

function resizeCanvas() {
  const rect = els.graphCanvas.getBoundingClientRect();
  const dpr = window.devicePixelRatio;
  els.graphCanvas.width = Math.max(200, Math.floor(rect.width * dpr));
  els.graphCanvas.height = Math.max(200, Math.floor(rect.height * dpr));
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
}

function nodeIsVisible(id) {
  if (isHighlightId(id)) {
    return true;
  }
  if (state.extraLinkEndpoints.has(id)) {
    return true; // extra-linked nodes always visible regardless of mode
  }
  if (state.extSelection) {
    const item = findItemById(id);
    if (item && item.type === "folder" && state.extSelection.folderIds.has(id)) {
      return true;
    }
  }
  if (id === ROOT_ID) {
    return true;
  }
  const item = findItemById(id);
  if (item && !EP.isNodeTypeVisibleInMode(item.type, state.view.mode)) {
    return false;
  }
  if (state.view.visibleNodeIds.has(id)) {
    return true;
  }
  if (id === state.view.selectedId) {
    return true;
  }
  return getNeighborIds(state.view.selectedId).includes(id);
}

function folderSummarySuffix(id) {
  const fields = state.view.labelFields;
  if (fields.size === 0) {
    return "";
  }

  const parts = [];
  if (fields.has("count")) {
    const count = state.fsSnapshot.fileCountByFolder.get(id) || 0;
    parts.push(`count:${count}`);
  }
  if (fields.has("type")) {
    const typeCounts = state.fsSnapshot.typeCountsByFolder.get(id) || {};
    const types = Object.keys(typeCounts)
      .sort()
      .map((k) => `${k}:${typeCounts[k]}`)
      .join("|");
    parts.push(`type:${types || "none"}`);
  }
  return parts.length > 0 ? ` {${parts.join(" ")}}` : "";
}

function drawGraph() {
  const dpr = window.devicePixelRatio;
  const cssW = els.graphCanvas.width / dpr;
  const cssH = els.graphCanvas.height / dpr;
  ctx.clearRect(0, 0, cssW, cssH);

  const cam = state.camera;
  ctx.save();
  ctx.translate(cssW * 0.5, cssH * 0.5);
  ctx.scale(cam.scale, cam.scale);
  ctx.translate(-cam.x, -cam.y);

  // Extra (non-tree) links drawn first so tree links render on top
  const EXTRA_LINK_RGBA = {
    ext:     "120,220,130",
    tags:    "190,120,255",
    name:    "255,210,70",
    grep:    "255,150,70",
    imports: "90,170,255",
    refs:    "70,210,190",
  };
  if (state.extraLinks.length > 0) {
    ctx.save();
    ctx.setLineDash([4 / cam.scale, 4 / cam.scale]);
    ctx.lineWidth = 1.5 / cam.scale;
    for (const link of state.extraLinks) {
      if (!nodeIsVisible(link.a) || !nodeIsVisible(link.b)) continue;
      const na = state.graph.nodesById.get(link.a);
      const nb = state.graph.nodesById.get(link.b);
      if (!na || !nb) continue;
      const rgb = EXTRA_LINK_RGBA[link.kind] || "200,200,200";
      ctx.strokeStyle = `rgba(${rgb},0.22)`;
      ctx.beginPath();
      ctx.moveTo(na.x, na.y);
      ctx.lineTo(nb.x, nb.y);
      ctx.stroke();
    }
    ctx.setLineDash([]);
    ctx.restore();
  }

  const dim = graphDimActive();
  for (const link of state.graph.links) {
    if (!nodeIsVisible(link.a) || !nodeIsVisible(link.b)) {
      continue;
    }
    const na = state.graph.nodesById.get(link.a);
    const nb = state.graph.nodesById.get(link.b);
    if (!na || !nb) {
      continue;
    }
    const fa = isGraphFocusNode(link.a);
    const fb = isGraphFocusNode(link.b);
    let alpha = 0.09;
    if (dim) {
      if (fa && fb) {
        alpha = 0.14;
      } else if (fa || fb) {
        alpha = 0.06;
      } else {
        alpha = 0.035;
      }
    }
    ctx.beginPath();
    ctx.strokeStyle = `rgba(255,255,255,${alpha})`;
    ctx.lineWidth = 1 / cam.scale;
    ctx.moveTo(na.x, na.y);
    ctx.lineTo(nb.x, nb.y);
    ctx.stroke();
  }

  for (const [id, node] of state.graph.nodesById.entries()) {
    if (!nodeIsVisible(id)) {
      continue;
    }
    const item = findItemById(id);
    const graphSel = id === state.view.selectedId;
    const hi = isHighlightId(id);
    const extHi =
      state.extSelection && item && item.type === "folder" && state.extSelection.folderIds.has(id);
    const isFolder = item && item.type === "folder";
    let r = graphSel ? 11 : 8;
    let fill = id === ROOT_ID ? "#3a4552" : pastelForId(id);

    if (hi === "parent") {
      fill = "#f4e6a8";
      r = Math.max(r, 12);
    } else if (hi === "self") {
      fill = "#e8d4ff";
      r = Math.max(r, 11);
    } else if (hi === "sibling") {
      fill = "#7ec8b8";
      r = Math.max(r, 10);
    } else if (extHi && !hi) {
      fill = "#c9a227";
      r = Math.max(r, 10);
    }

    const pipeTint = getPipelineReaderGraphTint(id, item, hi, extHi);
    if (pipeTint) {
      fill = pipeTint.fill;
      r = Math.max(r, pipeTint.r);
    }

    const faded = dim && !isGraphFocusNode(id);
    const nodeAlpha = faded ? 0.22 : 1;
    ctx.globalAlpha = nodeAlpha;

    ctx.beginPath();
    ctx.fillStyle = fill;
    ctx.strokeStyle = graphSel ? "rgba(255,255,255,0.65)" : "rgba(0,0,0,0.22)";
    ctx.lineWidth = graphSel ? 2.2 / cam.scale : 1 / cam.scale;
    if (hi === "parent") {
      ctx.strokeStyle = "rgba(255,220,120,0.95)";
      ctx.lineWidth = 2.8 / cam.scale;
    } else if (hi === "self") {
      ctx.strokeStyle = "rgba(240,220,255,0.95)";
      ctx.lineWidth = 2.6 / cam.scale;
    } else if (hi === "sibling") {
      ctx.strokeStyle = "rgba(120,220,200,0.85)";
      ctx.lineWidth = 2 / cam.scale;
    } else if (extHi && !hi) {
      ctx.strokeStyle = "rgba(255,210,90,0.9)";
      ctx.lineWidth = 2.2 / cam.scale;
    } else if (pipeTint && pipeTint.inReader) {
      ctx.strokeStyle = "rgba(140, 235, 195, 0.55)";
      ctx.lineWidth = 2.1 / cam.scale;
    } else if (pipeTint && pipeTint.pending) {
      ctx.strokeStyle = "rgba(255,255,255,0.2)";
      ctx.lineWidth = 1.2 / cam.scale;
    }
    ctx.arc(node.x, node.y, r, 0, Math.PI * 2);
    ctx.fill();
    ctx.stroke();

    if (isFolder && id !== ROOT_ID) {
      ctx.beginPath();
      ctx.strokeStyle = `rgba(255,255,255,${0.14 * nodeAlpha})`;
      ctx.lineWidth = 1 / cam.scale;
      ctx.arc(node.x, node.y, r + 3.5 / cam.scale, 0, Math.PI * 2);
      ctx.stroke();
    }

    ctx.save();
    ctx.font = `${12 / cam.scale}px Segoe UI, system-ui, sans-serif`;
    ctx.fillStyle = `rgba(248,246,238,${0.92 * nodeAlpha})`;
    ctx.shadowColor = "rgba(0,0,0,0.55)";
    ctx.shadowBlur = 4 / cam.scale;
    ctx.shadowOffsetX = 0;
    ctx.shadowOffsetY = 1 / cam.scale;
    let label = id === ROOT_ID ? "root" : item.name;
    if (id === ROOT_ID || (item && item.type === "folder")) {
      label += folderSummarySuffix(id);
    }
    ctx.fillText(label, node.x + r + 6 / cam.scale, node.y + 4 / cam.scale);
    ctx.restore();
    ctx.globalAlpha = 1;
  }

  ctx.restore();

  drawLogOverlay(cssW, cssH, dpr);
}

function drawLogOverlay(cssW, cssH, dpr) {
  const now = performance.now();
  const fadeMs = state.settings.logFadeMs;
  if (!state.cliLogHovered) {
    state.logLines = state.logLines.filter((l) => now - l.t0 < fadeMs + 400);
  }

  ctx.save();
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  ctx.font = "11px ui-monospace, Consolas, monospace";
  const topPad = state.settings.cliInputAnchor === "top" ? 52 : 18;
  let y = topPad;
  for (let i = state.logLines.length - 1; i >= 0; i -= 1) {
    const line = state.logLines[i];
    const age = now - line.t0;
    if (!state.cliLogHovered && age > fadeMs) {
      continue;
    }
    const alpha = state.cliLogHovered ? 1 : 1 - age / fadeMs;
    ctx.fillStyle = `rgba(230,235,240,${0.18 + 0.72 * Math.max(0, alpha)})`;
    const text = line.text.length > 160 ? `${line.text.slice(0, 157)}…` : line.text;
    ctx.fillText(text, 14, y);
    y += 14;
    if (y > cssH - 96) {
      break;
    }
  }
  ctx.restore();
}

function pointInCliLogRegion(sx, sy, cssW, cssH) {
  const topPad = state.settings.cliInputAnchor === "top" ? 52 : 18;
  const lineH = 14;
  const maxY = cssH - 96;
  const maxLines = Math.max(1, Math.floor((maxY - topPad) / lineH));
  const n = Math.min(state.logLines.length, maxLines);
  const bottom = topPad + n * lineH + 6;
  return sx >= 4 && sx <= cssW - 4 && sy >= topPad - 4 && sy <= bottom;
}

function tickGraph() {
  const { w: worldW, h: worldH } = state.world;
  const centerX = worldW * 0.5;
  const centerY = worldH * 0.5;
  const dragId = state.interaction.mode === "node" ? state.interaction.nodeId : null;
  const pinned = state.graph.pinnedIds;
  const g = state.settings.graphGravity;
  const linkK = state.settings.graphLinkStrength;
  const rep = state.settings.graphRepulsion;
  const damp = state.settings.graphDamping;

  const nodes = [...state.graph.nodesById.values()];
  for (const node of nodes) {
    if (dragId && node.id === dragId) {
      continue;
    }
    if (pinned.has(node.id)) {
      node.vx = 0;
      node.vy = 0;
      continue;
    }
    node.vx *= damp;
    node.vy *= damp;
    node.vx += (centerX - node.x) * g;
    node.vy += (centerY - node.y) * g;
  }

  for (const link of state.graph.links) {
    const a = state.graph.nodesById.get(link.a);
    const b = state.graph.nodesById.get(link.b);
    if (!a || !b) {
      continue;
    }
    if (dragId && (a.id === dragId || b.id === dragId)) {
      const free = a.id === dragId ? b : a;
      if (!pinned.has(free.id)) {
        free.vx *= 0.92;
        free.vy *= 0.92;
      }
    }
    const dx = b.x - a.x;
    const dy = b.y - a.y;
    const dist = Math.max(1, Math.hypot(dx, dy));
    const target = 72;
    const force = (dist - target) * linkK;
    const fx = (dx / dist) * force;
    const fy = (dy / dist) * force;
    if ((!dragId || a.id !== dragId) && !pinned.has(a.id)) {
      a.vx += fx;
      a.vy += fy;
    }
    if ((!dragId || b.id !== dragId) && !pinned.has(b.id)) {
      b.vx -= fx;
      b.vy -= fy;
    }
  }

  // Extra (non-tree) link spring forces — weaker than tree links
  const extraK = linkK * 0.4;
  for (const link of state.extraLinks) {
    const a = state.graph.nodesById.get(link.a);
    const b = state.graph.nodesById.get(link.b);
    if (!a || !b) continue;
    if (dragId && (a.id === dragId || b.id === dragId)) continue;
    const dx = b.x - a.x;
    const dy = b.y - a.y;
    const dist = Math.max(1, Math.hypot(dx, dy));
    const target = 90;
    const force = (dist - target) * extraK;
    const fx = (dx / dist) * force;
    const fy = (dy / dist) * force;
    if (!pinned.has(a.id)) { a.vx += fx; a.vy += fy; }
    if (!pinned.has(b.id)) { b.vx -= fx; b.vy -= fy; }
  }

  // O(n²) repulsion — limit to visible nodes only to keep large repos fast
  const visibleNodes = nodes.filter((n) => nodeIsVisible(n.id));
  for (let i = 0; i < visibleNodes.length; i += 1) {
    for (let j = i + 1; j < visibleNodes.length; j += 1) {
      const a = visibleNodes[i];
      const b = visibleNodes[j];
      if (dragId && (a.id === dragId || b.id === dragId)) {
        continue;
      }
      if (pinned.has(a.id) && pinned.has(b.id)) {
        continue;
      }
      const dx = b.x - a.x;
      const dy = b.y - a.y;
      const dist = Math.max(1, Math.hypot(dx, dy));
      if (dist > 150) {
        continue;
      }
      const force = (80 / (dist * dist)) * rep;
      const fx = (dx / dist) * force;
      const fy = (dy / dist) * force;
      if (!pinned.has(a.id)) {
        a.vx -= fx;
        a.vy -= fy;
      }
      if (!pinned.has(b.id)) {
        b.vx += fx;
        b.vy += fy;
      }
    }
  }

  const pad = 24;
  for (const node of nodes) {
    if (dragId && node.id === dragId) {
      continue;
    }
    if (pinned.has(node.id)) {
      node.vx = 0;
      node.vy = 0;
      continue;
    }
    node.x += node.vx;
    node.y += node.vy;
    node.x = Math.max(pad, Math.min(worldW - pad, node.x));
    node.y = Math.max(pad, Math.min(worldH - pad, node.y));
  }

  drawGraph();
  state.graph.rafId = requestAnimationFrame(tickGraph);
}

function restartGraphLoop() {
  if (state.graph.rafId) {
    cancelAnimationFrame(state.graph.rafId);
  }
  state.graph.rafId = requestAnimationFrame(tickGraph);
}

async function selectNodeById(id) {
  if (!state.graph.nodesById.has(id)) {
    logLine(`node not found: ${id}`);
    return;
  }
  clearExtSelection();
  clearCardSelection();
  state.view.selectedId = id;
  const item = getSelectedItem();
  if (item && item.type === "folder") {
    state.overlay.cards = await window.explorerApi.loadCards(item.fullPath);
  } else {
    state.overlay.cards = [];
  }
  if (item && item.type === "file") {
    state.selection.relPath = item.relPath;
  } else {
    state.selection.relPath = null;
  }
  syncWorkspaceFromGraphSelection();
  const label =
    item == null ? (id === ROOT_ID ? "root" : id) : `${item.type} ${item.name}`;
  appendSelectHistory(`Graph · ${label}`);
  renderWorkspaceDeck();
}

function applyCard(card) {
  clearExtSelection();
  state.view.searchText = card.searchText || "";
  state.view.tagFilter = card.tagFilter || "";
  state.view.sortMode = card.sortMode || "name-asc";
  syncWorkspaceFromGraphSelection();
  buildGraph();
  renderWorkspaceDeck();
}

function computeFolderRollups(items) {
  const fileCountByFolder = new Map();
  const typeCountsByFolder = new Map();
  fileCountByFolder.set(ROOT_ID, 0);
  typeCountsByFolder.set(ROOT_ID, {});

  const ensureFolder = (folderId) => {
    if (!fileCountByFolder.has(folderId)) {
      fileCountByFolder.set(folderId, 0);
    }
    if (!typeCountsByFolder.has(folderId)) {
      typeCountsByFolder.set(folderId, {});
    }
  };

  for (const item of items) {
    if (item.type === "folder") {
      ensureFolder(item.relPath);
    }
  }

  const extFromName = (name) => {
    const idx = name.lastIndexOf(".");
    if (idx < 0 || idx === name.length - 1) {
      return "none";
    }
    return name.slice(idx + 1).toLowerCase();
  };

  for (const item of items) {
    if (item.type !== "file") {
      continue;
    }
    const parents = [];
    let p = parentRelPath(item.relPath);
    while (true) {
      parents.push(itemIdFromRelPath(p));
      if (!p) {
        break;
      }
      p = parentRelPath(p);
    }

    const ext = extFromName(item.name);
    for (const folderId of parents) {
      ensureFolder(folderId);
      fileCountByFolder.set(folderId, (fileCountByFolder.get(folderId) || 0) + 1);
      const typeCounts = typeCountsByFolder.get(folderId);
      typeCounts[ext] = (typeCounts[ext] || 0) + 1;
    }
  }

  return { fileCountByFolder, typeCountsByFolder };
}

function rebuildDerived() {
  const itemsById = new Map();
  for (const item of state.fsSnapshot.items) {
    itemsById.set(item.relPath, item);
  }
  state.fsSnapshot.itemsById = itemsById;

  const rollups = computeFolderRollups(state.fsSnapshot.items);
  state.fsSnapshot.fileCountByFolder = rollups.fileCountByFolder;
  state.fsSnapshot.typeCountsByFolder = rollups.typeCountsByFolder;

  if (!state.fsSnapshot.itemsById.has(state.view.selectedId)) {
    state.view.selectedId = ROOT_ID;
    state.overlay.cards = [];
  }

  if (state.extSelection) {
    applyExtSelection(state.extSelection.ext, { silent: true });
  } else {
    syncWorkspaceFromGraphSelection();
  }
  buildGraph();
  renderWorkspaceDeck();
}

async function refreshFromDisk() {
  if (!state.rootDir) {
    return;
  }
  const data = await window.explorerApi.loadData(state.rootDir);
  state.fsSnapshot.items = data.items;
  state.overlay.tagsByPath = data.tags || {};
  if (data.limited) {
    logLine(`warning: large repo — showing first ${data.items.length} items (20k cap)`);
  }
  pruneStaleTags();
  rebuildDerived();
  renderTagBar();
}

async function loadRoot(rootDir) {
  state.rootDir = rootDir;
  els.rootLabel.textContent = rootDir;
  state.view.selectedId = ROOT_ID;
  state.overlay.cards = [];
  state.cliUndoStack = [];
  state.cliRedoStack = [];
  state.selectHistory = [];
  renderSelectHistory();
  state.appTabs = {
    seq: 1,
    list: [{ id: "ws", kind: "workspace", label: "Workspace" }],
    activeId: "ws",
  };
  if (els.browseMount && window.EPBrowsePane) {
    EPBrowsePane.unmount(els.browseMount);
  }
  if (els.workspaceStage) {
    els.workspaceStage.hidden = false;
  }
  if (els.browseMount) {
    els.browseMount.hidden = true;
    els.browseMount.setAttribute("aria-hidden", "true");
  }
  clearExtSelection();
  clearCardSelection();
  await refreshFromDisk();
  switchAppTab("ws");
  logLine(`loaded root: ${rootDir}`);
}

function summaryCountByTypeLines() {
  const counts = {};
  for (const item of state.fsSnapshot.items) {
    if (item.type !== "file") {
      continue;
    }
    const idx = item.name.lastIndexOf(".");
    const ext = idx > -1 && idx < item.name.length - 1 ? item.name.slice(idx + 1).toLowerCase() : "none";
    counts[ext] = (counts[ext] || 0) + 1;
  }
  return Object.keys(counts)
    .sort()
    .map((k) => `${k}: ${counts[k]}`);
}

function renderAppTabs() {
  if (!els.appTabStrip) {
    return;
  }
  els.appTabStrip.innerHTML = "";
  for (const tab of state.appTabs.list) {
    const wrap = document.createElement("div");
    wrap.className =
      "app-tab-wrap" + (tab.id === state.appTabs.activeId ? " app-tab-wrap--active" : "");
    const mainBtn = document.createElement("button");
    mainBtn.type = "button";
    mainBtn.className = "app-tab-main";
    mainBtn.setAttribute("role", "tab");
    mainBtn.setAttribute("aria-selected", tab.id === state.appTabs.activeId ? "true" : "false");
    mainBtn.textContent = tab.label;
    mainBtn.addEventListener("click", () => switchAppTab(tab.id));
    wrap.appendChild(mainBtn);
    if (tab.kind === "browse") {
      const cx = document.createElement("button");
      cx.type = "button";
      cx.className = "app-tab-x";
      cx.setAttribute("aria-label", "Close tab");
      cx.textContent = "×";
      cx.addEventListener("click", (e) => {
        e.stopPropagation();
        closeAppTab(tab.id);
      });
      wrap.appendChild(cx);
    }
    els.appTabStrip.appendChild(wrap);
  }
}

function switchAppTab(id) {
  if (!els.workspaceStage || !els.browseMount) {
    return;
  }
  const tab = state.appTabs.list.find((t) => t.id === id);
  if (!tab) {
    return;
  }
  state.appTabs.activeId = id;
  if (window.EPBrowsePane) {
    EPBrowsePane.unmount(els.browseMount);
  }
  els.browseMount.innerHTML = "";
  if (tab.kind === "workspace") {
    els.workspaceStage.hidden = false;
    els.browseMount.hidden = true;
    els.browseMount.setAttribute("aria-hidden", "true");
    resizeCanvas();
  } else {
    els.workspaceStage.hidden = true;
    els.browseMount.hidden = false;
    els.browseMount.removeAttribute("aria-hidden");
    if (window.EPBrowsePane && state.rootDir) {
      EPBrowsePane.mount(els.browseMount, {
        rootDir: state.rootDir,
        targetPath: tab.browse.fullPath,
        layout: tab.browse.layout,
        kind: tab.browse.kind,
        onOpenBrowse: handleBrowseNestedOpen,
      });
    }
  }
  renderAppTabs();
}

function closeAppTab(id) {
  if (id === "ws") {
    return;
  }
  const idx = state.appTabs.list.findIndex((t) => t.id === id);
  if (idx < 0) {
    return;
  }
  state.appTabs.list.splice(idx, 1);
  if (state.appTabs.activeId === id) {
    switchAppTab("ws");
  } else {
    renderAppTabs();
  }
}

async function handleBrowseNestedOpen(payload) {
  const r = await window.explorerApi.openBrowseTab({
    rootDir: payload.rootDir || state.rootDir,
    inputPath: payload.inputPath,
    layout: payload.layout,
    forceKind: payload.forceKind,
    embed: true,
  });
  if (!r || !r.ok) {
    logLine(`browse: ${(r && r.error) || "failed"}`);
    return;
  }
  const tid = `t${state.appTabs.seq++}`;
  state.appTabs.list.push({
    id: tid,
    kind: "browse",
    label: baseNamePath(r.fullPath),
    browse: { fullPath: r.fullPath, kind: r.kind, layout: r.layout },
  });
  switchAppTab(tid);
}

async function openBrowseEmbedded(opts) {
  const r = await window.explorerApi.openBrowseTab({
    rootDir: state.rootDir,
    inputPath: opts.inputPath,
    layout: opts.layout,
    forceKind: opts.forceKind,
    embed: true,
  });
  if (!r || !r.ok) {
    return r || { ok: false, error: "failed" };
  }
  const tid = `t${state.appTabs.seq++}`;
  state.appTabs.list.push({
    id: tid,
    kind: "browse",
    label: baseNamePath(r.fullPath),
    browse: { fullPath: r.fullPath, kind: r.kind, layout: r.layout },
  });
  switchAppTab(tid);
  return { ok: true };
}

// ── Extra-link helpers ────────────────────────────────────────────────────────

function rebuildExtraLinkEndpoints() {
  const s = new Set();
  for (const l of state.extraLinks) { s.add(l.a); s.add(l.b); }
  state.extraLinkEndpoints = s;
}

function addExtraLinks(newLinks) {
  state.extraLinks.push(...newLinks);
  for (const l of newLinks) { state.extraLinkEndpoints.add(l.a); state.extraLinkEndpoints.add(l.b); }
}

function computeStructuralLinks(kind, items, tagsByPath) {
  const links = [];
  const seen = new Set();

  function addLink(a, b, k) {
    const key = a < b ? `${a}\x00${b}` : `${b}\x00${a}`;
    if (!seen.has(key)) { seen.add(key); links.push({ a, b, kind: k }); }
  }

  // Hub-and-spoke: first item links to up to 5 others, then chain the rest
  function linkGroup(group, k) {
    if (group.length < 2) return;
    const HUB = 5;
    for (let i = 1; i < Math.min(HUB + 1, group.length); i++) addLink(group[0], group[i], k);
    for (let i = 1; i < group.length - 1; i++) addLink(group[i], group[i + 1], k);
  }

  if (kind === "ext") {
    const byExt = new Map();
    for (const item of items) {
      if (item.type !== "file") continue;
      const idx = item.name.lastIndexOf(".");
      const ext = idx > 0 && idx < item.name.length - 1 ? item.name.slice(idx + 1).toLowerCase() : "";
      if (!byExt.has(ext)) byExt.set(ext, []);
      byExt.get(ext).push(item.relPath);
    }
    for (const [, group] of byExt) linkGroup(group, "ext");
  } else if (kind === "tags") {
    const byTag = new Map();
    for (const item of items) {
      const tags = tagsByPath[item.relPath];
      if (!tags || !tags.length) continue;
      for (const tag of tags) {
        if (!byTag.has(tag)) byTag.set(tag, []);
        byTag.get(tag).push(item.relPath);
      }
    }
    for (const [, group] of byTag) linkGroup(group, "tags");
  } else if (kind === "name") {
    // items is already the pre-filtered set; link them all
    linkGroup(items.map((i) => i.relPath), "name");
  }

  return links;
}

async function parseCommand(rawInput) {
  let input = rawInput.trim();
  if (!input) {
    return;
  }

  // Alias: 'render' → 'card render'
  if (/^render(\s|$)/i.test(input)) {
    input = "card render" + input.slice(6);
  }

  logLine(`> ${input}`);
  const lower = input.toLowerCase();

  if (lower === "help") {
    logLine("commands: help, pwd, cd, ls, refresh, save tags");
    logLine("filter <text>, tagfilter <text>, sort <mode>, expand children|parents|siblings|+1|clear");
    logLine("reader filter <text>|clear · reader sort manual|name-asc|…  (reader deck)");
    logLine("select <relPath> | select siblings|children|visible | select ext <ext> | select clear");
    logLine("tag set <csv>, tag add <tag>, card save <name>, card apply <n>");
    logLine("reader matched | empty | all · save copy|list · tag add · paths [n]");
    logLine("back | forward  (undo/redo); keys 4 / 6 when CLI focused");
    logLine("reader = working-set files; cards clear (reset reader filters)");
    logLine("Next: bulk/dynamic tagging from selection (size, regex, …)");
    logLine("card render … | reset | save|load|list|delete  (grep uses regex; regex keeps full lines)");
    logLine("settings … selectionhud top|bottom, cliinput top|bottom");
    logLine("mode <folders|files|hybrid>, label …, summary | summary count | summary types");
    logLine("ws | ws save|load|list|delete <name> | ws clear");
    logLine("preset save|load|list|delete <name>");
    logLine("explain");
    logLine("settings … logfade, head, tail, gravity, repulsion, link, damping, mdsections");
    logLine("canvas: wheel zoom, pan, drag nodes, right-click Pin (native menu)");
    logLine("open <path> | open dir <path> [--grid|--detail]  (in-app tab)");
    logLine("graph link ext|tags|name <pat>|grep <pat>|imports|refs|clear|list");
    return;
  }

  if (lower.startsWith("open ") || lower === "open") {
    if (!state.rootDir) {
      logLine("no root loaded");
      return;
    }
    let rest = input.slice(lower === "open" ? 4 : 5).trim();
    if (!rest) {
      logLine("usage: open <rel-or-abs path>");
      logLine("       open dir <path> [--grid|--detail]");
      return;
    }
    let layout = "detail";
    let forceKind = null;
    if (rest.toLowerCase().startsWith("dir ")) {
      rest = rest.slice(4).trim();
      forceKind = "dir";
      const parsed = parseOpenDirPathAndLayout(rest);
      layout = parsed.layout;
      rest = parsed.path;
    } else {
      rest = stripOuterQuotes(rest);
    }
    if (!rest) {
      logLine("usage: open dir <path> [--grid|--detail]");
      return;
    }
    const r = await openBrowseEmbedded({ inputPath: rest, layout, forceKind });
    if (!r || !r.ok) {
      logLine(`open: ${(r && r.error) || "failed"}`);
      return;
    }
    appendSelectHistory(
      `Open browse: ${rest}${forceKind === "dir" ? ` [dir · ${layout}]` : ""}`,
    );
    logLine("opened tab");
    return;
  }

  if (lower === "pwd") {
    logLine(state.rootDir || "(no root loaded)");
    return;
  }

  if (lower === "back") {
    runCliBack();
    return;
  }

  if (lower === "forward") {
    runCliForward();
    return;
  }

  if (lower.startsWith("reader ")) {
    const rest = input.slice(7).trim();
    const rlow = rest.toLowerCase();
    if (rlow.startsWith("filter ")) {
      const t = rest.slice(7).trim();
      pushCliUndo();
      state.workspace.filterText = t;
      renderWorkspaceDeck();
      appendSelectHistory(`Reader deck filter: ${t || "(off)"}`);
      logLine(`reader filter: ${t || "cleared"}`);
      return;
    }
    if (rlow === "filter" || rlow === "filter clear") {
      pushCliUndo();
      state.workspace.filterText = "";
      renderWorkspaceDeck();
      appendSelectHistory("Reader deck filter: (off)");
      logLine("reader filter cleared");
      return;
    }
    if (rlow.startsWith("sort ")) {
      const mode = rest.slice(5).trim();
      const valid = new Set(["manual", "name-asc", "name-desc", "type-asc", "type-desc"]);
      if (!valid.has(mode)) {
        logLine("usage: reader sort manual | name-asc | name-desc | type-asc | type-desc");
        return;
      }
      pushCliUndo();
      state.workspace.sortMode = mode;
      renderWorkspaceDeck();
      appendSelectHistory(`Reader deck sort: ${mode}`);
      logLine(`reader sort: ${mode}`);
      return;
    }
    if (rlow.startsWith("save ")) {
      const srest = rest.slice(5).trim();
      const sl = srest.toLowerCase();
      if (!state.rootDir) {
        logLine("no root loaded");
        return;
      }
      const files = getWorkspaceRowsForDisplay().filter((i) => i.type === "file");
      const relPaths = files.map((i) => i.relPath);
      if (sl.startsWith("copy ")) {
        const dest = srest.slice(5).trim();
        if (!dest) {
          logLine("usage: reader save copy <folderUnderRoot>");
          return;
        }
        const r = await window.explorerApi.readerSelectionSaveCopy({
          rootDir: state.rootDir,
          destRel: dest,
          relPaths,
        });
        if (!r || !r.ok) {
          logLine(`reader save copy: ${(r && r.error) || "failed"}`);
          return;
        }
        appendSelectHistory(`reader save copy → ${dest} (${r.copied} files)`);
        logLine(`copied ${r.copied} file(s) → ${dest}`);
        return;
      }
      if (sl.startsWith("list ")) {
        const dest = srest.slice(5).trim();
        if (!dest) {
          logLine("usage: reader save list <path.txt>");
          return;
        }
        const r = await window.explorerApi.readerSelectionSaveList({
          rootDir: state.rootDir,
          destRel: dest,
          lines: relPaths.map((p) => normRel(p)),
        });
        if (!r || !r.ok) {
          logLine(`reader save list: ${(r && r.error) || "failed"}`);
          return;
        }
        appendSelectHistory(`reader save list → ${dest} (${relPaths.length} paths)`);
        logLine(`wrote ${relPaths.length} path(s) → ${dest}`);
        return;
      }
      logLine("usage: reader save copy <folder> | reader save list <file.txt>");
      return;
    }
    if (rlow.startsWith("tag add ")) {
      const tag = rest.slice(8).trim();
      if (!tag) {
        logLine("usage: reader tag add <tag>");
        return;
      }
      const files = getWorkspaceRowsForDisplay().filter((i) => i.type === "file");
      let n = 0;
      for (const item of files) {
        const id = item.relPath;
        const cur = new Set(getTagsForId(id));
        cur.add(tag);
        setTagsForId(id, [...cur].join(", "));
        n += 1;
      }
      buildGraph();
      renderWorkspaceDeck();
      appendSelectHistory(`reader tag add "${tag}" · ${n} files`);
      logLine(`tag "${tag}" on ${n} reader file(s) (save tags to persist)`);
      return;
    }
    if (rlow === "paths" || rlow.startsWith("paths ")) {
      const lim =
        rlow === "paths" ? 50 : Math.min(200, parseInt(rest.slice(6).trim(), 10) || 50);
      const files = getWorkspaceRowsForDisplay().filter((i) => i.type === "file");
      const slice = files.slice(0, Math.max(1, lim));
      slice.forEach((f) => logLine(normRel(f.relPath)));
      logLine(`reader paths: showing ${slice.length} of ${files.length} (reader save list <file> for all)`);
      return;
    }
    const m = rlow.match(/^(?:show\s+)?(matched|empty|all)$/);
    if (!m) {
      logLine(
        "usage: reader matched|empty|all · filter|sort · save copy|list · tag add · paths [n]",
      );
      return;
    }
    pushCliUndo();
    if (m[1] === "all") {
      state.workspace.pipelineResultFilter = null;
    } else {
      state.workspace.pipelineResultFilter = m[1];
    }
    renderWorkspaceDeck();
    appendSelectHistory(`Pipeline result filter: ${state.workspace.pipelineResultFilter || "off"}`);
    logLine(`reader pipeline filter: ${state.workspace.pipelineResultFilter || "off"}`);
    return;
  }

  if (lower.startsWith("cd ")) {
    const target = input.slice(3).trim();
    if (!target) {
      logLine("usage: cd <path>");
      return;
    }
    const base = state.rootDir || "";
    const resolved = await window.explorerApi.resolveDir(target, base);
    if (!resolved) {
      logLine(`no such directory: ${target}`);
      return;
    }
    await loadRoot(resolved);
    return;
  }

  if (lower === "ls") {
    const rows = getFilteredSortedItems().slice(0, 30);
    rows.forEach((item) => logLine(`${item.type.padEnd(6)} ${item.relPath}`));
    logLine(`showing ${rows.length} items`);
    return;
  }

  if (lower === "reset") {
    pushCliUndo();
    state.view.searchText = "";
    state.view.tagFilter = "";
    state.view.mode = "folders";
    state.wsExpansion = null;
    state.extSelection = null;
    state.workspace.filterText = "";
    state.workspace.pipelineResultFilter = null;
    state.workspace.selectedCardRelPath = null;
    state.cardRender = { pipeline: [] };
    state.readerPipelineMatchByRel.clear();
    state.view.selectedId = ROOT_ID;
    state.selection.relPath = null;
    buildGraph();
    renderWorkspaceDeck();
    appendSelectHistory("Reset: all filters cleared");
    logLine("reset: mode=folders, all filters/expansion/pipeline cleared");
    return;
  }

  if (lower === "refresh") {
    await refreshFromDisk();
    logLine("refreshed");
    return;
  }

  if (lower === "save tags") {
    if (!state.rootDir) {
      logLine("no root selected");
      return;
    }
    await window.explorerApi.saveTags(state.rootDir, state.overlay.tagsByPath);
    logLine("tags saved");
    return;
  }

  if (lower.startsWith("expand ")) {
    const sub = input.slice(7).trim().toLowerCase();
    let next = state.wsExpansion;
    if (sub === "clear") {
      next = null;
    } else if (sub === "children") {
      next = "children";
    } else if (sub === "parents") {
      next = "parents";
    } else if (sub === "siblings") {
      next = "siblings";
    } else if (sub === "+1" || sub === "hop1") {
      next = "hop1";
    } else {
      logLine("usage: expand children|parents|siblings|+1|clear");
      return;
    }
    const expandChanged = next !== state.wsExpansion;
    if (expandChanged) {
      pushCliUndo();
      state.wsExpansion = next;
    }
    renderWorkspaceDeck();
    if (expandChanged) {
      appendSelectHistory(`Expand: ${state.wsExpansion || "none"}`);
    }
    logLine(`expand: ${state.wsExpansion || "none"}`);
    return;
  }

  if (lower === "history" || lower.startsWith("history ")) {
    const sub = input.slice(7).trim().toLowerCase();
    const lim = sub.startsWith("last ") ? Math.min(200, parseInt(sub.slice(5), 10) || 20) : 50;
    const hist = state.cliHistory.slice(-lim);
    if (!hist.length) {
      logLine("(no history)");
      return;
    }
    hist.forEach((l, i) => logLine(`${String(i + 1).padStart(3)}  ${l}`));
    // Copy to clipboard
    const text = hist.join("\n");
    try {
      await navigator.clipboard.writeText(text);
      logLine(`— ${hist.length} command(s) copied to clipboard`);
    } catch {
      logLine(`— ${hist.length} command(s) shown (clipboard unavailable)`);
    }
    return;
  }

  if (lower === "explain") {
    // Emit a deterministic recipe: the minimal command set that reproduces current state
    const recipe = [];
    const ws = getWorkingSetItems();
    const readerRows = getWorkspaceRowsForDisplay();

    recipe.push(`# OpenGraphXplorer state recipe — ${new Date().toLocaleString()}`);
    recipe.push(`cd ${state.rootDir || "(no root)"}`);
    if (state.view.mode !== "folders") recipe.push(`mode ${state.view.mode}`);
    if (state.view.searchText) recipe.push(`filter ${state.view.searchText}`);
    if (state.view.tagFilter) recipe.push(`tagfilter ${state.view.tagFilter}`);
    if (state.view.sortMode && state.view.sortMode !== "name-asc") recipe.push(`sort ${state.view.sortMode}`);
    if (state.extSelection) recipe.push(`select ext ${state.extSelection.ext}`);
    if (state.view.selectedId && state.view.selectedId !== ROOT_ID) recipe.push(`select ${state.view.selectedId}`);
    if (state.wsExpansion) recipe.push(`expand ${state.wsExpansion}`);
    if (state.workspace.filterText.trim()) recipe.push(`reader filter ${state.workspace.filterText.trim()}`);
    if (state.workspace.sortMode && state.workspace.sortMode !== "manual") recipe.push(`reader sort ${state.workspace.sortMode}`);
    const cr = state.cardRender;
    if (cr && cr.pipeline && cr.pipeline.length) {
      const pipeStr = cr.pipeline.map((s) => {
        if (s.op === "head") return `head ${s.n}`;
        if (s.op === "grep" || s.op === "regex") return `${s.op} ${s.pattern != null ? s.pattern : ""}`;
        if (s.op === "col") return `col ${(s.cols || []).map((c) => c + 1).join(",")}`;
        return s.op;
      }).join(" | ");
      const pfSuffix = state.workspace.pipelineResultFilter ? ` | ${state.workspace.pipelineResultFilter}` : "";
      recipe.push(`render ${pipeStr}${pfSuffix}`);
    } else if (state.workspace.pipelineResultFilter) {
      recipe.push(`reader ${state.workspace.pipelineResultFilter}`);
    }
    if (state.extraLinks.length) {
      const kinds = {};
      for (const l of state.extraLinks) kinds[l.kind] = (kinds[l.kind] || 0) + 1;
      recipe.push(`# extra links: ${Object.entries(kinds).map(([k,n]) => `${k}(${n})`).join(" ")}`);
      recipe.push("# re-run graph link commands to rebuild — or: graph save <name>");
    }

    // Print recipe to log
    recipe.forEach((l) => logLine(l));

    // Also print a summary line
    const files = ws.filter((i) => i.type === "file");
    logLine(`# working set: ${files.length} files · reader: ${readerRows.length} visible`);
    return;
  }

  if (lower === "summary") {
    const count = state.fsSnapshot.items.filter((i) => i.type === "file").length;
    logLine(`summary: ${count} files under root`);
    return;
  }

  if (lower.startsWith("card render")) {
    if (!EP) {
      logLine("card render unavailable");
      return;
    }
    const rest = input.replace(/^card\s+render\s*/i, "").trim();
    const rlow = rest.toLowerCase();
    if (!rest || rlow === "reset") {
      pushCliUndo();
      state.cardRender = { pipeline: [] };
      state.readerPipelineMatchByRel.clear();
      state.workspace.pipelineResultFilter = null;
      appendSelectHistory("Card render: reset");
      logLine("card render reset");
      renderWorkspaceDeck();
      return;
    }
    if (rlow.startsWith("save ")) {
      const name = rest.slice(5).trim();
      if (!name) {
        logLine("usage: card render save <name>");
        return;
      }
      const map = loadCardRenderSavedMap();
      map[name] = { pipeline: [...(state.cardRender.pipeline || [])] };
      saveCardRenderSavedMap(map);
      logLine(`saved pipeline "${name}" (${state.cardRender.pipeline.length} steps)`);
      return;
    }
    if (rlow.startsWith("load ")) {
      const name = rest.slice(5).trim();
      if (!name) {
        logLine("usage: card render load <name>");
        return;
      }
      const map = loadCardRenderSavedMap();
      const saved = map[name];
      if (!saved || !Array.isArray(saved.pipeline)) {
        logLine(`no saved pipeline: ${name}`);
        return;
      }
      state.cardRender = { pipeline: [...saved.pipeline] };
      logLine(`loaded pipeline "${name}" (${state.cardRender.pipeline.length} steps)`);
      renderWorkspaceDeck();
      return;
    }
    if (rlow === "list") {
      const map = loadCardRenderSavedMap();
      const names = Object.keys(map).sort();
      if (!names.length) {
        logLine("(no saved pipelines)");
      } else {
        names.forEach((n) => logLine(n));
      }
      return;
    }
    if (rlow.startsWith("delete ")) {
      const name = rest.slice(7).trim();
      if (!name) {
        logLine("usage: card render delete <name>");
        return;
      }
      const map = loadCardRenderSavedMap();
      if (!map[name]) {
        logLine(`not found: ${name}`);
        return;
      }
      delete map[name];
      saveCardRenderSavedMap(map);
      logLine(`deleted saved pipeline: ${name}`);
      return;
    }
    // Strip trailing "| matched/empty/all" suffix before parsing pipeline
    let renderInput = input;
    let readerFilterSuffix;
    {
      const pipeSegments = input.replace(/^card\s+render\s*/i, "").split("|").map((s) => s.trim());
      const last = pipeSegments[pipeSegments.length - 1].toLowerCase();
      if (last === "matched" || last === "empty" || last === "all") {
        readerFilterSuffix = last === "all" ? null : last;
        renderInput = `card render ${pipeSegments.slice(0, -1).join(" | ")}`.trimEnd();
      }
    }
    const parsed = EP.parseCardRenderCommand(renderInput);
    if (parsed.reset && !readerFilterSuffix) {
      pushCliUndo();
      state.cardRender = { pipeline: [] };
      state.readerPipelineMatchByRel.clear();
      state.workspace.pipelineResultFilter = null;
      appendSelectHistory("Card render: reset");
      logLine("card render reset");
    } else {
      pushCliUndo();
      if (!parsed.reset) {
        state.cardRender = { pipeline: parsed.pipeline || [] };
        state.readerPipelineMatchByRel.clear();
      }
      if (readerFilterSuffix !== undefined) {
        state.workspace.pipelineResultFilter = readerFilterSuffix;
        logLine(`reader filter: ${readerFilterSuffix || "all"}`);
      }
      appendSelectHistory(`Card render: ${state.cardRender.pipeline.length} step(s)`);
      logLine(
        `card render: ${state.cardRender.pipeline.length} step(s) — ${state.selection.relPath || state.workspace.selectedCardRelPath ? "scoped to selection" : "all reader cards"}`,
      );
    }
    renderWorkspaceDeck();
    return;
  }

  if (lower.startsWith("preset ")) {
    const rest = input.slice(7).trim();
    const parts = rest.split(/\s+/);
    const sub = (parts[0] || "").toLowerCase();
    const map = loadPresetsMap();
    if (sub === "list") {
      const names = Object.keys(map).sort();
      if (!names.length) {
        logLine("(no presets)");
      } else {
        names.forEach((n) => logLine(n));
      }
      return;
    }
    if (sub === "save" && parts.length > 1) {
      const name = parts.slice(1).join(" ").trim();
      if (!name) {
        logLine("usage: preset save <name>");
        return;
      }
      map[name] = snapshotPreset();
      savePresetsMap(map);
      logLine(`preset saved: ${name}`);
      return;
    }
    if (sub === "load" && parts.length > 1) {
      const name = parts.slice(1).join(" ").trim();
      const snap = map[name];
      if (!snap) {
        logLine(`preset not found: ${name}`);
        return;
      }
      await applyPresetAsync(snap);
      logLine(`preset loaded: ${name}`);
      return;
    }
    if (sub === "delete" && parts.length > 1) {
      const name = parts.slice(1).join(" ").trim();
      if (!map[name]) {
        logLine(`preset not found: ${name}`);
        return;
      }
      delete map[name];
      savePresetsMap(map);
      logLine(`preset deleted: ${name}`);
      return;
    }
    logLine("usage: preset save|load|list|delete <name>");
    return;
  }

  if (lower === "ws") {
    const items = getWorkingSetItems();
    items.slice(0, 80).forEach((i) => logLine(`${i.type.padEnd(7)} ${i.relPath}`));
    logLine(`working set: ${items.length} items (showing up to 80)`);
    return;
  }

  if (lower.startsWith("ws ")) {
    const rest = input.slice(3).trim();
    const parts = rest.split(/\s+/);
    const sub = (parts[0] || "").toLowerCase();
    const bm = loadWsBookmarksMap();
    if (sub === "clear") {
      state.wsExpansion = null;
      syncWorkspaceFromGraphSelection();
      renderWorkspaceDeck();
      logLine("ws clear: expansion reset");
      return;
    }
    if (sub === "list") {
      const names = Object.keys(bm).sort();
      if (!names.length) {
        logLine("(no ws bookmarks)");
      } else {
        names.forEach((n) => logLine(n));
      }
      return;
    }
    if (sub === "save" && parts.length > 1) {
      const name = parts.slice(1).join(" ").trim();
      if (!name) {
        logLine("usage: ws save <name>");
        return;
      }
      bm[name] = snapshotWsBookmark();
      saveWsBookmarksMap(bm);
      logLine(`ws bookmark saved: ${name}`);
      return;
    }
    if (sub === "load" && parts.length > 1) {
      const name = parts.slice(1).join(" ").trim();
      const snap = bm[name];
      if (!snap) {
        logLine(`ws bookmark not found: ${name}`);
        return;
      }
      await applyWsBookmarkAsync(snap);
      logLine(`ws bookmark loaded: ${name}`);
      return;
    }
    if (sub === "delete" && parts.length > 1) {
      const name = parts.slice(1).join(" ").trim();
      if (!bm[name]) {
        logLine(`ws bookmark not found: ${name}`);
        return;
      }
      delete bm[name];
      saveWsBookmarksMap(bm);
      logLine(`ws bookmark deleted: ${name}`);
      return;
    }
    logLine("usage: ws | ws save|load|list|delete <name> | ws clear");
    return;
  }

  if (lower === "filter" || lower.startsWith("filter ")) {
    state.view.searchText = lower === "filter" ? "" : input.slice(7).trim().toLowerCase();
    buildGraph();
    renderWorkspaceDeck();
    logLine(state.view.searchText ? `filter: "${state.view.searchText}"` : "filter cleared");
    return;
  }

  if (lower.startsWith("tagfilter ")) {
    state.view.tagFilter = input.slice(10).trim().toLowerCase();
    buildGraph();
    renderWorkspaceDeck();
    return;
  }

  if (lower.startsWith("sort ")) {
    const mode = input.slice(5).trim();
    const valid = new Set(["name-asc", "name-desc", "type-asc", "type-desc"]);
    if (!valid.has(mode)) {
      logLine("invalid sort mode");
      return;
    }
    state.view.sortMode = mode;
    buildGraph();
    renderWorkspaceDeck();
    return;
  }

  if (lower.startsWith("select ")) {
    const arg = input.slice(7).trim();
    const argLower = arg.toLowerCase();
    if (argLower === "clear") {
      pushCliUndo();
      clearExtSelection();
      syncWorkspaceFromGraphSelection();
      renderWorkspaceDeck();
      appendSelectHistory("Select clear (ext / reader follows graph)");
      logLine("ext selection cleared; deck follows graph");
      return;
    }
    if (argLower === "siblings") {
      selectGraphSiblings();
      return;
    }
    if (argLower === "children") {
      selectGraphChildren();
      return;
    }
    if (argLower === "visible") {
      selectVisibleFiles();
      return;
    }
    if (argLower.startsWith("ext ")) {
      const ext = arg.slice(4).trim();
      if (!ext) {
        logLine("usage: select ext <ext>  (e.g. select ext csv)");
        return;
      }
      applyExtSelection(ext);
      renderWorkspaceDeck();
      return;
    }
    if (argLower.startsWith("tag ")) {
      const tagName = arg.slice(4).trim().toLowerCase();
      if (!tagName) {
        logLine("usage: select tag <tagname>");
        return;
      }
      pushCliUndo();
      state.view.tagFilter = tagName;
      buildGraph();
      renderWorkspaceDeck();
      appendSelectHistory(`Select tag: "${tagName}"`);
      logLine(`select tag: showing files tagged "${tagName}"`);
      return;
    }
    await selectNodeById(arg);
    return;
  }

  if (lower.startsWith("tag ") || lower === "tag") {
    const tagArg = input.slice(4).trim();
    const tagArgLow = tagArg.toLowerCase();

    // 'tag' or 'tag list' → show current tags on selected node
    if (!tagArg || tagArgLow === "list") {
      if (state.view.selectedId === ROOT_ID) {
        logLine("select a node first");
        return;
      }
      const cur = getTagsForId(state.view.selectedId);
      logLine(cur.length ? `tags: ${cur.join(", ")}` : "(no tags)");
      return;
    }

    // 'tag clear' → remove all tags on selected node
    if (tagArgLow === "clear") {
      if (state.view.selectedId === ROOT_ID) {
        logLine("select a node first");
        return;
      }
      setTagsForId(state.view.selectedId, "");
      buildGraph();
      renderWorkspaceDeck();
      renderTagBar();
      logLine(`tags cleared on ${state.view.selectedId}`);
      return;
    }

    // 'tag set <csv>' → replace all tags (kept for compat)
    if (tagArgLow.startsWith("set ")) {
      if (state.view.selectedId === ROOT_ID) { logLine("select a node first"); return; }
      setTagsForId(state.view.selectedId, tagArg.slice(4).trim());
      buildGraph(); renderWorkspaceDeck(); renderTagBar();
      logLine(`tags set: ${getTagsForId(state.view.selectedId).join(", ") || "(none)"}`);
      return;
    }

    // 'tag add <tag>' → kept for compat
    if (tagArgLow.startsWith("add ")) {
      if (state.view.selectedId === ROOT_ID) { logLine("select a node first"); return; }
      const t = tagArg.slice(4).trim();
      if (!t) return;
      const ex = new Set(getTagsForId(state.view.selectedId));
      ex.add(t);
      setTagsForId(state.view.selectedId, [...ex].join(", "));
      buildGraph(); renderWorkspaceDeck(); renderTagBar();
      logLine(`tagged: ${[...ex].join(", ")}`);
      return;
    }

    // 'tag <name> where grep <pattern>' → bulk-tag reader files matching grep
    const whereGrepM = tagArg.match(/^(.+?)\s+where\s+grep\s+(.+)$/i);
    if (whereGrepM) {
      const tagName = whereGrepM[1].trim();
      const grepPat = whereGrepM[2].trim();
      if (!state.rootDir) { logLine("no root loaded"); return; }
      const scopeFiles = getWorkspaceRowsForDisplay().filter((i) => i.type === "file");
      if (!scopeFiles.length) { logLine("reader deck is empty"); return; }
      logLine(`tag "${tagName}" where grep "${grepPat}": scanning ${scopeFiles.length} file(s)…`);
      const files = scopeFiles.map((i) => ({ relPath: i.relPath, fullPath: i.fullPath }));
      const res = await window.explorerApi.buildContentLinks({
        rootDir: state.rootDir, files, strategy: "grep", pattern: grepPat,
      });
      if (!res || !res.ok) { logLine(`tag where grep: ${(res && res.error) || "failed"}`); return; }
      let n = 0;
      for (const rp of (res.matched || [])) {
        const ex = new Set(getTagsForId(rp));
        ex.add(tagName);
        setTagsForId(rp, [...ex].join(", "));
        n++;
      }
      buildGraph(); renderWorkspaceDeck(); renderTagBar();
      (res.matched || []).slice(0, 6).forEach((rp) => logLine(`  ✓ ${rp.split("/").pop()}`));
      logLine(`tagged ${n} file(s) with "${tagName}" (save tags to persist)`);
      appendSelectHistory(`Tag "${tagName}" where grep "${grepPat}": ${n} files`);
      return;
    }

    // 'tag <text>' — two modes:
    //   A) graph node selected → tag that node
    //   B) no graph node (root) → bulk-tag all currently visible reader files
    if (state.view.selectedId !== ROOT_ID) {
      const existing = new Set(getTagsForId(state.view.selectedId));
      existing.add(tagArg);
      setTagsForId(state.view.selectedId, [...existing].join(", "));
      buildGraph(); renderWorkspaceDeck(); renderTagBar();
      logLine(`tagged "${state.view.selectedId.split("/").pop()}": ${[...existing].join(", ")}`);
      return;
    }
    // No graph node — tag the reader's current visible rows (respects matched/empty filter)
    const visibleRows = getWorkspaceRowsForDisplay().filter((i) => i.type === "file");
    if (!visibleRows.length) {
      logLine("reader is empty — select a graph node or populate the reader first");
      return;
    }
    let n = 0;
    for (const item of visibleRows) {
      const ex = new Set(getTagsForId(item.relPath));
      ex.add(tagArg);
      setTagsForId(item.relPath, [...ex].join(", "));
      n++;
    }
    buildGraph(); renderWorkspaceDeck(); renderTagBar();
    visibleRows.slice(0, 5).forEach((i) => logLine(`  ✓ ${i.name}`));
    if (visibleRows.length > 5) logLine(`  … and ${visibleRows.length - 5} more`);
    logLine(`tagged ${n} reader file(s) with "${tagArg}" (save tags to persist)`);
    appendSelectHistory(`Tag "${tagArg}" → ${n} reader files`);
    return;
  }

  if (lower.startsWith("card save ")) {
    const sel = getSelectedItem();
    if (!sel || sel.type !== "folder") {
      logLine("select a folder node first");
      return;
    }
    const name = input.slice(10).trim();
    if (!name) {
      return;
    }
    const card = {
      name,
      searchText: state.view.searchText,
      tagFilter: state.view.tagFilter,
      sortMode: state.view.sortMode,
      savedAt: new Date().toISOString(),
    };
    state.overlay.cards.push(card);
    await window.explorerApi.saveCards(sel.fullPath, state.overlay.cards);
    logLine("card saved");
    return;
  }

  if (lower.startsWith("card apply ")) {
    const index = Number(input.slice(11).trim()) - 1;
    if (!Number.isInteger(index) || index < 0 || index >= state.overlay.cards.length) {
      logLine("invalid card index");
      return;
    }
    applyCard(state.overlay.cards[index]);
    logLine(`applied card ${index + 1}`);
    return;
  }

  if (lower.startsWith("cards add ")) {
    cardsAddFromWorkingSet();
    return;
  }

  if (lower === "cards clear") {
    pushCliUndo();
    clearExtSelection();
    state.workspace.filterText = "";
    state.wsExpansion = null;
    syncWorkspaceFromGraphSelection();
    renderWorkspaceDeck();
    appendSelectHistory("cards clear: reader filters + expansion reset");
    logLine("reader reset: ext, reader filter, expansion cleared");
    return;
  }

  if (lower.startsWith("cards rm ")) {
    logLine("reader is driven by the working set; narrow with filter, select ext, or expansion instead");
    return;
  }

  if (lower.startsWith("label ")) {
    const spec = input.slice(6).trim().toLowerCase();
    if (spec === "off") {
      state.view.labelFields = new Set();
      logLine("labels disabled");
      return;
    }
    const parts = spec
      .split(",")
      .map((s) => s.trim())
      .filter(Boolean);
    const valid = new Set(["count", "type"]);
    const next = new Set();
    for (const p of parts) {
      if (!valid.has(p)) {
        logLine(`invalid label field: ${p}`);
        return;
      }
      next.add(p);
    }
    state.view.labelFields = next;
    logLine(`labels: ${[...next].join(",") || "off"}`);
    return;
  }

  if (lower === "summary count") {
    const count = state.fsSnapshot.items.filter((i) => i.type === "file").length;
    logLine(`count: ${count} files`);
    return;
  }

  if (lower === "summary count --by type") {
    const lines = summaryCountByTypeLines();
    lines.forEach((line) => logLine(line));
    return;
  }

  if (lower === "summary types" || lower === "summary by type") {
    logLine("extensions (file count per type):");
    summaryCountByTypeLines().forEach((line) => logLine(line));
    return;
  }

  if (lower.startsWith("mode ")) {
    const nextMode = input.slice(5).trim().toLowerCase();
    const valid = new Set(["folders", "files", "hybrid"]);
    if (!valid.has(nextMode)) {
      logLine("usage: mode <folders|files|hybrid>");
      return;
    }
    state.view.mode = nextMode;
    logLine(`mode: ${nextMode}`);
    renderWorkspaceDeck();
    return;
  }

  if (lower === "settings" || lower.startsWith("settings ")) {
    const rest = input.replace(/^settings\s*/i, "").trim();
    if (!rest) {
      logLine(
        `logFadeMs=${state.settings.logFadeMs} head=${state.settings.cardHeadLines} tail=${state.settings.cardTailLines}`,
      );
      logLine(
        `gravity=${state.settings.graphGravity} repulsion=${state.settings.graphRepulsion} link=${state.settings.graphLinkStrength} damping=${state.settings.graphDamping}`,
      );
      logLine(`mdsections=${(state.settings.mdSectionTitles || []).join(",") || "(none)"}`);
      logLine(
        `selectionhud=${state.settings.selectionHudPosition || "bottom"} cliinput=${state.settings.cliInputAnchor || "bottom"}`,
      );
      return;
    }
    const parts = rest.split(/\s+/);
    const key = parts[0].toLowerCase();
    const val = parts[1];
    if (key === "logfade" && val !== undefined) {
      const n = Number(val);
      if (!Number.isFinite(n) || n < 500) {
        logLine("logfade: need ms >= 500");
        return;
      }
      state.settings.logFadeMs = n;
      saveSettings();
      logLine(`logFadeMs=${n}`);
      return;
    }
    if (key === "head" && val !== undefined) {
      const n = Math.floor(Number(val));
      if (!Number.isFinite(n) || n < 0 || n > 200) {
        logLine("head: need 0..200");
        return;
      }
      state.settings.cardHeadLines = n;
      saveSettings();
      logLine(`cardHeadLines=${n}`);
      renderWorkspaceDeck();
      return;
    }
    if (key === "tail" && val !== undefined) {
      const n = Math.floor(Number(val));
      if (!Number.isFinite(n) || n < 0 || n > 200) {
        logLine("tail: need 0..200");
        return;
      }
      state.settings.cardTailLines = n;
      saveSettings();
      logLine(`cardTailLines=${n}`);
      renderWorkspaceDeck();
      return;
    }
    if (key === "gravity" && val !== undefined) {
      const n = Number(val);
      if (!Number.isFinite(n) || n < 0 || n > 0.01) {
        logLine("gravity: 0 .. 0.01");
        return;
      }
      state.settings.graphGravity = n;
      saveSettings();
      logLine(`graphGravity=${n}`);
      return;
    }
    if (key === "repulsion" && val !== undefined) {
      const n = Number(val);
      if (!Number.isFinite(n) || n < 0 || n > 0.5) {
        logLine("repulsion: 0 .. 0.5");
        return;
      }
      state.settings.graphRepulsion = n;
      saveSettings();
      logLine(`graphRepulsion=${n}`);
      return;
    }
    if (key === "link" && val !== undefined) {
      const n = Number(val);
      if (!Number.isFinite(n) || n < 0 || n > 0.01) {
        logLine("link: 0 .. 0.01");
        return;
      }
      state.settings.graphLinkStrength = n;
      saveSettings();
      logLine(`graphLinkStrength=${n}`);
      return;
    }
    if (key === "damping" && val !== undefined) {
      const n = Number(val);
      if (!Number.isFinite(n) || n < 0.5 || n > 0.999) {
        logLine("damping: 0.5 .. 0.999");
        return;
      }
      state.settings.graphDamping = n;
      saveSettings();
      logLine(`graphDamping=${n}`);
      return;
    }
    if (key === "mdsections") {
      const csv = parts.slice(1).join(" ").trim();
      if (!csv || csv.toLowerCase() === "clear") {
        state.settings.mdSectionTitles = [];
      } else {
        state.settings.mdSectionTitles = csv
          .split(",")
          .map((s) => s.trim())
          .filter(Boolean);
      }
      saveSettings();
      logLine(`mdsections=${state.settings.mdSectionTitles.join(",") || "(none)"}`);
      renderWorkspaceDeck();
      return;
    }
    if (key === "selectionhud" && val !== undefined) {
      const v = String(val).toLowerCase();
      if (v !== "top" && v !== "bottom") {
        logLine("selectionhud: top | bottom");
        return;
      }
      state.settings.selectionHudPosition = v;
      saveSettings();
      applyChromeLayout();
      logLine(`selectionHudPosition=${v}`);
      return;
    }
    if (key === "cliinput" && val !== undefined) {
      const v = String(val).toLowerCase();
      if (v !== "top" && v !== "bottom") {
        logLine("cliinput: top | bottom");
        return;
      }
      state.settings.cliInputAnchor = v;
      saveSettings();
      applyChromeLayout();
      logLine(`cliInputAnchor=${v}`);
      return;
    }
    logLine(
      "usage: settings logfade|head|tail|gravity|repulsion|link|damping|mdsections|selectionhud|cliinput …",
    );
    return;
  }

  if (lower === "graph" || lower.startsWith("graph ")) {
    const graphSub = input.slice(5).trim();
    const graphSubLow = graphSub.toLowerCase();
    const STORAGE_GRAPHS = "ogx-graphs-v1";

    const loadGraphsMap = () => {
      try { return JSON.parse(localStorage.getItem(STORAGE_GRAPHS) || "{}"); } catch { return {}; }
    };
    const saveGraphsMap = (m) => localStorage.setItem(STORAGE_GRAPHS, JSON.stringify(m));

    // graph link … — handled below
    if (graphSubLow === "link" || graphSubLow.startsWith("link ")) {
      // fall through to graph link handler
    } else if (!graphSub || graphSubLow === "list") {
      const m = loadGraphsMap();
      const names = Object.keys(m).sort();
      if (!names.length) {
        logLine("(no saved graphs)");
      } else {
        names.forEach((n) => logLine(`  ${n} — ${(m[n].extraLinks || []).length} extra link(s)`));
      }
      return;

    } else if (graphSubLow.startsWith("save ")) {
      const name = graphSub.slice(5).trim();
      if (!name) { logLine("usage: graph save <name>"); return; }
      const m = loadGraphsMap();
      m[name] = {
        extraLinks: [...state.extraLinks],
        mode: state.view.mode,
        searchText: state.view.searchText,
        tagFilter: state.view.tagFilter,
        savedAt: new Date().toISOString(),
      };
      saveGraphsMap(m);
      logLine(`graph saved: "${name}" (${state.extraLinks.length} extra links, mode=${state.view.mode})`);
      return;

    } else if (graphSubLow.startsWith("load ")) {
      const name = graphSub.slice(5).trim();
      if (!name) { logLine("usage: graph load <name>"); return; }
      const m = loadGraphsMap();
      const snap = m[name];
      if (!snap) { logLine(`graph not found: "${name}"`); return; }
      pushCliUndo();
      state.extraLinks = Array.isArray(snap.extraLinks) ? snap.extraLinks : [];
      rebuildExtraLinkEndpoints();
      if (snap.mode) state.view.mode = snap.mode;
      if (snap.searchText != null) state.view.searchText = snap.searchText;
      if (snap.tagFilter != null) state.view.tagFilter = snap.tagFilter;
      buildGraph();
      renderWorkspaceDeck();
      logLine(`graph loaded: "${name}" (${state.extraLinks.length} extra links)`);
      appendSelectHistory(`Graph load: "${name}"`);
      return;

    } else if (graphSubLow.startsWith("delete ")) {
      const name = graphSub.slice(7).trim();
      if (!name) { logLine("usage: graph delete <name>"); return; }
      const m = loadGraphsMap();
      if (!m[name]) { logLine(`graph not found: "${name}"`); return; }
      delete m[name];
      saveGraphsMap(m);
      logLine(`graph deleted: "${name}"`);
      return;

    } else if (graphSubLow.startsWith("new ")) {
      // 'graph new <name>' — clear extra links and save a blank named graph
      const name = graphSub.slice(4).trim();
      if (!name) { logLine("usage: graph new <name>"); return; }
      pushCliUndo();
      state.extraLinks = [];
      state.extraLinkEndpoints = new Set();
      const m = loadGraphsMap();
      m[name] = { extraLinks: [], mode: state.view.mode, searchText: state.view.searchText, tagFilter: state.view.tagFilter, savedAt: new Date().toISOString() };
      saveGraphsMap(m);
      logLine(`graph new: "${name}" — extra links cleared, blank graph saved`);
      logLine(`  use graph link commands to build edges, then: graph save "${name}"`);
      return;

    } else {
      logLine("usage: graph list | graph save <name> | graph load <name> | graph delete <name> | graph new <name>");
      logLine("       graph link ext|tags|name <pat>|grep <pat>|imports|refs|clear|list");
      return;
    }
  }

  if (lower === "graph link" || lower.startsWith("graph link ")) {
    const sub = input.slice(10).trim();
    const subLow = sub.toLowerCase();

    if (!sub || subLow === "list") {
      if (state.extraLinks.length === 0) {
        logLine("no extra links active");
      } else {
        const counts = {};
        for (const l of state.extraLinks) counts[l.kind] = (counts[l.kind] || 0) + 1;
        Object.entries(counts).forEach(([k, n]) => logLine(`  ${k}: ${n} link(s)`));
        logLine(`total: ${state.extraLinks.length} extra link(s)`);
      }
      return;
    }

    if (subLow === "clear") {
      state.extraLinks = [];
      state.extraLinkEndpoints = new Set();
      logLine("extra links cleared");
      return;
    }

    if (!state.rootDir) {
      logLine("no root loaded");
      return;
    }

    const scopeItems = getWorkspaceRowsForDisplay().filter((i) => i.type === "file");
    if (!scopeItems.length) {
      logLine("graph link: reader deck is empty — use filter/select to populate it first");
      return;
    }
    logLine(`graph link: scope = ${scopeItems.length} file(s) from reader deck`);

    if (subLow === "ext") {
      const newLinks = computeStructuralLinks("ext", scopeItems, state.overlay.tagsByPath);
      addExtraLinks(newLinks);
      // Group summary
      const byKind = {};
      for (const item of scopeItems) {
        if (item.type !== "file") continue;
        const idx = item.name.lastIndexOf(".");
        const ext = idx > 0 ? item.name.slice(idx + 1).toLowerCase() : "(none)";
        byKind[ext] = (byKind[ext] || 0) + 1;
      }
      Object.entries(byKind).sort((a,b) => b[1]-a[1]).slice(0, 6).forEach(([e, n]) => logLine(`  .${e}: ${n} file(s)`));
      logLine(`graph link ext: ${newLinks.length} link(s) added`);
      appendSelectHistory(`Graph link: ext (${newLinks.length})`);
      return;
    }

    if (subLow === "tags") {
      const newLinks = computeStructuralLinks("tags", scopeItems, state.overlay.tagsByPath);
      if (!newLinks.length) {
        logLine("graph link tags: no tagged files found in reader deck (save tags first?)");
        return;
      }
      addExtraLinks(newLinks);
      // Show which tags connected things
      const tagGroups = new Map();
      for (const item of scopeItems) {
        const tags = state.overlay.tagsByPath[item.relPath];
        if (!tags) continue;
        for (const t of tags) {
          if (!tagGroups.has(t)) tagGroups.set(t, 0);
          tagGroups.set(t, tagGroups.get(t) + 1);
        }
      }
      [...tagGroups.entries()].filter(([,n]) => n > 1).sort((a,b) => b[1]-a[1]).slice(0, 6).forEach(([t, n]) => logLine(`  "${t}": ${n} file(s)`));
      logLine(`graph link tags: ${newLinks.length} link(s) added`);
      appendSelectHistory(`Graph link: tags (${newLinks.length})`);
      return;
    }

    if (subLow.startsWith("name ")) {
      const pat = sub.slice(5).trim();
      if (!pat) {
        logLine("usage: graph link name <pattern>");
        return;
      }
      const patLow = pat.toLowerCase();
      const matched = scopeItems.filter((i) => i.name.toLowerCase().includes(patLow));
      if (matched.length < 2) {
        logLine(`graph link name: fewer than 2 files match "${pat}" (found ${matched.length})`);
        return;
      }
      const newLinks = computeStructuralLinks("name", matched, {});
      addExtraLinks(newLinks);
      matched.slice(0, 8).forEach((i) => logLine(`  ${i.name}`));
      if (matched.length > 8) logLine(`  … and ${matched.length - 8} more`);
      logLine(`graph link name "${pat}": ${matched.length} files → ${newLinks.length} link(s)`);
      appendSelectHistory(`Graph link: name "${pat}" (${newLinks.length})`);
      return;
    }

    if (subLow.startsWith("grep ")) {
      const pat = sub.slice(5).trim();
      if (!pat) {
        logLine("usage: graph link grep <pattern>");
        return;
      }
      logLine(`graph link grep "${pat}": scanning ${scopeItems.length} file(s)…`);
      const files = scopeItems.map((i) => ({ relPath: i.relPath, fullPath: i.fullPath }));
      const res = await window.explorerApi.buildContentLinks({
        rootDir: state.rootDir, files, strategy: "grep", pattern: pat,
      });
      if (!res || !res.ok) {
        logLine(`graph link grep: ${(res && res.error) || "failed"}`);
        return;
      }
      addExtraLinks(res.links);
      const matched = res.matched || [];
      matched.slice(0, 8).forEach((rp) => logLine(`  ✓ ${rp.split("/").pop()}`));
      if (matched.length > 8) logLine(`  … and ${matched.length - 8} more`);
      logLine(`graph link grep: ${matched.length} file(s) matched → ${res.links.length} link(s) added`);
      appendSelectHistory(`Graph link: grep "${pat}" (${res.links.length})`);
      return;
    }

    if (subLow === "imports") {
      logLine(`graph link imports: scanning ${scopeItems.length} file(s) for import/require…`);
      const files = scopeItems.map((i) => ({ relPath: i.relPath, fullPath: i.fullPath }));
      const res = await window.explorerApi.buildContentLinks({
        rootDir: state.rootDir, files, strategy: "imports",
      });
      if (!res || !res.ok) {
        logLine(`graph link imports: ${(res && res.error) || "failed"}`);
        return;
      }
      addExtraLinks(res.links);
      logLine(`graph link imports: ${res.links.length} link(s) added (files sharing same import path)`);
      appendSelectHistory(`Graph link: imports (${res.links.length})`);
      return;
    }

    if (subLow === "refs") {
      logLine(`graph link refs: scanning ${scopeItems.length} file(s) for [[wikilinks]] and [md](links)…`);
      const files = scopeItems.map((i) => ({ relPath: i.relPath, fullPath: i.fullPath }));
      const res = await window.explorerApi.buildContentLinks({
        rootDir: state.rootDir, files, strategy: "refs",
      });
      if (!res || !res.ok) {
        logLine(`graph link refs: ${(res && res.error) || "failed"}`);
        return;
      }
      addExtraLinks(res.links);
      logLine(`graph link refs: ${res.links.length} link(s) added`);
      appendSelectHistory(`Graph link: refs (${res.links.length})`);
      return;
    }

    logLine("usage: graph link ext|tags|name <pat>|grep <pat>|imports|refs|clear|list");
    return;
  }

  logLine("unknown command; type help");
}

function initLayoutSizes() {
  const rw = localStorage.getItem("ogx-right-width");
  if (rw) {
    document.documentElement.style.setProperty("--right-pane-width", rw);
  }
}

function wireResizers() {
  let colDrag = false;

  els.resizeCol.addEventListener("mousedown", (e) => {
    colDrag = true;
    els.resizeCol.classList.add("dragging");
    e.preventDefault();
  });

  window.addEventListener("mousemove", (e) => {
    if (colDrag) {
      const stage = els.resizeCol.parentElement;
      const rect = stage.getBoundingClientRect();
      const w = rect.right - e.clientX;
      const clamped = Math.min(Math.max(w, 200), rect.width * 0.75);
      document.documentElement.style.setProperty("--right-pane-width", `${clamped}px`);
    }
  });

  window.addEventListener("mouseup", () => {
    if (colDrag) {
      colDrag = false;
      els.resizeCol.classList.remove("dragging");
      const v = getComputedStyle(document.documentElement).getPropertyValue("--right-pane-width").trim();
      localStorage.setItem("ogx-right-width", v);
    }
  });
}

function wireCanvasInteraction() {
  const canvas = els.graphCanvas;
  let hoverId = "";

  canvas.addEventListener("wheel", (e) => {
    e.preventDefault();
    const rect = canvas.getBoundingClientRect();
    const sx = e.clientX - rect.left;
    const sy = e.clientY - rect.top;
    const before = screenToWorld(sx, sy);
    const { w, h } = getCanvasCssSize();
    const factor = e.deltaY > 0 ? 0.92 : 1.09;
    const next = state.camera.scale * factor;
    state.camera.scale = Math.min(state.camera.max, Math.max(state.camera.min, next));
    const after = screenToWorld(sx, sy);
    state.camera.x += before.x - after.x;
    state.camera.y += before.y - after.y;
  }, { passive: false });

  canvas.addEventListener("contextmenu", async (e) => {
    e.preventDefault();
    const rect = canvas.getBoundingClientRect();
    const sx = e.clientX - rect.left;
    const sy = e.clientY - rect.top;
    const hit = hitTestNodeId(sx, sy);
    if (!hit || hit === ROOT_ID) {
      return;
    }
    const pinned = state.graph.pinnedIds.has(hit);
    try {
      const res = await window.explorerApi.graphContextMenu({
        x: e.clientX,
        y: e.clientY,
        nodeId: hit,
        pinned,
      });
      if (res && res.action === "togglePin") {
        if (state.graph.pinnedIds.has(hit)) {
          state.graph.pinnedIds.delete(hit);
          logLine(`unpinned ${hit}`);
        } else {
          state.graph.pinnedIds.add(hit);
          logLine(`pinned ${hit}`);
        }
      }
    } catch (err) {
      logLine(`menu: ${err.message}`);
    }
  });

  canvas.addEventListener("pointerdown", (e) => {
    if (e.button !== 0) {
      return;
    }
    const rect = canvas.getBoundingClientRect();
    const sx = e.clientX - rect.left;
    const sy = e.clientY - rect.top;
    const hit = hitTestNodeId(sx, sy);
    state.interaction.pointerId = e.pointerId;
    state.interaction.startSx = sx;
    state.interaction.startSy = sy;
    state.interaction.moved = false;
    canvas.setPointerCapture(e.pointerId);
    if (hit) {
      state.interaction.mode = "node";
      state.interaction.nodeId = hit;
    } else {
      state.interaction.mode = "pan";
      state.interaction.startCamX = state.camera.x;
      state.interaction.startCamY = state.camera.y;
    }
  });

  canvas.addEventListener("pointermove", (e) => {
    const rect = canvas.getBoundingClientRect();
    const sx = e.clientX - rect.left;
    const sy = e.clientY - rect.top;
    const { w: cssW, h: cssH } = getCanvasCssSize();
    const overLog = pointInCliLogRegion(sx, sy, cssW, cssH);
    if (overLog !== state.cliLogHovered) {
      state.cliLogHovered = overLog;
    }

    if (!state.interaction.mode) {
      const hov = hitTestNodeId(sx, sy);
      if (hov !== hoverId) {
        hoverId = hov;
        canvas.style.cursor = hov ? "grab" : "default";
      }
      return;
    }

    const dx = sx - state.interaction.startSx;
    const dy = sy - state.interaction.startSy;
    if (Math.hypot(dx, dy) > 4) {
      state.interaction.moved = true;
    }

    if (state.interaction.mode === "pan") {
      state.camera.x = state.interaction.startCamX - dx / state.camera.scale;
      state.camera.y = state.interaction.startCamY - dy / state.camera.scale;
      return;
    }

    if (state.interaction.mode === "node" && state.interaction.nodeId) {
      const wpos = screenToWorld(sx, sy);
      const node = state.graph.nodesById.get(state.interaction.nodeId);
      if (node) {
        node.x = wpos.x;
        node.y = wpos.y;
        node.vx = 0;
        node.vy = 0;
      }
      canvas.style.cursor = "grabbing";
    }
  });

  canvas.addEventListener("pointerup", (e) => {
    if (e.button !== 0) {
      return;
    }
    const rect = canvas.getBoundingClientRect();
    const sx = e.clientX - rect.left;
    const sy = e.clientY - rect.top;
    const mode = state.interaction.mode;
    const moved = state.interaction.moved;
    const draggedNodeId = state.interaction.nodeId;
    try {
      canvas.releasePointerCapture(e.pointerId);
    } catch {
      /* ignore */
    }
    state.interaction.mode = null;
    state.interaction.nodeId = null;
    canvas.style.cursor = hitTestNodeId(sx, sy) ? "grab" : "default";

    if (!moved && mode === "node" && draggedNodeId) {
      selectNodeById(draggedNodeId);
    }
  });

  canvas.addEventListener("pointercancel", () => {
    state.interaction.mode = null;
    state.interaction.nodeId = null;
  });

  canvas.addEventListener("mouseleave", () => {
    state.cliLogHovered = false;
  });
}

els.pickRootBtn.addEventListener("click", async () => {
  const picked = await window.explorerApi.pickRoot();
  if (picked) {
    await loadRoot(picked);
  }
});

els.useTestenvBtn.addEventListener("click", async () => {
  const testenvPath = await window.explorerApi.getTestenvPath();
  if (!testenvPath) {
    alert("No ./testenv folder found next to the app.");
    return;
  }
  await loadRoot(testenvPath);
});

els.refreshBtn.addEventListener("click", async () => {
  await refreshFromDisk();
  logLine("refreshed");
});

function wireTerminalHistory() {
  els.terminalInput.addEventListener("keydown", (e) => {
    if (e.key === "4" && !e.ctrlKey && !e.altKey && !e.metaKey && !e.shiftKey) {
      e.preventDefault();
      runCliBack();
      return;
    }
    if (e.key === "6" && !e.ctrlKey && !e.altKey && !e.metaKey && !e.shiftKey) {
      e.preventDefault();
      runCliForward();
      return;
    }
    // Tab navigation: 1 = prev tab, 3 = next tab
    if ((e.key === "1" || e.key === "3") && !e.ctrlKey && !e.altKey && !e.metaKey && !e.shiftKey) {
      const tabs = state.appTabs.list;
      if (tabs.length < 2) return;
      const cur = tabs.findIndex((t) => t.id === state.appTabs.activeId);
      const next = e.key === "3"
        ? tabs[(cur + 1) % tabs.length]
        : tabs[(cur - 1 + tabs.length) % tabs.length];
      if (next) { e.preventDefault(); switchAppTab(next.id); }
      return;
    }
    if (e.key === "ArrowUp") {
      e.preventDefault();
      if (state.cliHistIndex === -1) {
        state.cliHistDraft = els.terminalInput.value;
      }
      if (state.cliHistIndex < state.cliHistory.length - 1) {
        state.cliHistIndex += 1;
      }
      const idx = state.cliHistory.length - 1 - state.cliHistIndex;
      els.terminalInput.value = state.cliHistory[idx] ?? "";
      return;
    }
    if (e.key === "ArrowDown") {
      e.preventDefault();
      if (state.cliHistIndex <= 0) {
        state.cliHistIndex = -1;
        els.terminalInput.value = state.cliHistDraft;
        return;
      }
      state.cliHistIndex -= 1;
      const idx = state.cliHistory.length - 1 - state.cliHistIndex;
      els.terminalInput.value = state.cliHistory[idx] ?? "";
    }
  });
}

els.terminalForm.addEventListener("submit", (event) => {
  event.preventDefault();
  const input = els.terminalInput.value.trim();
  els.terminalInput.value = "";
  if (input) {
    const last = state.cliHistory[state.cliHistory.length - 1];
    if (input !== last) {
      state.cliHistory.push(input);
      while (state.cliHistory.length > 200) {
        state.cliHistory.shift();
      }
    }
  }
  state.cliHistIndex = -1;
  state.cliHistDraft = "";
  // Persist to .ogx-history.log (fire-and-forget)
  if (input && state.rootDir && window.explorerApi.appendHistory) {
    window.explorerApi.appendHistory(state.rootDir, [input]).catch(() => {});
  }
  parseCommand(input).catch((err) => {
    logLine(`command failed: ${err.message}`);
  });
});

window.addEventListener("resize", () => {
  resizeCanvas();
});

// ── Node type registration ─────────────────────────────────────────────────
// visibleInModes controls which graph view modes show this node type.
// Add new types here (e.g. "concept") without touching nodeIsVisible logic.

EP.registerNodeType("file",    { visibleInModes: new Set(["files", "hybrid"]) });
EP.registerNodeType("folder",  { visibleInModes: new Set(["folders", "hybrid"]) });

// ── Card renderer registration ─────────────────────────────────────────────
// Register additional types here when new node types are introduced.
// Unknown types fall back to "file" via EP.getCardRenderer.

EP.registerCardRenderer("file", buildFileCard);

// ── Graph source registration ──────────────────────────────────────────────
// "filesystem" is always active. Additional sources (e.g. "research") register
// themselves when their data is loaded and unregister on unload.

EP.registerGraphSource({
  id: "filesystem",
  getNodes(ctx) {
    const { state: s, world } = ctx;
    const cx = world.w * 0.5;
    const cy = world.h * 0.5;
    const nodes = [{ id: ROOT_ID, x: cx, y: cy }];
    for (const item of s.fsSnapshot.items) {
      nodes.push({ id: itemIdFromRelPath(item.relPath) });
    }
    return nodes;
  },
  getLinks(ctx) {
    const links = [];
    for (const item of ctx.state.fsSnapshot.items) {
      const id = itemIdFromRelPath(item.relPath);
      const parentId = itemIdFromRelPath(parentRelPath(item.relPath));
      links.push({ a: parentId, b: id });
    }
    return links;
  },
});

applyChromeLayout();
wireTerminalHistory();
initLayoutSizes();
wireResizers();
wireCanvasInteraction();
resizeCanvas();
state.camera.x = state.world.w * 0.5;
state.camera.y = state.world.h * 0.5;
buildGraph();
restartGraphLoop();
updateControlInputs();
renderWorkspaceDeck();
renderAppTabs();
logLine("type help · wheel zoom · drag pan · drag nodes");
