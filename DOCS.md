# OpenGraphXplorer — Command Reference & Testing Guide

## Quick orientation

OpenGraphXplorer loads a folder and shows it as a **force-directed graph** (left) + a **reader deck** (right). The graph reflects folder/file structure. The reader deck is your *working set* — the files you're actively looking at. Everything flows through the CLI at the bottom.

The two sides are loosely coupled:
- Graph selection + filters control what enters the reader
- Reader has its own filter/sort on top of that
- `graph link` adds non-tree connections that pull related nodes together

---

## Quick reset

```
reset    → clear all filters, expansion, pipeline, selection — back to default folders view
```

---

## Loading a folder

| Action | How |
|---|---|
| Pick a folder | Click **Pick root** button |
| Use built-in test data | Click **Use testenv** |
| Navigate from CLI | `cd /absolute/path` or `cd relative/path` |
| Reload from disk | `refresh` |

```
pwd           → show current root
ls            → list first 30 items
summary       → count of files under root
summary types → file counts by extension
```

> **Large repos:** if the folder has >20,000 items a warning appears and the cap is applied. The physics loop only runs repulsion on visible nodes so large trees stay responsive.

---

## Graph basics

**Modes** — controls which node types are visible:
```
mode folders   → only folder nodes (default)
mode files     → only file nodes
mode hybrid    → both
```

**Filters** — narrows which nodes appear:
```
filter report           → nodes whose name/path contains "report"
filter                  → clear (no argument = reset)
tagfilter todo          → nodes tagged with "todo"
tagfilter               → clear
sort name-asc           → sort: name-asc | name-desc | type-asc | type-desc
```

**Labels on nodes:**
```
label count             → show file count on folder nodes
label type              → show type breakdown
label count,type        → both
label off               → remove labels
```

**Navigation:**
```
select <relPath>        → select a node (tab-complete isn't available; use ls to find paths)
select clear            → deselect / reset to root
back                    → undo last state change  (key 4 when CLI focused)
forward                 → redo                    (key 6)
```

---

## Working set & reader deck

The reader deck shows files from your **working set**. The working set is derived from:

1. Graph filters (search, tag)
2. Extension selection (narrows to one file type)
3. Working set expansion (adds relatives of a selected node)

```
select ext md           → reader shows only .md files; graph highlights their parent folders
select ext json
select ext              → clear extension filter

expand children         → add children of selected node to working set
expand parents          → add ancestors
expand siblings         → add siblings (same parent)
expand +1               → add graph neighbours (hop-1)
expand clear            → reset expansion

reader filter report    → substring filter inside the deck (stacks on top of working set)
reader filter           → clear
reader sort name-asc    → sort inside deck: manual | name-asc | name-desc | type-asc | type-desc
```

**Inspect the working set:**
```
ws                      → list working set items (up to 80)
explain                 → show full state: mode, filters, pipeline, expansion
reader paths            → list reader file paths (first 50)
reader paths 200        → up to 200
```

---

## Tagging

Tags are stored in `.ogx-tags.json` at the root. Active tags appear as clickable chips at the top of the reader panel — click one to filter by it.

```
tag urgent              → add tag to selected graph node
tag clear               → remove all tags on selected node
tag list                → show current tags on selected node

tag set urgent, review  → replace all tags (explicit set)
tag add done            → add without replacing (kept for compat)

select tag urgent       → filter graph + reader to nodes tagged "urgent"
tagfilter urgent        → same as above (lower-level alias)
tagfilter               → clear tag filter

tag todo where grep TODO          → tag all reader files containing "TODO" with "todo"
tag wip where grep "work in prog" → same but with a phrase

reader tag add todo     → bulk-tag all files currently in the reader deck
save tags               → persist tags to disk
```

Tag chips appear at the top of the reader panel. Click to toggle filter. Active chip is highlighted.

---

## Render pipeline

`render` is a shorthand for `card render` — use either form.



Applies a text transformation pipeline to file previews in the reader deck.

**Operations** (pipe-separated):
- `head <n>` — first N lines
- `grep <pattern>` — keep lines matching pattern (regex, case-insensitive)
- `regex <pattern>` — strict regex (empty result if invalid)
- `col <n1>,<n2>` — extract CSV/TSV columns (1-indexed)

```
render head 5                    → first 5 lines of every card
render grep TODO                 → lines containing TODO
render head 20 | grep error      → first 20 lines, then grep for "error"
render grep import | head 10     → import lines, first 10
render col 1,3                   → columns 1 and 3 (for CSV files)
render reset                     → clear pipeline

render grep TODO | matched       → pipeline + immediately filter reader to matches
render grep error | empty        → show cards where grep found nothing

reader matched                   → filter reader to pipeline matches (after render runs)
reader empty                     → show cards where pipeline was empty
reader all                       → show all cards

render save my-pipeline          → save pipeline by name
render load my-pipeline
render list
render delete my-pipeline
```

> **Scoping:** if a file card is selected in the reader deck, pipeline applies only to that file. Otherwise it runs on all cards.

> **Card ↗ button:** click the arrow icon on any card to open that file in a browse tab.

---

## Named graph views

Save and load named snapshots of the current graph (extra links + mode + filters):

```
graph new semantic       → start a fresh named graph (clears extra links)
graph link ext           → build edges (any link command)
graph save semantic      → save current extra links + view as "semantic"
graph load semantic      → restore a saved graph view
graph list               → list all saved graphs
graph delete semantic    → delete a saved graph
```

Each named graph stores: extra links, mode, searchText, tagFilter. Loading it restores all of these.

---

## `graph link` — finding non-tree connections

This is the build-graph feature. It discovers relationships between files *beyond folder structure* and adds them as **extra links** — dashed colored lines that pull related nodes together in the physics simulation.

Links are **additive** and **scoped to your current reader deck**. The workflow is:
1. Narrow the working set to what you care about (filter, select ext, expand…)
2. Run a `graph link` command to interrogate those files
3. Watch the graph self-organise around the discovered connections
4. Add more link kinds; they compose

```
graph link list         → show active link kinds and counts
graph link clear        → remove all extra links
```

### Layer 1 — structural (instant, reads metadata only)

| Command | What it does | Color |
|---|---|---|
| `graph link ext` | Links files of the same extension together | green dashed |
| `graph link tags` | Links files that share a tag | purple dashed |
| `graph link name <pat>` | Links files whose name contains the pattern | yellow dashed |

### Layer 2 — content (reads first 32 KB per file)

| Command | What it does | Color |
|---|---|---|
| `graph link grep <pattern>` | Clusters all files matching a regex | orange dashed |
| `graph link imports` | Groups files sharing an import/require/from path (JS/TS/Py/Go) | blue dashed |
| `graph link refs` | Links markdown files that `[[wikilink]]` or `[text](path)` each other | teal dashed |

**Link topology:** hub-and-spoke within each group (first file links to up to 5 others, rest form a chain). This keeps the graph readable even with hundreds of files per group.

---

## Presets & bookmarks

```
preset save <name>      → snapshot full UI state (filters, mode, selection, pipeline)
preset load <name>
preset list
preset delete <name>

ws save <name>          → bookmark working-set state only
ws load <name>
ws list
ws delete <name>
ws clear                → reset expansion
```

---

## Browse tabs

```
open <relPath>              → open file or folder in an in-app tab
open dir <relPath>          → open folder in detail layout
open dir <relPath> --grid   → open folder in grid layout
```

---

## Settings

```
settings                           → show current values
settings head 6                    → preview head lines (0–200)
settings tail 4                    → preview tail lines
settings gravity 0.00022           → graph gravity (0–0.01)
settings repulsion 0.078           → node repulsion (0–0.5)
settings link 0.00085              → link spring strength (0–0.01)
settings damping 0.94              → velocity damping (0.5–0.999)
settings logfade 9000              → CLI log fade time in ms
settings mdsections Abstract,Notes → markdown sections to extract in previews
settings selectionhud top|bottom   → position of the selection HUD
settings cliinput top|bottom       → position of the CLI input bar
```

---

## Keyboard shortcuts

| Key | When CLI is focused | Description |
|---|---|---|
| `↑ / ↓` | CLI focused | Navigate command history |
| `4` | CLI focused | Back (undo) |
| `6` | CLI focused | Forward (redo) |
| `1` | CLI focused | Previous tab |
| `3` | CLI focused | Next tab |
| Scroll | Canvas | Zoom |
| Drag canvas | Canvas | Pan |
| Drag node | Canvas | Move node |
| Right-click node | Canvas | Pin / unpin (physics) |
| `↗` on card | Reader | Open file in browse tab |

---

## Testing walkthrough

### 1. Baseline — load and explore

```
# Load the built-in testenv
# Click "Use testenv"

ls
summary types
mode hybrid
label count
```

Expected: 3 folder nodes (billybob, henry, marshall) + their .txt files. Labels show file counts.

---

### 2. Filters and working set

```
filter ford
explain
reader paths
```

Expected: only the ford node visible; reader deck shows ford file.

```
filter
select ext txt
explain
```

Expected: reader shows all 6 .txt files. Graph highlights the 3 parent folders.

```
select ext
```

---

### 3. Expansion

```
select billybob
expand children
ws
```

Expected: working set = billybob's 3 children (jeep, ford, chevrolet).

```
expand siblings
ws
```

Expected: working set = billybob + its siblings (henry, marshall) = 3 folders.

```
expand clear
```

---

### 4. Card render pipeline

```
select ext txt
card render head 2
```

Expected: all reader cards show only first 2 lines of each file.

```
card render grep jeep
reader matched
```

Expected: only the jeep card is shown (it matched the grep); others hidden.

```
reader all
card render reset
select ext
```

---

### 5. Tagging

```
mode hybrid
select billybob/jeep_wrangler.txt
tag set offroad, suv
select billybob/ford_f150.txt
tag set truck, workhorse
select billybob/chevrolet_silverado.txt
tag set truck, workhorse

tagfilter truck
explain
```

Expected: graph dims to show only tagged nodes. Reader shows the ford + chevrolet files.

```
tagfilter
save tags
```

---

### 6. graph link — structural

```
# Start clean
mode hybrid
filter
tagfilter
expand clear
select ext

# Link by extension
graph link ext
graph link list
```

Expected: green dashed lines connect .txt files to each other.

```
# Link by tags (need tags from step 5)
graph link tags
graph link list
```

Expected: purple dashed lines connect the two "truck" files.

```
# Link by name pattern
graph link name truck
graph link list
```

Expected: yellow dashed lines between ford_f150 and chevrolet_silverado (both have "truck" in tags but name link uses filename — try "ford" or "chevrolet" to get fewer matches).

```
graph link clear
graph link list
```

---

### 7. graph link — content (grep)

```
mode hybrid
select ext txt

# What's in these files?
card render head 3

# Link files that mention a shared keyword
# (check what words appear in the file previews, then use one)
card render reset

graph link grep ford
graph link list
```

Expected: files containing the word "ford" get orange dashed links between them.

```
graph link clear
```

---

### 8. Combining strategies

```
# Add multiple link kinds at once
graph link ext
graph link grep ford

graph link list
# Should show: ext: N, grep: M

# The graph physics will pull ext-connected nodes together (green)
# AND grep-connected nodes together (orange)
# Both forces act simultaneously
```

---

### 9. Presets & undo

```
# Set up a state
filter billybob
graph link ext

# Save it
preset save billybob-linked

# Change everything
filter henry
graph link clear

# Restore
preset load billybob-linked
explain
```

---

### 10. Reader save

```
select ext txt
reader paths
reader save list /tmp/ep-files.txt
```

Then check: `cat /tmp/ep-files.txt`

```
reader save copy exports
```

Expected: copies all reader files into a new `exports/` folder under root.

---

## Troubleshooting

| Symptom | Fix |
|---|---|
| Graph feels slow | `mode folders` — hides file nodes, far fewer visible nodes for physics |
| Reader is empty | `expand clear`, `select ext`, `filter` (clear all filters) |
| `graph link refs` finds nothing | Only works on `.md`/`.markdown`/`.mdx`/`.txt` files with wikilinks or relative markdown links |
| `graph link imports` finds nothing | Only scans `.js .mjs .cjs .jsx .ts .tsx .py .go` files |
| Item cap warning | Repo has >20k tracked items; use `filter` to narrow visible set |
