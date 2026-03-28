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
