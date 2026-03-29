# System Architecture Summary (Vanilla + Research Modes)

## Core Pipeline

Both modes share the same high-level architecture:

```text
files → index → view → UI
```

* **Files (source of truth)**
  Markdown (or raw files in vanilla) define all durable content.

* **Index (persistent, derived)**
  Stores reusable, structured, expensive-to-compute artifacts.

* **View (ephemeral)**
  Built per interaction. Combines index + state + optional LLM output.

* **UI**
  Renders view items. Dispatches by node type.

---

## Key Design Principle

> Same pipeline, different index semantics.

---

## Index Layer (Three Modes in Practice)

### 1. Vanilla Mode (Incremental / Opportunistic)

* Starts sparse, grows over time
* May be incomplete or stale
* Safe to delete/rebuild
* Examples:
  * tags
  * saved cards
  * lightweight cached summaries

### 2. Research Mode (Compiled / Authoritative)

* Built via ingest (PDF → markdown → processing)
* Intended to be complete and internally consistent
* Structured for semantic operations
* Examples:
  * paper summaries
  * section summaries
  * chunks
  * embeddings
  * concepts
  * edges with evidence

### 3. Partial Research Mode (Real-world default)

* Index exists but is incomplete
* Some files are fully processed, others are not
* System must remain fully usable

#### Rule:

> The index is always a valid partial view.

* Missing data falls back to lightweight behavior
* UI does not break
* System may surface missing enrichment (e.g. "not yet processed")

---

## What Goes Into the Index

### Store in Index (Persistent, Reusable)

Criteria:
* expensive to compute
* stable across sessions
* describes the file (not the query)

Examples:
* LLM paper/section summaries
* embeddings (vector DB)
* chunk structure
* extracted figures / thumbnails
* accepted edges / relationships

### Do NOT Store in Index (Ephemeral)

Criteria:
* tied to current interaction
* depends on filters or user state
* not canonical

Examples:
* "summarize current selection"
* comparisons between selected items
* temporary LLM outputs
* regex matches / previews

---

## View Layer

The view layer builds renderable objects from:
* files
* index (if present)
* UI state
* optional ephemeral LLM results

### Characteristics:
* recomputed frequently
* fast
* disposable
* scoped to current working set

---

## On-the-fly LLM Usage

Allowed in the view layer for small working sets:
* async and non-blocking
* cached in memory (session-level)
* never written to index automatically

### Promotion Rule

Ephemeral → persistent only via explicit user action:

```text
summary accept <id>
```

This:
* writes to markdown (preferred)
* triggers index refresh

---

## Data Flow

```text
FILES (markdown, PDFs → markdown)
   ↓
INDEX (incremental / partial / compiled)
   ↓
VIEW BUILDER (merges index + state + ephemeral)
   ↓
VIEW ITEMS
   ↓
UI
```

---

## UI vs Command Surface

### UI (Renderer)
* Mode-agnostic
* Operates only on view items
* Dispatches by node type

### CLI / Commands
* Mode-aware
* Depends on available index features

Example:
```text
concept create METHOD
→ "research index not loaded. run: ogx ingest --init"
```

Commands should:
* check capabilities
* fail gracefully
* guide user to next step

---

## Key Rules

1. **Files are always the source of truth**
2. **Index is a compiled artifact, not user-edited**
3. **Index may be partial and must degrade gracefully**
4. **View is ephemeral and interaction-driven**
5. **UI is mode-agnostic; commands are mode-aware**
6. **Expensive work is stored only if reusable and stable**
7. **User must explicitly promote machine-generated content**

---

## Mental Model

```text
Index = knowledge about the corpus
View  = current line of thinking
```

---

## Outcome

This architecture enables:
* identical UI across modes
* graceful transition from vanilla → research
* partial ingestion without breakage
* fast interaction (view layer)
* rich semantics (index layer)
* safe LLM usage without polluting core data
* full rebuildability from files
