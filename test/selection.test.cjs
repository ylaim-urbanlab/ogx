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
  { name: "billybob",            relPath: "billybob",                          type: "folder", fullPath: "/r/billybob" },
  { name: "jeep_wrangler.txt",   relPath: "billybob/jeep_wrangler.txt",        type: "file",   fullPath: "/r/billybob/jeep_wrangler.txt" },
  { name: "ford_f150.txt",       relPath: "billybob/ford_f150.txt",            type: "file",   fullPath: "/r/billybob/ford_f150.txt" },
  { name: "chevrolet_silverado.txt", relPath: "billybob/chevrolet_silverado.txt", type: "file", fullPath: "/r/billybob/chevrolet_silverado.txt" },
  { name: "henry",               relPath: "henry",                             type: "folder", fullPath: "/r/henry" },
  { name: "honda_civic.txt",     relPath: "henry/honda_civic.txt",             type: "file",   fullPath: "/r/henry/honda_civic.txt" },
  { name: "marshall",            relPath: "marshall",                          type: "folder", fullPath: "/r/marshall" },
  { name: "subaru_outback.txt",  relPath: "marshall/subaru_outback.txt",       type: "file",   fullPath: "/r/marshall/subaru_outback.txt" },
  { name: "toyota_rav4.txt",     relPath: "marshall/toyota_rav4.txt",          type: "file",   fullPath: "/r/marshall/toyota_rav4.txt" },
];

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

// Simulate getWorkspaceRowsForDisplay (file-only, reader filter, pipeline result filter)
function getWorkspaceRows(state, tagsByPath = {}, pipelineMatchByRel = new Map()) {
  let rows = getWorkingSetItems(state, tagsByPath).filter((i) => i.type === "file");
  const f = (state.workspace.filterText || "").trim().toLowerCase();
  if (f) rows = rows.filter((i) => i.name.toLowerCase().includes(f) || i.relPath.toLowerCase().includes(f));

  const pf = state.workspace.pipelineResultFilter;
  const pipeActive = state.cardRender && state.cardRender.pipeline && state.cardRender.pipeline.length > 0;
  if (pf && pipeActive) {
    rows = rows.filter((i) => {
      const k = normRel(i.relPath);
      if (!pipelineMatchByRel.has(k)) return true;
      const hit = pipelineMatchByRel.get(k);
      return pf === "matched" ? hit : !hit;
    });
  }
  return rows;
}

function makeState(overrides = {}) {
  return {
    view: {
      searchText: "",
      tagFilter: "",
      selectedId: ROOT_ID,
      mode: "folders",
      ...((overrides.view) || {}),
    },
    extSelection: null,
    wsExpansion: null,
    workspace: {
      filterText: "",
      pipelineResultFilter: null,
      ...((overrides.workspace) || {}),
    },
    cardRender: { pipeline: [] },
    ...overrides,
    view: { searchText: "", tagFilter: "", selectedId: ROOT_ID, mode: "folders", ...((overrides.view) || {}) },
    workspace: { filterText: "", pipelineResultFilter: null, ...((overrides.workspace) || {}) },
    cardRender: overrides.cardRender || { pipeline: [] },
  };
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

section("11. Pipeline result filter — matched");
{
  const state = makeState({
    cardRender: { pipeline: [{ op: "grep", pattern: "ford" }] },
    workspace: { filterText: "", pipelineResultFilter: "matched" },
  });
  // Simulate: ford_f150 matched, others did not
  const pipelineMatchByRel = new Map([
    ["billybob/ford_f150.txt", true],
    ["billybob/jeep_wrangler.txt", false],
    ["billybob/chevrolet_silverado.txt", false],
    ["henry/honda_civic.txt", false],
    ["marshall/subaru_outback.txt", false],
    ["marshall/toyota_rav4.txt", false],
  ]);
  const rows = getWorkspaceRows(state, {}, pipelineMatchByRel);
  const names = rows.map((i) => i.name);
  assert(names.includes("ford_f150.txt"), "matched filter: ford present");
  assert(!names.includes("honda_civic.txt"), "matched filter: honda excluded");
  assert(rows.length === 1, "matched filter: exactly 1 row");
}

section("12. Pipeline result filter — empty (inverse)");
{
  const state = makeState({
    cardRender: { pipeline: [{ op: "grep", pattern: "ford" }] },
    workspace: { filterText: "", pipelineResultFilter: "empty" },
  });
  const pipelineMatchByRel = new Map([
    ["billybob/ford_f150.txt", true],
    ["billybob/jeep_wrangler.txt", false],
    ["billybob/chevrolet_silverado.txt", false],
    ["henry/honda_civic.txt", false],
    ["marshall/subaru_outback.txt", false],
    ["marshall/toyota_rav4.txt", false],
  ]);
  const rows = getWorkspaceRows(state, {}, pipelineMatchByRel);
  const names = rows.map((i) => i.name);
  assert(!names.includes("ford_f150.txt"), "empty filter: ford excluded (it matched)");
  assert(names.includes("honda_civic.txt"), "empty filter: honda present (did not match)");
  assert(rows.length === 5, "empty filter: 5 rows (the non-matchers)");
}

section("13. Pipeline result filter — all (off)");
{
  const state = makeState({
    cardRender: { pipeline: [{ op: "grep", pattern: "ford" }] },
    workspace: { filterText: "", pipelineResultFilter: null },
  });
  const pipelineMatchByRel = new Map([
    ["billybob/ford_f150.txt", true],
    ["billybob/jeep_wrangler.txt", false],
  ]);
  const rows = getWorkspaceRows(state, {}, pipelineMatchByRel);
  assert(rows.length === 6, "pipelineResultFilter=null: all 6 files shown");
}

section("14. Tag + pipeline result filter composing (the reported bug case)");
{
  // User has render grep 'Condition: Very' → matched, then wants to tag those files
  // The visible reader rows should be the matched subset; tag should apply to those
  const state = makeState({
    cardRender: { pipeline: [{ op: "grep", pattern: "Condition: Very" }] },
    workspace: { filterText: "", pipelineResultFilter: "matched" },
  });
  const pipelineMatchByRel = new Map([
    ["henry/honda_civic.txt", true],
    ["marshall/subaru_outback.txt", true],
    ["billybob/ford_f150.txt", false],
    ["billybob/jeep_wrangler.txt", false],
    ["billybob/chevrolet_silverado.txt", false],
    ["marshall/toyota_rav4.txt", false],
  ]);
  const visibleRows = getWorkspaceRows(state, {}, pipelineMatchByRel);
  assert(visibleRows.length === 2, "visible reader rows = 2 (matched)");
  const names = visibleRows.map((i) => i.name);
  assert(names.includes("honda_civic.txt"), "honda_civic visible");
  assert(names.includes("subaru_outback.txt"), "subaru_outback visible");

  // Simulate: tag "condition:verygood" applied to visibleRows (what the fixed tag command now does)
  const tagsByPath = {};
  for (const item of visibleRows) {
    const ex = new Set((tagsByPath[item.relPath] || []));
    ex.add("condition:verygood");
    tagsByPath[item.relPath] = [...ex];
  }
  assert(tagsByPath["henry/honda_civic.txt"] !== undefined, "honda tagged");
  assert(tagsByPath["marshall/subaru_outback.txt"] !== undefined, "subaru tagged");
  assert(tagsByPath["billybob/ford_f150.txt"] === undefined, "ford NOT tagged (not visible)");
  assert(tagsByPath["marshall/toyota_rav4.txt"] === undefined, "toyota NOT tagged");
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

// Shared helpers for buildWorkingSet
const PIPELINE_HELPERS = {
  ROOT_ID,
  normRel,
  parentRelPath,
  itemIdFromRelPath,
  findItemByRelPath,
  findItemById: findItemByRelPath,
  getTagsForId: (relPath) => TAGS[relPath] || [],
  getGraphNeighborIds: (id) => getNeighborIds(id, GRAPH_LINKS),
};

const TAGS = {};

function buildWS(state, tagsOverride) {
  const helpers = tagsOverride
    ? { ...PIPELINE_HELPERS, getTagsForId: (r) => tagsOverride[r] || [] }
    : PIPELINE_HELPERS;
  const set = EP.buildWorkingSet(FS_ITEMS, state, helpers);
  return FS_ITEMS.filter((i) => set.has(i.relPath));
}

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

section("26. buildPreFilters — derives from state");
{
  const state = makeState({
    view: { searchText: "ford", tagFilter: "", selectedId: ROOT_ID },
    extSelection: { ext: "txt", folderIds: new Set() },
  });
  const filters = EP.buildPreFilters(state);
  assert(filters.some((f) => f.type === "text" && f.value === "ford"), "buildPreFilters: text filter present");
  assert(filters.some((f) => f.type === "ext" && f.value === "txt"), "buildPreFilters: ext filter present");
  assert(filters.length === 2, "buildPreFilters: exactly 2 filters (text + ext)");
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
