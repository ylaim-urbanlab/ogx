# Open Questions

> Design decisions not yet resolved. Remove entries as they are decided.

---

## Graph / Visualization

- **Concept node positions**: fully free (physics) or partially pinned (act as gravity anchors)?
  - Leaning toward: pinnable by default, user can unpin
- **Concept hierarchy in graph**: how to visually represent METHOD → METHOD:IV parent-child?
  - Options: smaller child nodes orbiting parent, collapsed by default, separate hierarchy panel
- **Edge weight → spring strength**: should high-confidence edges pull harder?
- **Cluster nodes**: are auto-discovered topic groups a fourth node type, or just concept nodes with a different origin?

---

## Index / Data Model

- **Section storage**: sections nested in `.ogx-papers.json` or separate file?
  - Leaning toward: nested (self-contained paper objects)
- **Embedding storage at scale**: inline in chunk JSON (simple) vs binary flat files in `.ogx-embeddings/` (scales)?
  - Threshold: switch to binary above ~500 papers
- **Concept description grounding**: should concepts have exemplar file snippets to anchor their embedding? (Recommended: yes)

---

## Ingest

- **PDF figure extraction**: defer unless explicitly requested
- **Corpus-level summary**: "what is this collection about?" — useful but when to generate?
- **Concept suggestion from clusters**: run after embeddings, propose concept labels to user
- **Zotero live sync**: watch for collection changes, run incremental ingest automatically?

---

## UI / Commands

- **`concept review` UX**: how does the user see pending edges and accept/reject?
  - Options: dedicated review panel, inline in card, CLI list + accept/reject commands
- **Stale index warning**: how prominent? Banner? CLI warning only?
- **`summary accept` file write**: does it go into frontmatter or a `## Summary` section?
  - Leaning toward: frontmatter `summary:` for machine-readability
- **Promotion of LLM summaries**: should there be a bulk-accept for high-confidence items?

---

## Core Refactor (vanilla → extensible)

- **Filter pipeline execution order**: confirmed (pre-filter → expansion → post-filter), but needs test coverage before refactor
- **`buildGraph()` graph sources**: what is the minimal interface a source must implement?
  - Proposed: `{ id, getNodes(state), getLinks(state) }`
- **Card renderer dispatch**: where does the dispatch table live? `model.js` or `renderer.js`?
- **`model.js` / `renderer.js` split**: extract `buildGraph()` and filter pipeline to `model.js` first, physics and draw calls stay in `renderer.js`

---

## Product / Scope

- **Vanilla → research transition**: should be smooth (no reinstall, no new product). Trigger: presence of `.ogx-index.json`.
- **Multi-corpus**: can you have multiple research projects open? Or one root at a time? (Current OGX: one root at a time — keep for now)
- **Collaboration**: git-based (files + index are all text). No additional sync needed.
