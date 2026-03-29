# OpenGraphXplorer

A local-first desktop tool for exploring folders as **interactive force-directed graphs**.

Load a folder. Watch it become a graph. Filter, link, tag, and query your files — without a mandatory database or background index.

Latest updates: [CHANGELOG.md](CHANGELOG.md)

---

## What it is

Most file explorers show you a tree. OpenGraphXplorer shows you a **graph that you can reshape** — pulling related files together by extension, shared tags, content patterns, or import chains. The layout emerges from what you're interested in, not just where the files happen to live.

The right panel is the **reader deck** — a working set of files showing live previews, pipeline-filtered text, CSV columns, and extracted PDF text. The left is the graph canvas. A CLI at the bottom drives everything.

No mandatory background indexing. No database server. Everything runs on-demand over the files you're looking at, with explicit saved indexes only when you ask for them.

---

## Quick start

```
pnpm install
pnpm start
```

Requires [Node.js](https://nodejs.org) and [pnpm](https://pnpm.io). Electron is installed as a dev dependency.

Click **Pick root** to open a folder, or **./testenv** to load the built-in sample data.

If Electron logs repeated Chromium GPU errors such as `Creation of StagingBuffer's SharedImage failed`, start in software-rendered mode instead:

```
pnpm start:safe
```

You can also force that mode with `OGX_DISABLE_GPU=1 pnpm start`, or re-enable hardware acceleration with `OGX_ENABLE_GPU=1`.

---

## Core concepts

### Graph

The graph starts as your folder/file hierarchy. Nodes are files and folders; edges are parent–child links. Physics simulation keeps it tidy and interactive — drag nodes, zoom, pan, right-click to pin.

```
mode folders        → show only folder nodes (default)
mode files          → show only file nodes
mode hybrid         → show both
filter report       → narrow graph to nodes matching "report"
reset               → clear everything back to defaults
```

### Working set & reader deck

The reader deck shows the **working set** — files derived from graph filters, selection, and expansion rules. It's always a live view of what passes through your current set of filters.

```
select ext md           → reader shows only .md files
expand children         → add children of selected node
expand siblings         → add siblings (same parent)
expand +1               → add graph-level neighbours (hop-1)
expand clear            → reset expansion
reader filter report    → substring filter inside the deck
```

### Graph links — finding non-tree connections

This is the key feature. Once you've narrowed to a working set, you can discover and draw **new links** between files based on structure or content. These links pull related nodes together in the physics simulation.

```
graph link ext          → link files of the same type (green dashed)
graph link tags         → link files sharing a tag (purple dashed)
graph link name <pat>   → link files whose name matches a pattern (yellow)
graph link grep <pat>   → scan file content, link files matching a regex (orange)
graph link imports      → link JS/TS/Py/Go files sharing an import path (blue)
graph link refs         → link markdown files that [[wikilink]] each other (teal)
graph link clear        → remove all extra links
graph link list         → show active link kinds and counts
```

Links are **additive** and **scoped to your reader deck**. Filter first, then interrogate — multiple strategies compose.

### Named graph views

```
graph new semantic      → start a fresh named graph
graph link grep TODO    → build edges
graph save semantic     → save extra links + view settings as "semantic"
graph load semantic     → restore a saved graph
graph list              → list all saved graphs
```

### Render pipeline

Apply text transformations to file previews in the reader:

```
render grep TODO               → keep lines containing TODO
render head 10 | grep error    → first 10 lines, then grep
render grep TODO | matched     → pipeline + filter reader to matches in one step
reader matched                 → filter reader to cards where pipeline matched
reader empty                   → show cards where pipeline produced nothing
render reset                   → clear pipeline
```

### Tagging

```
tag urgent                          → add tag to selected node
tag urgent where grep TODO          → tag all reader files matching a grep pattern
select tag urgent                   → filter graph + reader to tagged files
save tags                           → persist tags to .ogx-tags.json
```

Tags appear as clickable filter chips at the top of the reader panel.

### History & explain

```
history                 → show last 50 commands, copy to clipboard
explain                 → print the minimal command recipe that reproduces current state
```

Commands are also appended to `.ogx-history.log` in your root folder.

---

## All commands (quick reference)

| Category | Commands |
|---|---|
| Navigation | `cd`, `pwd`, `ls`, `refresh`, `reset` |
| Graph display | `mode folders\|files\|hybrid`, `filter`, `tagfilter`, `sort`, `label` |
| Selection | `select <path>`, `select ext <ext>`, `select tag <tag>`, `select siblings\|children\|visible`, `select clear` |
| Working set | `expand children\|parents\|siblings\|+1\|clear`, `ws`, `ws save\|load\|list\|delete` |
| Reader | `reader filter`, `reader sort`, `reader matched\|empty\|all`, `reader paths`, `reader tag add`, `reader save copy\|list` |
| Tags | `tag <name>`, `tag <name> where grep <pat>`, `tag clear\|list`, `save tags` |
| Render pipeline | `render <pipeline>`, `render reset`, `render save\|load\|list\|delete` |
| Graph links | `graph link ext\|tags\|name\|grep\|imports\|refs\|clear\|list` |
| Named graphs | `graph save\|load\|list\|delete\|new` |
| Presets | `preset save\|load\|list\|delete` |
| Browse tabs | `open <path>`, `open dir <path> [--grid]` |
| Introspection | `explain`, `history`, `summary`, `summary types` |
| Settings | `settings gravity\|repulsion\|link\|damping\|head\|tail\|logfade\|mdsections\|selectionhud\|cliinput` |

Full documentation: [DOCS.md](DOCS.md)

---

## Keyboard shortcuts (CLI focused)

| Key | Action |
|---|---|
| `↑ / ↓` | Command history |
| `4` | Back (undo) |
| `6` | Forward (redo) |
| `1` | Previous tab |
| `3` | Next tab |

`↗` button on any reader card opens that file in a browse tab.

---

## Data files

Stored alongside your files in the root folder:

| File | Contents |
|---|---|
| `.ogx-tags.json` | Tags per file path |
| `.ogx-concepts.json` | Concept nodes and typed edges |
| `.ogx-media-index.json` | Stored media/query representations |
| `.ogx-view-cards.json` | Saved view cards per folder |
| `.ogx-history.log` | Timestamped command log |

Named graphs and presets are stored in browser `localStorage` (per Electron app instance).

---

## Running tests

```
node test/pipeline-apply.test.cjs   # pipeline logic
node test/selection.test.cjs        # working set, selection, tag, filter composition (59 assertions)
```

---

## Architecture

```
main.js              Electron main process: filesystem walk, IPC handlers
preload.js           Context bridge → window.explorerApi
renderer/
  model.js           Pure logic: working set expansion, card render pipeline
  renderer.js        UI: graph physics, CLI parser, reader deck, state
  index.html         Layout
  styles.css         Dark glass theme
  browse-mount.js    In-app file/folder browse tabs
test/
  pipeline-apply.test.cjs
  selection.test.cjs
```

The renderer is a single self-contained page. No bundler, no framework. Physics loop runs in `requestAnimationFrame`. All file I/O is async through IPC. No background workers, no index, no cache.

---

## Status

Early prototype. The core loop — load → graph → filter → link → tag — works. Rough edges exist around large repos, binary file handling, and physics stability with many visible nodes. Contributions and issues welcome.

---

## License

ISC
