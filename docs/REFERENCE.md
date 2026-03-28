# OpenGraphXplorer — reference

This document summarizes **features**, the **mental model**, and **hands-on test flows** you can run against the bundled `testenv` tree.

---

## What it is

OpenGraphXplorer is a desktop app (Electron) for exploring a **folder root** as:

1. A **force-directed graph** of folders/files (with zoom, pan, drag).
2. A **Reader** panel listing **files** derived from a **working set** (filters + optional expansion).
3. A **CLI** on the graph canvas for commands, plus a **fading log** (top-left) and a **persistent selection history** (right panel).
4. **Browse tabs** (under the header): `open` adds an in-app tab for a file or folder (text/image preview, directory **detail** or **grid**). The Workspace tab is the graph + Reader; browse tabs can be closed with **×**.

There is **no global index**: previews and pipelines run over the current working set and selection, not a pre-built database.

---

## Architecture (where logic lives)

| Layer | Role |
|--------|------|
| **`main.js`** | Node/Electron main: folder pick, `load-data`, file reads, tags/cards JSON on disk, IPC handlers (previews, grep, CSV, markdown sections, path safety under root). |
| **`preload.js`** | Exposes `window.explorerApi` to the renderer (context-isolated bridge). |
| **`renderer/renderer.js`** | UI state, graph canvas, Reader deck, CLI parsing, undo/redo, presets, workspace bookmarks, settings in `localStorage`. |
| **`renderer/model.js` (`window.EP`)** | Pure helpers: **working set base** (e.g. extension filter), **workspace expansion** (children/parents/siblings/hop1), **card render pipeline** parse + apply (`grep` / `regex` / `head` / `col`). |
| **`renderer/index.html` + `styles.css`** | Layout: graph + resizable glass Reader, CLI bar, selection HUD + select history. |
| **`renderer/browse-mount.js`** | In-app browse tab UI (same views as the optional standalone `browse-tab.html` window). |

### On-disk data (under the chosen root)

- **`.ogx-tags.json`** — tags per file path (saved with `save tags`).
- **`.ogx-view-cards.json`** — saved “view cards” per folder (legacy card workflow).

User/chromium profile data is directed under the system temp path (see `main.js`) so the app avoids writing cache into synced folders.

---

## Mental model

### Graph vs Reader

- **Graph** visibility and sorting use **`filter` / `tagfilter` / `sort`** (CLI) against the full tree snapshot (`state.view.*`).
- **Reader** lists **files** from the **working set**, then applies **reader-only** substring filter and sort:
  - **`reader filter …` / `reader filter clear`**
  - **`reader sort manual|name-asc|…`**

So: graph search ≠ reader deck filter.

### Working set

1. Start from **graph-filtered** items (`getFilteredSortedItems()`).
2. Optionally restrict to one extension: **`select ext <ext>`** (e.g. `txt`).
3. Optionally **expand** with **`expand children|parents|siblings|+1|clear`**:
   - If a **non-root graph node is selected**, expansion is **seeded from that node** (children/parents/siblings of *that* item).
   - If **root** is selected, expansion seeds from the **full** extension-filtered base (previous “global” behavior).

Expanded results are **intersected** again with graph filters so invisible items do not appear.

### Card render (pipeline)

- **`card render <pipeline>`** applies a **pipe-separated** sequence of steps to each relevant file’s text for preview (see `model.js`).
- **Scope**: if **no** file is selected for render scope, pipeline applies to **all Reader files**; if a **Reader card / selection path** is active, pipeline applies **only to that file**.
- **`grep <pattern>`** uses a **RegExp** when valid; invalid pattern falls back to case-insensitive substring.
- **`regex <pattern>`** keeps **full lines** that match.
- **`reader matched` / `reader empty` / `reader all`** filter Reader rows by whether the pipeline produced non-empty output (after previews run).

### Undo / redo (CLI state)

- **`back`** / **`forward`** (and keys **`4`** / **`6`** when the CLI input is focused) walk stacks of snapshots.
- Snapshots include (among other fields): card render pipeline, selection paths, extension selection, pipeline result filter, expansion mode, graph `selectedId`, reader filter text, reader sort mode.
- **`pushCliUndo`** clears the **redo** stack (standard branch behavior).

### Logging vs selection history

- **Canvas log** (top-left): fades; shows `> command` echoes and messages.
- **Select history** (right panel): **does not fade**; append-only narrative of selection/expansion/reader/pipeline changes.

---

## Feature checklist

- Pick root / `./testenv` shortcut / refresh / `cd` / `pwd` / `ls`
- Graph: folders/files/hybrid **mode**, optional **labels**, **pin** (context menu), zoom/pan/drag
- Tags: **`tag set`**, **`tag add`** on selected node; **`save tags`**
- Reader: mirrors **working set**; **click card** sets **render scope**; **`cards clear`**
- CLI: **`filter`**, **`tagfilter`**, **`sort`** (graph); **`reader filter`**, **`reader sort`** (deck)
- **`select`**, **`select ext`**, **`select clear`**, **`expand`**
- **`card render`** (+ reset, save/load/list/delete)
- **`reader matched|empty|all`**
- **Presets** / **ws** workspace bookmarks
- **Settings** (log fade, graph physics, markdown sections, HUD position, CLI bar top/bottom, …)
- **explain** for a text summary of current state
- **`open`** / **`open dir`** — new browse window (see below)

### Browse tabs (`open`)

Tabs sit **below** the OpenGraphXplorer button row. **`Workspace`** is fixed; other tabs come from **`open`**.

- **`open <path>`** — Path under the current root (relative) or absolute (must still lie inside the root). Opens a **file** (text preview, image, or “open externally”) or a **folder** (detail table).
- **`open dir <path>`** — Force directory mode (error if the path is a file).
- **`open dir <path> --grid`** — Directory **image grid** (thumbnails for image files ≤ 2 MB; larger images show a placeholder tile; click to open). Non‑images listed under “Folders & files”.
- **`open dir <path> --detail`** — Explicit detail list (default).
- Flags may appear **before or after** the path (e.g. `open dir --grid billybob`).

Quotes: **`open "my folder/file.txt"`** supported.

CLI log (top-left on the graph): **hovering** over that text **pauses fading** until the pointer leaves the canvas log region.

Planned / mentioned for later: **bulk or dynamic tagging** from selection (e.g. static tag, size-derived, regex-derived).

---

## Walkthrough examples (manual QA)

Use **`Pick root`** or **`./testenv`** so the root contains **`billybob/`** (sample `.txt` files).

### 1. Graph + Reader baseline

1. Load `testenv`.
2. Run **`explain`** — note working set size, reader file count, expansion.
3. Run **`filter billy`** — graph narrows; Reader should only list files still in the working set under matching paths.
4. To **widen** the graph again, run **`filter <text>`** with a substring that matches the paths you want (there is no separate “clear graph filter” command), or **reload the root** / load a **preset** or **ws** bookmark that stored a wider view.
5. **`cards clear`** resets **reader-side** filters (ext, reader filter text, expansion), not the graph’s **`filter`** / **`tagfilter`**.

### 2. Extension selection + reader filter

1. **`select ext txt`**
2. **`reader filter jeep`**
3. Confirm Reader shows only `.txt` paths matching `jeep` (e.g. `jeep_wrangler.txt`).
4. **`reader filter clear`**
5. **`select clear`** (clears ext selection; confirm Reader follows graph again).

### 3. Expansion anchored on a graph node

1. Click a **folder** node in the graph (e.g. `billybob`).
2. **`expand children`**
3. Confirm working set / Reader includes items under that folder; check the right-hand **HUD** for `expand: children · anchor node: …`.
4. **`expand clear`**

### 4. Card render + grep / regex

With several `.txt` files visible in Reader:

1. **`card render grep "^#"`** or try a pattern that matches headings if present; for `jeep_wrangler.txt` style content try **`card render grep Vehicle`**.
2. **`reader matched`** — Reader lists only files where the pipelined preview is non-empty.
3. **`reader all`**
4. **`card render reset`**

Regex line filter example:

- **`card render regex "Service"`** — should keep lines containing `Service`.

### 5. Scoped render (one file)

1. Click a single **Reader card** so **render scope** is that file (see HUD: “Render scope”).
2. **`card render grep "."`** (or any pattern that matches lines in that file) — only the scoped card should use the pipeline chrome; others show default preview.
3. Choosing another graph node may **clear** deck selection (implementation detail); use another card click to re-scope. **`select clear`** clears **extension** selection and related reader state, not the same as “deselect card” — check HUD if unsure.

### 6. Undo / redo

1. Run **`select ext txt`**, then **`reader sort name-desc`**.
2. **`back`** — state should revert; **`forward`** should restore.
3. With CLI focused, **`4`** / **`6`** should match **`back`** / **`forward`** (note: **4** and **6** are not typed into the CLI; paste if needed).

### 7. Selection history

1. Perform several actions (graph clicks, **`expand`**, **`reader filter`**, **`card render`**).
2. Confirm the **select history** panel (above the HUD) accumulates **timestamped** lines and does **not** fade with the canvas log.

### 8. Presets / workspace bookmarks (smoke)

1. **`preset save demo`** after some filters; **`preset load demo`**.
2. **`ws save demo2`**; **`ws load demo2`**; **`ws list`**.

### 9. Browse tab (`open`)

1. With `testenv` loaded: **`open billybob/jeep_wrangler.txt`** — new tab with text preview; switch back via **Workspace**.
2. **`open billybob`** — detail listing; row clicks open **another** tab.
3. **`open dir billybob --grid`** — image grid when applicable.
4. Close browse tabs with **×**; nested navigation uses **Up** / layout toggles as before.

---

## Automated test

- **`pnpm test:pipeline`** — unit checks for pipeline `grep` / `regex` behavior aligned with `renderer/model.js`.

---

## Quick command index (from in-app `help`)

```
help, pwd, cd, ls, refresh, save tags
filter <text>, tagfilter <text>, sort <mode>
reader filter <text>|clear · reader sort <mode>
expand children|parents|siblings|+1|clear
select … | select ext … | select clear
tag set … | tag add …
reader matched | empty | all
back | forward   (keys 4 / 6 in CLI)
open <path> · open dir <path> [--grid|--detail]
card render … | reset | save|load|list|delete
preset … | ws …
settings …
mode … | label … | summary …
```

For the exact, up-to-date list, run **`help`** in the app.
