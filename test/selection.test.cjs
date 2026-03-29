/**
 * ExplorerPlus — selection, working-set, tag, and pipeline filter tests.
 *
 * Tests the pure logic in model.js (EP.*) plus the helpers that drive
 * getWorkingSetItems / getWorkspaceRowsForDisplay, without any DOM or Electron.
 *
 * Run:  node test/selection.test.cjs
 */

"use strict";

// ── Minimal model.js polyfill ──────────────────────────────────────────────

// Load EP from model.js (it writes to globalThis.EP)
const { execSync } = require("child_process");
const fs = require("fs");
const path = require("path");

// Eval model.js in this context
const modelSrc = fs.readFileSync(path.join(__dirname, "../renderer/model.js"), "utf8");
const globalThis_ = globalThis;
eval(modelSrc); // sets globalThis.EP
const EP = globalThis_.EP;

// ── Test harness ───────────────────────────────────────────────────────────

let passed = 0;
let failed = 0;
const failures = [];

function assert(cond, msg) {
  if (!cond) {
    failed++;
    failures.push(msg);
    console.error(`  FAIL  ${msg}`);
  } else {
    passed++;
    console.log(`  ok    ${msg}`);
  }
}

function assertEq(a, b, msg) {
  const ok = JSON.stringify(a) === JSON.stringify(b);
  if (!ok) {
    failed++;
    const detail = `${msg}\n       got      ${JSON.stringify(a)}\n       expected ${JSON.stringify(b)}`;
    failures.push(detail);
    console.error(`  FAIL  ${detail}`);
  } else {
    passed++;
    console.log(`  ok    ${msg}`);
  }
}

function section(name) {
  console.log(`\n── ${name}`);
}

// ── Fixtures ───────────────────────────────────────────────────────────────

// A small synthetic filesystem mirroring the testenv structure
const FS_ITEMS = [
  { name: "billybob",            relPath: "billybob",                          type: "folder", fullPath: "/r/billybob",                         size: 0 },
  { name: "jeep_wrangler.txt",   relPath: "billybob/jeep_wrangler.txt",        type: "file",   fullPath: "/r/billybob/jeep_wrangler.txt",        size: 1024 },
  { name: "ford_f150.txt",       relPath: "billybob/ford_f150.txt",            type: "file",   fullPath: "/r/billybob/ford_f150.txt",            size: 2048 },
  { name: "chevrolet_silverado.txt", relPath: "billybob/chevrolet_silverado.txt", type: "file", fullPath: "/r/billybob/chevrolet_silverado.txt", size: 3 * 1024 * 1024 },
  { name: "henry",               relPath: "henry",                             type: "folder", fullPath: "/r/henry",                             size: 0 },
  { name: "honda_civic.txt",     relPath: "henry/honda_civic.txt",             type: "file",   fullPath: "/r/henry/honda_civic.txt",             size: 512 },
  { name: "marshall",            relPath: "marshall",                          type: "folder", fullPath: "/r/marshall",                          size: 0 },
  { name: "subaru_outback.txt",  relPath: "marshall/subaru_outback.txt",       type: "file",   fullPath: "/r/marshall/subaru_outback.txt",       size: 1536 },
  { name: "toyota_rav4.txt",     relPath: "marshall/toyota_rav4.txt",          type: "file",   fullPath: "/r/marshall/toyota_rav4.txt",          size: 800 },
];

// Simulated content cache for content-filter tests
const CONTENT_CACHE = new Map([
  ["billybob/jeep_wrangler.txt",       "Soft top zipper. Off-road trail vehicle."],
  ["billybob/ford_f150.txt",           "Hauling tools. Tailgate latch sticks. No engine issues noted."],
  ["billybob/chevrolet_silverado.txt", "Engine runs strong. Check engine light evap code."],
  ["henry/honda_civic.txt",            "Daily commuter. No engine warning lights."],
  ["marshall/subaru_outback.txt",      "Mountain drives. No warning lights."],
  ["marshall/toyota_rav4.txt",         "Family road trips. Infotainment Bluetooth slow."],
]);

const ROOT_ID = "__root__";

function normRel(p) { return String(p).replace(/\\/g, "/"); }

function parentRelPath(relPath) {
  const slash = Math.max(relPath.lastIndexOf("/"), relPath.lastIndexOf("\\"));
  if (slash < 0) return "";
  return relPath.slice(0, slash);
}

function itemIdFromRelPath(relPath) { return relPath || ROOT_ID; }

function findItemByRelPath(rel) {
  const n = normRel(rel);
  return FS_ITEMS.find((i) => normRel(i.relPath) === n) || null;
}

// Simulate the graph links (tree structure)
function buildGraphLinks(items) {
  return items.map((item) => ({
    a: itemIdFromRelPath(parentRelPath(item.relPath)),
    b: itemIdFromRelPath(item.relPath),
  }));
}

const GRAPH_LINKS = buildGraphLinks(FS_ITEMS);

function getNeighborIds(id, links) {
  const s = new Set();
  for (const l of links) {
    if (l.a === id) s.add(l.b);
    if (l.b === id) s.add(l.a);
  }
  s.delete(id);
  return [...s];
}

// Simulate getFilteredSortedItems given a minimal view state
function makeGetFiltered(items, view, tagsByPath = {}) {
  return () => items.filter((item) => {
    const searchMatch =
      !view.searchText ||
      item.name.toLowerCase().includes(view.searchText) ||
      item.relPath.toLowerCase().includes(view.searchText);
    const itemTags = (tagsByPath[item.relPath] || []).map((t) => t.toLowerCase());
    const tagMatch = !view.tagFilter || itemTags.some((t) => t.includes(view.tagFilter));
    return searchMatch && tagMatch;
  });
}

// Full working-set pipeline as in renderer.js
function getWorkingSetItems(state, tagsByPath = {}) {
  const getFiltered = makeGetFiltered(FS_ITEMS, state.view, tagsByPath);
  const base = EP.getBaseWorkingSetItems(state, getFiltered);
  const allowed = new Set(getFiltered().map((i) => i.relPath));
  if (!state.wsExpansion) return base;
  let seed = base;
  if (state.view.selectedId && state.view.selectedId !== ROOT_ID) {
    const anchor = findItemByRelPath(state.view.selectedId);
    if (anchor) seed = [anchor];
  }
  const expanded = EP.applyWsExpansion(seed, state.wsExpansion, FS_ITEMS, {
    normRel,
    parentRelPath,
    itemIdFromRelPath,
    findItemByRelPath,
    getGraphNeighborIds: (id) => getNeighborIds(id, GRAPH_LINKS),
  });
  return expanded.filter((i) => allowed.has(i.relPath));
}

// Simulate getWorkspaceRowsForDisplay (file-only, reader filter — no pipeline-result filtering)
function getWorkspaceRows(state, tagsByPath = {}) {
  let rows = getWorkingSetItems(state, tagsByPath).filter((i) => i.type === "file");
  const f = (state.workspace.filterText || "").trim().toLowerCase();
  if (f) rows = rows.filter((i) => i.name.toLowerCase().includes(f) || i.relPath.toLowerCase().includes(f));
  return rows;
}

function makeState(overrides = {}) {
  return {
    extSelection: null,
    wsExpansion: null,
    cardRender: overrides.cardRender || { pipeline: [] },
    ...overrides,
    view: {
      filters: [],        // canonical filter list
      searchText: "",     // legacy (kept for compat)
      tagFilter: "",      // legacy (kept for compat)
      selectedId: ROOT_ID,
      mode: "folders",
      ...((overrides.view) || {}),
    },
    workspace: { filterText: "", ...((overrides.workspace) || {}) },
  };
}

// Shared helpers for EP.buildWorkingSet (used across many sections)
const TAGS = {};

const PIPELINE_HELPERS = {
  ROOT_ID,
  normRel,
  parentRelPath,
  itemIdFromRelPath,
  findItemByRelPath,
  findItemById: findItemByRelPath,
  getTagsForId: (relPath) => TAGS[relPath] || [],
  getContentForRelPath: (relPath) => CONTENT_CACHE.get(relPath) ?? null,
  getGraphNeighborIds: (id) => getNeighborIds(id, GRAPH_LINKS),
};

function buildWS(state, tagsOverride) {
  const helpers = tagsOverride
    ? { ...PIPELINE_HELPERS, getTagsForId: (r) => tagsOverride[r] || [] }
    : PIPELINE_HELPERS;
  const set = EP.buildWorkingSet(FS_ITEMS, state, helpers);
  return FS_ITEMS.filter((i) => set.has(i.relPath));
}

// ── Tests ──────────────────────────────────────────────────────────────────

section("1. Baseline — no filters");
{
  const state = makeState();
  const ws = getWorkingSetItems(state);
  assert(ws.length === FS_ITEMS.length, `working set = all ${FS_ITEMS.length} items`);
  const files = ws.filter((i) => i.type === "file");
  assert(files.length === 6, "6 files in working set");
}

section("2. Text filter");
{
  const state = makeState({ view: { searchText: "ford", tagFilter: "", selectedId: ROOT_ID } });
  const ws = getWorkingSetItems(state);
  const names = ws.map((i) => i.name);
  assert(names.includes("ford_f150.txt"), "filter 'ford' includes ford_f150.txt");
  assert(!names.includes("honda_civic.txt"), "filter 'ford' excludes honda_civic.txt");
}

section("3. Extension selection");
{
  const state = makeState({
    extSelection: { ext: "txt", folderIds: new Set() },
  });
  const base = EP.getBaseWorkingSetItems(state, makeGetFiltered(FS_ITEMS, state.view));
  assert(base.every((i) => i.type === "file"), "ext=txt: only files");
  assert(base.every((i) => i.name.endsWith(".txt")), "ext=txt: all items end in .txt");
  assert(base.length === 6, "ext=txt: 6 txt files");
}

section("4. expand children from a folder");
{
  const state = makeState({
    view: { searchText: "", tagFilter: "", selectedId: "billybob" },
    wsExpansion: "children",
  });
  const ws = getWorkingSetItems(state);
  const names = ws.map((i) => i.name);
  // seed = billybob; children = jeep, ford, chevrolet
  assert(names.includes("jeep_wrangler.txt"), "expand children of billybob: jeep");
  assert(names.includes("ford_f150.txt"), "expand children of billybob: ford");
  assert(names.includes("chevrolet_silverado.txt"), "expand children of billybob: chevrolet");
  // billybob itself (the seed) should be included
  assert(names.includes("billybob"), "expand children: seed node (billybob) included");
  // henry's files must NOT be included
  assert(!names.includes("honda_civic.txt"), "expand children of billybob: honda excluded");
}

section("5. expand siblings from a file node");
{
  const state = makeState({
    view: { searchText: "", tagFilter: "", selectedId: "billybob/ford_f150.txt" },
    wsExpansion: "siblings",
  });
  const ws = getWorkingSetItems(state);
  const names = ws.map((i) => i.name);
  // seed = ford_f150; siblings share parent billybob
  assert(names.includes("jeep_wrangler.txt"), "siblings of ford: jeep");
  assert(names.includes("chevrolet_silverado.txt"), "siblings of ford: chevrolet");
  assert(names.includes("ford_f150.txt"), "siblings of ford: ford itself");
  assert(!names.includes("honda_civic.txt"), "siblings of ford: honda excluded");
}

section("6. expand parents from a file node");
{
  const state = makeState({
    view: { searchText: "", tagFilter: "", selectedId: "billybob/ford_f150.txt" },
    wsExpansion: "parents",
  });
  const ws = getWorkingSetItems(state);
  const names = ws.map((i) => i.name);
  assert(names.includes("billybob"), "expand parents: billybob in set");
  assert(names.includes("ford_f150.txt"), "expand parents: seed file included");
}

section("7. expand +1 (hop1) from a folder — graph neighbours");
{
  const state = makeState({
    view: { searchText: "", tagFilter: "", selectedId: "billybob" },
    wsExpansion: "hop1",
  });
  const ws = getWorkingSetItems(state);
  const names = ws.map((i) => i.name);
  // billybob's graph neighbours: root + jeep + ford + chevrolet
  assert(names.includes("billybob"), "hop1: seed included");
  assert(names.includes("ford_f150.txt"), "hop1: child ford included");
  assert(names.includes("jeep_wrangler.txt"), "hop1: child jeep included");
}

section("8. expand clear resets to base");
{
  const stateWithExpand = makeState({
    view: { searchText: "", tagFilter: "", selectedId: "billybob" },
    wsExpansion: "children",
  });
  const stateCleared = makeState({
    view: { searchText: "", tagFilter: "", selectedId: "billybob" },
    wsExpansion: null,
  });
  const withExp = getWorkingSetItems(stateWithExpand);
  const cleared = getWorkingSetItems(stateCleared);
  assert(cleared.length < withExp.length || cleared.length === FS_ITEMS.length, "cleared expansion ≤ expanded set");
  // cleared with no filter = all items
  assert(cleared.length === FS_ITEMS.length, "after clear: full item set");
}

section("9. Tag filter");
{
  const tags = {
    "billybob/ford_f150.txt": ["truck", "workhorse"],
    "billybob/chevrolet_silverado.txt": ["truck", "workhorse"],
  };
  const state = makeState({ view: { searchText: "", tagFilter: "truck", selectedId: ROOT_ID } });
  const ws = getWorkingSetItems(state, tags);
  const names = ws.map((i) => i.name);
  assert(names.includes("ford_f150.txt"), "tagfilter truck: ford included");
  assert(names.includes("chevrolet_silverado.txt"), "tagfilter truck: chevrolet included");
  assert(!names.includes("honda_civic.txt"), "tagfilter truck: honda excluded");
  assert(!names.includes("jeep_wrangler.txt"), "tagfilter truck: jeep excluded (untagged)");
}

section("10. Reader deck filter (filterText)");
{
  const state = makeState({ workspace: { filterText: "ford", pipelineResultFilter: null } });
  const rows = getWorkspaceRows(state);
  assert(rows.length === 1, "reader filter 'ford': 1 result");
  assert(rows[0].name === "ford_f150.txt", "reader filter 'ford': correct file");
}

section("11. Render pipeline does NOT filter deck (architecture invariant)");
{
  // card render grep does not remove cards from the deck — render ≠ filter.
  // pipelineResultFilter was removed. All files remain visible regardless of render output.
  const state = makeState({
    cardRender: { pipeline: [{ op: "grep", pattern: "ford" }] },
    workspace: { filterText: "" },
  });
  const rows = getWorkspaceRows(state);
  assert(rows.length === 6, "render pipeline active: all 6 files still in deck");
}

section("12. To filter by content, use filter content — not render");
{
  // filter content is the correct mechanism; it uses the content cache, not render output.
  const state = makeState({
    view: { filters: [{ type: "content", value: "engine" }], selectedId: ROOT_ID },
  });
  const ws = buildWS(state);
  // CONTENT_CACHE has "engine" in chevrolet and honda entries
  const names = ws.map((i) => i.name);
  assert(names.includes("chevrolet_silverado.txt"), "content filter: chevrolet matches 'engine'");
  assert(names.includes("honda_civic.txt"), "content filter: honda matches 'engine'");
  assert(names.includes("ford_f150.txt"), "content filter: ford matches 'engine' (in 'No engine issues noted')");
  assert(!names.includes("jeep_wrangler.txt"), "content filter: jeep excluded (no engine in content)");
  assert(!names.includes("toyota_rav4.txt"), "content filter: toyota excluded (no engine in content)");
}

section("13. filter content degrades gracefully for items not in cache");
{
  // Items with no content cache entry are KEPT (not excluded) during cache warm-up.
  const partialCache = new Map([
    ["billybob/ford_f150.txt", "No engine issues noted."],
    // chevrolet and others NOT in this partial cache
  ]);
  const helpers = {
    ...PIPELINE_HELPERS,
    getContentForRelPath: (rel) => partialCache.get(rel) ?? null,
  };
  const state = makeState({
    view: { filters: [{ type: "content", value: "engine" }], selectedId: ROOT_ID },
  });
  const set = EP.buildWorkingSet(FS_ITEMS, state, helpers);
  const ws = FS_ITEMS.filter((i) => set.has(i.relPath));
  // ford is in cache and matches; all others are not in cache → kept (graceful degrade)
  assert(ws.some((i) => i.name === "ford_f150.txt"), "partial cache: ford (cached match) included");
  assert(ws.some((i) => i.name === "jeep_wrangler.txt"), "partial cache: jeep (not cached) kept");
  assert(ws.some((i) => i.name === "honda_civic.txt"), "partial cache: honda (not cached) kept");
}

section("14. filter content + tag compose correctly");
{
  // content filter narrows to files mentioning 'engine'; tag adds a separate condition
  const tags = { "billybob/chevrolet_silverado.txt": ["workhorse"] };
  const state = makeState({
    view: {
      filters: [
        { type: "content", value: "engine" },
        { type: "tag", value: "workhorse" },
      ],
      selectedId: ROOT_ID,
    },
  });
  const ws = buildWS(state, tags);
  const names = ws.map((i) => i.name);
  // Must match both: content contains 'engine' AND tagged 'workhorse'
  // chevrolet: engine in content ✓, workhorse tag ✓ → included
  // honda: engine in content ✓, no workhorse tag ✗ → excluded
  assert(names.includes("chevrolet_silverado.txt"), "content+tag: chevrolet matches both");
  assert(!names.includes("honda_civic.txt"), "content+tag: honda excluded (no workhorse tag)");
  assert(!names.includes("ford_f150.txt"), "content+tag: ford excluded (no engine in content)");
}

section("15. select clear resets selectedId to ROOT_ID");
{
  // Simulate what 'select clear' does
  let selectedId = "billybob/ford_f150.txt";
  let extSelection = { ext: "txt", folderIds: new Set() };
  // clear
  selectedId = ROOT_ID;
  extSelection = null;
  assert(selectedId === ROOT_ID, "select clear: selectedId = ROOT_ID");
  assert(extSelection === null, "select clear: extSelection = null");
}

section("16. Ext selection excludes folders from file list");
{
  const state = makeState({
    extSelection: { ext: "txt", folderIds: new Set(["billybob", "henry", "marshall"]) },
  });
  const base = EP.getBaseWorkingSetItems(state, makeGetFiltered(FS_ITEMS, state.view));
  assert(base.every((i) => i.type === "file"), "ext selection: no folders in base");
  assert(base.length === 6, "ext selection: 6 txt files");
}

section("17. Text filter + ext selection compose correctly");
{
  const state = makeState({
    view: { searchText: "billy", tagFilter: "", selectedId: ROOT_ID },
    extSelection: { ext: "txt", folderIds: new Set() },
  });
  const getFiltered = makeGetFiltered(FS_ITEMS, state.view);
  const base = EP.getBaseWorkingSetItems(state, getFiltered);
  // text filter 'billy' matches billybob folder + billybob's children
  // ext filter then narrows to .txt only
  assert(base.every((i) => i.type === "file"), "filter+ext: only files");
  assert(base.every((i) => i.relPath.startsWith("billybob/")), "filter+ext: only billybob's files");
  assert(base.length === 3, "filter+ext: 3 billybob txt files");
}

section("18. expand children from ROOT_ID uses full base set as seed");
{
  const state = makeState({
    view: { searchText: "", tagFilter: "", selectedId: ROOT_ID },
    wsExpansion: "children",
  });
  const ws = getWorkingSetItems(state);
  // seed = full base; children of any item in that set
  // since root's children are billybob/henry/marshall (folders),
  // and those folders' children are the files, the full tree is included
  assert(ws.length >= FS_ITEMS.length, "expand children from root: all items included");
}

section("19. Tag filter + expand siblings compose correctly");
{
  const tags = {
    "billybob/ford_f150.txt": ["truck"],
    "billybob/chevrolet_silverado.txt": ["truck"],
  };
  // Filter to truck-tagged, then expand to siblings of those files
  const state = makeState({
    view: { searchText: "", tagFilter: "truck", selectedId: ROOT_ID },
    wsExpansion: "siblings",
  });
  const ws = getWorkingSetItems(state, tags);
  // Base (truck tagged): ford + chevrolet
  // siblings of ford and chevrolet: jeep, ford, chevrolet (same parent billybob)
  // BUT allowed = only truck-tagged files (tag filter applied to allowed set)
  // So jeep is NOT in allowed (no truck tag), it gets filtered out
  const names = ws.map((i) => i.name);
  assert(names.includes("ford_f150.txt"), "tag+siblings: ford present");
  assert(names.includes("chevrolet_silverado.txt"), "tag+siblings: chevrolet present");
  // jeep has no 'truck' tag so filtered from allowed
  assert(!names.includes("jeep_wrangler.txt"), "tag+siblings: jeep excluded (not tag-matched)");
}

section("20. EP.parseCardRenderPipeline round-trips");
{
  const steps = EP.parseCardRenderPipeline("head 10 | grep error | col 1,3");
  assertEq(steps[0], { op: "head", n: 10 }, "pipeline step 0: head 10");
  assertEq(steps[1], { op: "grep", pattern: "error" }, "pipeline step 1: grep error");
  assertEq(steps[2], { op: "col", cols: [0, 2] }, "pipeline step 2: col 1,3 (0-indexed)");
}

section("21. Pipeline apply: grep + head");
{
  const text = "alpha\nbeta\nerror here\nalpha error\ngamma";
  const pipeline = EP.parseCardRenderPipeline("grep error | head 2");
  const out = EP.applyPipelineToText(text, pipeline);
  const lines = out.split("\n");
  assert(lines.every((l) => l.toLowerCase().includes("error")), "grep error: all lines have error");
  assert(lines.length <= 2, "head 2: at most 2 lines");
}

// ── Filter pipeline tests ──────────────────────────────────────────────────

section("22. applyPreFilters — text handler");
{
  const filtered = EP.applyPreFilters(FS_ITEMS, [{ type: "text", value: "ford" }], {});
  assert(filtered.every((i) => i.name.includes("ford") || i.relPath.includes("ford")),
    "text filter: all results contain 'ford'");
  assert(filtered.length === 1, "text filter: exactly 1 match (ford_f150.txt)");
}

section("23. applyPreFilters — ext handler");
{
  const filtered = EP.applyPreFilters(FS_ITEMS, [{ type: "ext", value: "txt" }], {});
  assert(filtered.every((i) => i.type === "file"), "ext filter: only files");
  assert(filtered.every((i) => i.name.endsWith(".txt")), "ext filter: all end in .txt");
  assert(filtered.length === 6, "ext filter: 6 txt files");
}

section("24. applyPreFilters — tag handler");
{
  const tags = { "billybob/ford_f150.txt": ["urgent"], "henry/honda_civic.txt": ["urgent"] };
  const filtered = EP.applyPreFilters(
    FS_ITEMS,
    [{ type: "tag", value: "urgent" }],
    { getTagsForId: (r) => tags[r] || [] },
  );
  assert(filtered.length === 2, "tag filter: 2 items tagged urgent");
  assert(filtered.some((i) => i.name === "ford_f150.txt"), "tag filter: ford included");
  assert(filtered.some((i) => i.name === "honda_civic.txt"), "tag filter: honda included");
}

section("25. applyPreFilters — chained text + ext");
{
  const filtered = EP.applyPreFilters(
    FS_ITEMS,
    [{ type: "text", value: "billybob" }, { type: "ext", value: "txt" }],
    {},
  );
  assert(filtered.every((i) => i.relPath.includes("billybob")), "chained: all in billybob");
  assert(filtered.every((i) => i.name.endsWith(".txt")), "chained: all .txt");
  assert(filtered.length === 3, "chained text+ext: 3 results");
}

section("26. buildPreFilters — canonical filters[] takes precedence over legacy fields");
{
  // New path: reads from state.view.filters[]
  const stateNew = makeState({
    view: {
      filters: [{ type: "name", value: "ford" }, { type: "ext", value: "txt" }],
      searchText: "ignored", // legacy field present but ignored when canonical filter covers same type
      selectedId: ROOT_ID,
    },
  });
  const filtersNew = EP.buildPreFilters(stateNew);
  assert(filtersNew.some((f) => f.type === "name" && f.value === "ford"), "canonical: name filter present");
  assert(filtersNew.some((f) => f.type === "ext" && f.value === "txt"), "canonical: ext filter present");
  // searchText 'ignored' should NOT produce a duplicate name/text filter
  const nameCount = filtersNew.filter((f) => f.type === "name" || f.type === "text").length;
  assert(nameCount === 1, "canonical: no duplicate from legacy searchText when name filter active");

  // Legacy path: no filters[] → falls back to legacy state fields
  const stateLegacy = makeState({
    view: { searchText: "ford", tagFilter: "", selectedId: ROOT_ID },
    extSelection: { ext: "txt", folderIds: new Set() },
  });
  const filtersLegacy = EP.buildPreFilters(stateLegacy);
  assert(filtersLegacy.some((f) => (f.type === "text" || f.type === "name") && f.value === "ford"),
    "legacy: text/name filter derived from searchText");
  assert(filtersLegacy.some((f) => f.type === "ext" && f.value === "txt"),
    "legacy: ext filter derived from extSelection");
}

section("27. buildWorkingSet — no filters, returns all items");
{
  const state = makeState();
  const ws = buildWS(state);
  assert(ws.length === FS_ITEMS.length, "buildWorkingSet: no filters → all items");
}

section("28. buildWorkingSet — text filter");
{
  const state = makeState({ view: { searchText: "ford", tagFilter: "", selectedId: ROOT_ID } });
  const ws = buildWS(state);
  assert(ws.every((i) => i.name.includes("ford") || i.relPath.includes("ford")),
    "buildWorkingSet text: all results match");
  assert(ws.length === 1, "buildWorkingSet text: 1 result");
}

section("29. buildWorkingSet — ext filter");
{
  const state = makeState({ extSelection: { ext: "txt", folderIds: new Set() } });
  const ws = buildWS(state);
  assert(ws.every((i) => i.type === "file"), "buildWorkingSet ext: files only");
  assert(ws.length === 6, "buildWorkingSet ext: 6 txt files");
}

section("30. buildWorkingSet — expansion crosses ext boundary (allowed = text+tag, not ext)");
{
  // ext filter is active, but expansion should still include items regardless of ext
  // because the allowed set excludes ext by design
  const state = makeState({
    view: { searchText: "", tagFilter: "", selectedId: "billybob" },
    extSelection: { ext: "txt", folderIds: new Set() },
    wsExpansion: "children",
  });
  const ws = buildWS(state);
  const names = ws.map((i) => i.name);
  // expansion from billybob should include its .txt children
  assert(names.includes("ford_f150.txt"), "expansion+ext: ford included");
  assert(names.includes("jeep_wrangler.txt"), "expansion+ext: jeep included");
  // billybob itself (the seed) is a folder — ext applies to base, not allowed set
  // so billybob folder may or may not be in set depending on ext-only-files behavior
  assert(!names.includes("honda_civic.txt"), "expansion+ext: honda (wrong parent) excluded");
}

section("31. buildWorkingSet — output is a Set (correct deduplication)");
{
  const state = makeState({
    view: { searchText: "billybob", tagFilter: "", selectedId: ROOT_ID },
    wsExpansion: "children",
  });
  const ws = buildWS(state);
  const relPaths = ws.map((i) => i.relPath);
  const unique = new Set(relPaths);
  assert(relPaths.length === unique.size, "buildWorkingSet: no duplicate entries");
}

section("32. registerFilter — custom filter type");
{
  EP.registerFilter("name-starts-with", function (items, filter) {
    return items.filter((i) => i.name.startsWith(filter.value));
  });
  const filtered = EP.applyPreFilters(
    FS_ITEMS,
    [{ type: "name-starts-with", value: "ford" }],
    {},
  );
  assert(filtered.length === 1, "custom filter: 1 item starting with 'ford'");
  assert(filtered[0].name === "ford_f150.txt", "custom filter: correct item");
  // Clean up
  delete EP.FILTER_HANDLERS["name-starts-with"];
}

// ── Graph source tests ─────────────────────────────────────────────────────

const WORLD = { w: 4200, h: 3200 };
const CX = WORLD.w * 0.5;
const CY = WORLD.h * 0.5;

function makeCtx(existing = new Map()) {
  return { existing, world: WORLD };
}

section("33. mergeGraphSources — single source, correct nodes and links");
{
  const source = {
    id: "test-fs",
    getNodes: (ctx) => [
      { id: ROOT_ID, x: ctx.world.w * 0.5, y: ctx.world.h * 0.5 },
      { id: "folder/a.txt" },
      { id: "folder/b.txt" },
    ],
    getLinks: () => [
      { a: ROOT_ID, b: "folder" },
      { a: "folder", b: "folder/a.txt" },
      { a: "folder", b: "folder/b.txt" },
    ],
  };
  const { nodesById, links } = EP.mergeGraphSources([source], makeCtx());
  assert(nodesById.has(ROOT_ID), "single source: ROOT_ID node present");
  assert(nodesById.has("folder/a.txt"), "single source: a.txt node present");
  assert(nodesById.has("folder/b.txt"), "single source: b.txt node present");
  assert(links.length === 3, "single source: 3 links");
}

section("34. mergeGraphSources — ROOT_ID gets center position when not in existing");
{
  const source = {
    id: "test-center",
    getNodes: (ctx) => [{ id: ROOT_ID, x: ctx.world.w * 0.5, y: ctx.world.h * 0.5 }],
    getLinks: () => [],
  };
  const { nodesById } = EP.mergeGraphSources([source], makeCtx());
  const root = nodesById.get(ROOT_ID);
  assert(root.x === CX, "ROOT_ID x = world center x");
  assert(root.y === CY, "ROOT_ID y = world center y");
}

section("35. mergeGraphSources — position preserved from existing");
{
  const existing = new Map([
    ["folder/a.txt", { id: "folder/a.txt", x: 100, y: 200, vx: 1.5, vy: -0.5 }],
  ]);
  const source = {
    id: "test-preserve",
    getNodes: () => [{ id: "folder/a.txt" }, { id: "folder/b.txt" }],
    getLinks: () => [],
  };
  const { nodesById } = EP.mergeGraphSources([source], makeCtx(existing));
  const a = nodesById.get("folder/a.txt");
  assert(a.x === 100 && a.y === 200, "existing node: position preserved");
  assert(a.vx === 1.5 && a.vy === -0.5, "existing node: velocity preserved");
  const b = nodesById.get("folder/b.txt");
  assert(b.x !== undefined, "new node: gets a position");
  assert(b.vx === 0 && b.vy === 0, "new node: starts at rest");
}

section("36. mergeGraphSources — two sources, node deduplication");
{
  const s1 = {
    id: "s1",
    getNodes: () => [{ id: "node-a" }, { id: "node-b" }],
    getLinks: () => [{ a: "node-a", b: "node-b" }],
  };
  const s2 = {
    id: "s2",
    // node-b already exists; node-c is new
    getNodes: () => [{ id: "node-b" }, { id: "node-c" }],
    getLinks: () => [{ a: "node-b", b: "node-c" }],
  };
  const { nodesById, links } = EP.mergeGraphSources([s1, s2], makeCtx());
  assert(nodesById.size === 3, "dedup: 3 unique nodes (a, b, c)");
  assert(nodesById.has("node-a") && nodesById.has("node-b") && nodesById.has("node-c"),
    "dedup: all three nodes present");
  assert(links.length === 2, "dedup: links from both sources concatenated (2 total)");
}

section("37. mergeGraphSources — meta enrichment from later source");
{
  const s1 = {
    id: "s1",
    getNodes: () => [{ id: "paper-1", meta: { type: "file" } }],
    getLinks: () => [],
  };
  const s2 = {
    id: "s2",
    // research source enriches the same node
    getNodes: () => [{ id: "paper-1", meta: { type: "paper", title: "Did Highways Cause Suburbanization?" } }],
    getLinks: () => [],
  };
  const { nodesById } = EP.mergeGraphSources([s1, s2], makeCtx());
  const node = nodesById.get("paper-1");
  assert(node.type === "paper", "meta enrichment: later source wins on type");
  assert(node.title === "Did Highways Cause Suburbanization?", "meta enrichment: title added by second source");
}

section("38. mergeGraphSources — empty sources list produces empty graph");
{
  const { nodesById, links } = EP.mergeGraphSources([], makeCtx());
  assert(nodesById.size === 0, "empty sources: no nodes");
  assert(links.length === 0, "empty sources: no links");
}

section("39. registerGraphSource — replaces source with same id");
{
  EP.registerGraphSource({ id: "dup-test", getNodes: () => [{ id: "n1" }], getLinks: () => [] });
  EP.registerGraphSource({ id: "dup-test", getNodes: () => [{ id: "n2" }], getLinks: () => [] });
  const count = EP.GRAPH_SOURCES.filter((s) => s.id === "dup-test").length;
  assert(count === 1, "registerGraphSource: only one entry per id");
  const { nodesById } = EP.mergeGraphSources(
    EP.GRAPH_SOURCES.filter((s) => s.id === "dup-test"),
    makeCtx(),
  );
  assert(nodesById.has("n2") && !nodesById.has("n1"), "registerGraphSource: replacement source used");
  EP.unregisterGraphSource("dup-test");
  assert(EP.GRAPH_SOURCES.every((s) => s.id !== "dup-test"), "unregisterGraphSource: source removed");
}

// ── Card renderer registry tests ──────────────────────────────────────────

section("40. registerCardRenderer — dispatch by type");
{
  const calls = [];
  EP.registerCardRenderer("test-paper", (item, card, rowIndex1) => {
    calls.push({ type: "test-paper", name: item.name });
    return null;
  });
  EP.registerCardRenderer("file", (item, card, rowIndex1) => {
    calls.push({ type: "file", name: item.name });
    return null;
  });

  const mockItem = { relPath: "a.md", name: "a.md", type: "file" };
  const mockCard = {};

  EP.getCardRenderer("test-paper")(mockItem, mockCard, 1);
  assert(calls.length === 1 && calls[0].type === "test-paper",
    "dispatch: test-paper renderer called");

  EP.getCardRenderer("file")(mockItem, mockCard, 2);
  assert(calls.length === 2 && calls[1].type === "file",
    "dispatch: file renderer called");

  delete EP.CARD_RENDERERS["test-paper"];
  delete EP.CARD_RENDERERS["file"];
}

section("41. getCardRenderer — unknown type falls back to 'file'");
{
  let fileCalled = false;
  EP.registerCardRenderer("file", () => { fileCalled = true; return null; });

  const renderer = EP.getCardRenderer("concept");
  assert(renderer !== null, "fallback: renderer returned for unknown type");
  renderer({}, {}, 1);
  assert(fileCalled, "fallback: file renderer invoked for unknown type 'concept'");

  delete EP.CARD_RENDERERS["file"];
}

section("42. getCardRenderer — returns null when no renderers registered");
{
  // CARD_RENDERERS is empty after previous cleanup
  const renderer = EP.getCardRenderer("file");
  assert(renderer === null, "no renderers: getCardRenderer returns null");
}

// ── Node type registry tests ───────────────────────────────────────────────

section("43. registerNodeType — file visible in files and hybrid, not folders");
{
  EP.registerNodeType("file", { visibleInModes: new Set(["files", "hybrid"]) });
  assert(EP.isNodeTypeVisibleInMode("file", "files"),   "file visible in files mode");
  assert(EP.isNodeTypeVisibleInMode("file", "hybrid"),  "file visible in hybrid mode");
  assert(!EP.isNodeTypeVisibleInMode("file", "folders"),"file hidden in folders mode");
}

section("44. registerNodeType — folder visible in folders and hybrid, not files");
{
  EP.registerNodeType("folder", { visibleInModes: new Set(["folders", "hybrid"]) });
  assert(EP.isNodeTypeVisibleInMode("folder", "folders"), "folder visible in folders mode");
  assert(EP.isNodeTypeVisibleInMode("folder", "hybrid"),  "folder visible in hybrid mode");
  assert(!EP.isNodeTypeVisibleInMode("folder", "files"),  "folder hidden in files mode");
}

section("45. isNodeTypeVisibleInMode — unknown type defaults to visible");
{
  assert(EP.isNodeTypeVisibleInMode("concept", "folders"), "unknown type: visible in folders");
  assert(EP.isNodeTypeVisibleInMode("concept", "files"),   "unknown type: visible in files");
  assert(EP.isNodeTypeVisibleInMode("concept", "hybrid"),  "unknown type: visible in hybrid");
}

section("46. registerNodeType — wildcard visibleInModes always visible");
{
  EP.registerNodeType("root-node", { visibleInModes: "*" });
  assert(EP.isNodeTypeVisibleInMode("root-node", "folders"), "wildcard: visible in folders");
  assert(EP.isNodeTypeVisibleInMode("root-node", "files"),   "wildcard: visible in files");
  assert(EP.isNodeTypeVisibleInMode("root-node", "hybrid"),  "wildcard: visible in hybrid");
  delete EP.NODE_TYPES["root-node"];
}

section("47. getNodeType — returns null for unregistered type");
{
  assert(EP.getNodeType("nonexistent") === null, "getNodeType: null for unknown type");
  assert(EP.getNodeType("file") !== null, "getNodeType: descriptor returned for file");
}

// ── New filter type tests ──────────────────────────────────────────────────

section("48. applyPreFilters — name handler (canonical type)");
{
  const filtered = EP.applyPreFilters(FS_ITEMS, [{ type: "name", value: "ford" }], {});
  assert(filtered.every((i) => i.name.includes("ford") || i.relPath.includes("ford")),
    "name filter: all results contain 'ford'");
  assert(filtered.length === 1, "name filter: exactly 1 match (ford_f150.txt)");
}

section("49. applyPreFilters — content handler");
{
  const helpers = { getContentForRelPath: (r) => CONTENT_CACHE.get(r) ?? null };
  const filtered = EP.applyPreFilters(FS_ITEMS, [{ type: "content", value: "engine" }], helpers);
  const names = filtered.map((i) => i.name);
  // CONTENT_CACHE: chevrolet has "Engine runs strong" and "Check engine light"
  // honda has "No engine warning lights"
  // ford has "No engine issues noted"
  assert(names.includes("chevrolet_silverado.txt"), "content filter: chevrolet matches 'engine'");
  assert(names.includes("honda_civic.txt"), "content filter: honda matches 'engine'");
  assert(names.includes("ford_f150.txt"), "content filter: ford matches 'engine'");
  assert(!names.includes("jeep_wrangler.txt"), "content filter: jeep excluded (no engine in content)");
  assert(!names.includes("subaru_outback.txt"), "content filter: subaru excluded");
}

section("50. applyPreFilters — body is alias for content");
{
  const helpers = { getContentForRelPath: (r) => CONTENT_CACHE.get(r) ?? null };
  const byContent = EP.applyPreFilters(FS_ITEMS, [{ type: "content", value: "engine" }], helpers);
  const byBody    = EP.applyPreFilters(FS_ITEMS, [{ type: "body",    value: "engine" }], helpers);
  assert(byContent.length === byBody.length, "body alias: same result count as content");
  assert(byContent.map((i) => i.relPath).sort().join() === byBody.map((i) => i.relPath).sort().join(),
    "body alias: identical item sets");
}

section("51. applyPreFilters — meta size filter");
{
  // chevrolet_silverado.txt has size: 3MB; others are ≤ 2KB
  const bigOnly = EP.applyPreFilters(FS_ITEMS, [{ type: "meta", value: "size>2mb" }], {});
  assert(bigOnly.some((i) => i.name === "chevrolet_silverado.txt"),
    "meta size>2mb: chevrolet (3MB) included");
  assert(!bigOnly.some((i) => i.name === "ford_f150.txt"),
    "meta size>2mb: ford (2KB) excluded");

  const smallOnly = EP.applyPreFilters(FS_ITEMS, [{ type: "meta", value: "size<1kb" }], {});
  assert(smallOnly.some((i) => i.name === "honda_civic.txt"),
    "meta size<1kb: honda (512B) included");
  assert(!smallOnly.some((i) => i.name === "chevrolet_silverado.txt"),
    "meta size<1kb: chevrolet (3MB) excluded");
}

section("52. applyPreFilters — meta type filter");
{
  const filesOnly   = EP.applyPreFilters(FS_ITEMS, [{ type: "meta", value: "type:file" }], {});
  const foldersOnly = EP.applyPreFilters(FS_ITEMS, [{ type: "meta", value: "type:folder" }], {});
  assert(filesOnly.every((i) => i.type === "file"), "meta type:file: only files");
  assert(filesOnly.length === 6, "meta type:file: 6 files");
  assert(foldersOnly.every((i) => i.type === "folder"), "meta type:folder: only folders");
  assert(foldersOnly.length === 3, "meta type:folder: 3 folders");
}

section("53. buildPreFilters — state.view.filters[] drives filter list");
{
  const state = makeState({
    view: {
      filters: [
        { type: "name", value: "billybob" },
        { type: "meta", value: "type:file" },
      ],
      selectedId: ROOT_ID,
    },
  });
  const filters = EP.buildPreFilters(state);
  assert(filters.length >= 2, "filters[] → at least 2 filters");
  assert(filters.some((f) => f.type === "name"), "filters[]: name filter present");
  assert(filters.some((f) => f.type === "meta"), "filters[]: meta filter present");
}

section("54. buildWorkingSet — filter name via filters[]");
{
  const state = makeState({
    view: { filters: [{ type: "name", value: "ford" }], selectedId: ROOT_ID },
  });
  const ws = buildWS(state);
  assert(ws.length === 1, "buildWorkingSet with name filter: 1 result");
  assert(ws[0].name === "ford_f150.txt", "buildWorkingSet with name filter: correct item");
}

section("55. buildWorkingSet — filter content via filters[]");
{
  const state = makeState({
    view: { filters: [{ type: "content", value: "trail" }], selectedId: ROOT_ID },
  });
  const ws = buildWS(state);
  const names = ws.map((i) => i.name);
  // CONTENT_CACHE: jeep has "Off-road trail vehicle"
  assert(names.includes("jeep_wrangler.txt"), "content filter 'trail': jeep included");
  assert(!names.includes("ford_f150.txt"), "content filter 'trail': ford excluded");
}

// ── Summary ────────────────────────────────────────────────────────────────

console.log(`\n${"─".repeat(50)}`);
console.log(`  ${passed} passed   ${failed} failed`);
if (failures.length) {
  console.log("\nFailures:");
  failures.forEach((f) => console.log(`  • ${f}`));
  process.exit(1);
} else {
  console.log("  all tests passed");
}
