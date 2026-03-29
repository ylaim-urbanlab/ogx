# Data Model

> Schemas for the index, view item, and Markdown edge format.
> See architecture.md for how these layers relate.

---

## Node Types

| Type | Virtual | Has Content | Source |
|---|---|---|---|
| `file` | no | yes | filesystem |
| `folder` | no | no | filesystem |
| `paper` | no | yes | filesystem + index |
| `concept` | yes | no | index / markdown |

Node type registry drives: visibility defaults, card renderer, filter participation.

---

## Index Objects

### Paper

```json
{
  "id": "baum-snow-2007",
  "type": "paper",
  "source": "papers/baum-snow-2007.md",
  "title": "Did Highways Cause Suburbanization?",
  "authors": ["Nathaniel Baum-Snow"],
  "year": 2007,
  "summary": "...",
  "sections": ["intro", "highway_system", "empirical_strategy", "results"]
}
```

### Section (nested in paper)

```json
{
  "id": "baum-snow-2007#highway_system",
  "type": "section",
  "paper_id": "baum-snow-2007",
  "title": "The Interstate Highway System",
  "pages": [5, 9],
  "summary": "Uses planned 1947 highway network as exogenous instrument."
}
```

### Chunk (in `.ogx-chunks/<paper-id>.json`)

```json
{
  "id": "baum-snow-2007#highway_system:p5:c2",
  "type": "chunk",
  "paper_id": "baum-snow-2007",
  "section_id": "baum-snow-2007#highway_system",
  "page": 5,
  "char_range": [1200, 1490],
  "text": "I instrument for the total number of highways built with the number of highways in a 1947 national interstate highway plan"
}
```

Vector DB key = chunk `id`. No secondary key mapping.

### Concept (in `.ogx-concepts.json`)

```json
{
  "id": "METHOD:IV",
  "type": "concept",
  "label": "Instrumental Variables",
  "description": "Causal inference method using exogenous variation to identify treatment effects.",
  "exemplars": ["baum-snow-2007#highway_system:p5:c2"]
}
```

Filename on disk: `concepts/method--iv.md` (colons illegal on Windows).
Canonical ID comes from frontmatter `id:` field, not the filename.

### Edge (in `.ogx-edges.json`)

```json
{
  "id": "edge_001",
  "from": "baum-snow-2007",
  "to": "METHOD:IV",
  "type": "uses",
  "status": "accepted",
  "source": "llm+embedding",
  "confidence": 0.92,
  "reviewed_by": "user",
  "created": "2026-03-29T00:00:00Z",
  "evidence": [
    {
      "chunk_id": "baum-snow-2007#highway_system:p5:c2",
      "text": "I instrument for the total number of highways..."
    }
  ]
}
```

Edge status: `accepted` | `pending` | `rejected`
Edge source: `markdown` | `llm+embedding` | `user`

---

## Edge Type Vocabulary

| Type | Meaning |
|---|---|
| `uses` | applies this method/tool |
| `studies` | investigates this topic |
| `extends` | builds on prior work |
| `compares` | benchmarks against |
| `contradicts` | challenges a claim |
| `evaluates-on` | tests on this dataset |
| `related` | untyped association |

Normalized to lowercase internally. Flexible in Markdown.

---

## Compiled Index (`ogx-index.json`)

Single derived file. Never hand-edited.

```json
{
  "compiled_at": "2026-03-29T02:00:00Z",
  "source_hashes": {
    "papers/baum-snow-2007.md": "a3f1...",
    "concepts/method--iv.md": "b2c4..."
  },
  "nodes": {
    "baum-snow-2007": { "type": "paper", ... },
    "METHOD:IV": { "type": "concept", ... }
  },
  "edges": [ ... ]
}
```

Freshness check on startup: compare `compiled_at` against source file mtimes.
If stale: prompt user to recompile. Never silently operate on stale data.

---

## View Item (ephemeral, assembled by `buildViewItems()`)

```js
{
  // identity — always present
  id:      "baum-snow-2007",
  type:    "paper",
  relPath: "papers/baum-snow-2007.md",

  // lightweight layer — always available
  name:          "baum-snow-2007.md",
  preview:       "first 2 lines...",
  tags:          ["chem:process"],
  pipelineResult: "...",

  // research layer — present only if index loaded
  title:    "Did Highways Cause Suburbanization?",
  summary:  "Highways caused significant decentralization...",
  concepts: ["METHOD:IV", "TOPIC:SUBURBANIZATION"],
  year:     2007,

  // ephemeral LLM — present only if generated this session
  llmSummary: "...",

  // provenance
  sources: ["filesystem", "research", "llm-cache"]
}
```

Card renderer receives a view item and uses whatever fields are present.
Graceful degradation is built into the shape, not the renderer.

---

## Markdown Edge Authoring

Authored edges in paper markdown files:

```markdown
## Links

### Uses
- [[METHOD:IV]]
- [[DATA:US_CENSUS_1950_1990]]

### Studies
- [[TOPIC:SUBURBANIZATION]]

### Related
- [[paper:duranton-turner-2012]]
```

LLM-suggested edges (pending review):

```markdown
## Suggested Links (LLM — pending review)

### Uses
- [[METHOD:IV]]  (confidence: 0.92)
```

**Ownership rule**: each file owns its outgoing edges only.
Incoming edges are derived at compile time. "Cited By" sections are display hints only.

---

## File Layout (project root)

```
papers/
  baum-snow-2007.md
concepts/
  method--iv.md            (frontmatter id: METHOD:IV)
  topic--suburbanization.md

.ogx-index.json            compiled graph (nodes + edges)
.ogx-chunks/
  baum-snow-2007.json      chunk objects (text, position, heading path)
.ogx-vectors/              LanceDB files — fully disposable
.ogx-tags.json             user tags
.ogx-edges.json            accepted + pending edges with evidence
.ogx-ingest.log            ingest run log
```
