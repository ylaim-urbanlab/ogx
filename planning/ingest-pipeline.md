# Ingest Pipeline

> How source files become a compiled index.
> Runs offline (overnight job). No UI involvement.

---

## Invocation

```bash
node scripts/ogx-ingest.js \
  --source zotero-export.json \   # or a directory of markdown/PDFs
  --concepts .ogx-concepts.json \ # existing concept definitions
  --root ./my-lit-review \        # project root (where .ogx-* files live)
  --model claude-haiku-4-5 \      # LLM for classification + summarization
  --confidence-threshold 0.75 \   # auto-accept edges above this
  --auto-accept                   # optional: skip manual review for high-confidence
```

Logs to stdout and `.ogx-ingest.log`. Safe to interrupt and restart (checkpoint/resume).

---

## Pipeline Stages

```
1. Ingest metadata
2. Extract text
3. Chunk documents
4. Compute embeddings
5. Summarize (paper + section level)
6. Retrieve candidate chunks per concept
7. Classify relationships (LLM)
8. Generate candidate edges
9. Compile index
```

Stages 1–5 are per-file and parallelizable.
Stages 6–8 are per-concept and depend on stage 4.
Stage 9 runs once at the end.

---

## Stage 1: Ingest Metadata

Source options:

| Source | How | Output |
|---|---|---|
| Zotero Better BibTeX JSON | `JSON.parse` | paper objects with title, authors, year, abstract |
| Zotero local REST API (port 23119) | HTTP GET | same + attachment paths |
| Directory of markdown files | frontmatter parse | whatever frontmatter provides |
| Directory of PDFs | filename only (stage 2 extracts content) | minimal metadata |

Start with Better BibTeX JSON. Abstract + title gets 80% of the value without PDF parsing.

---

## Stage 2: Text Extraction

| File type | Method | Quality |
|---|---|---|
| Markdown | read as-is | perfect |
| PDF (single column) | `pdfjs-dist` (npm) | good |
| PDF (two-column, scientific) | `pdftotext` (poppler, shell out) | acceptable |
| PDF (complex layout) | flag for manual | n/a |

Checkpoint: skip files where `.ogx-chunks/<id>.json` already exists and source hash matches.

---

## Stage 3: Chunking

Strategy:
- Split on headings first (H1/H2/H3 in markdown; detected section breaks in PDF)
- Within sections, split on paragraphs
- Target chunk size: 200–400 tokens
- Overlap: 50 tokens between adjacent chunks (preserves context at boundaries)

Chunk ID format: `<paper-id>#<section-slug>:<page>:<chunk-index>`

Example: `baum-snow-2007#highway_system:p5:c2`

---

## Stage 4: Embeddings

Model: `text-embedding-3-small` (OpenAI) or equivalent.
Stored in: `.ogx-chunks/<paper-id>.json` alongside chunk text.
Vector DB key: same as chunk `id`.

Cost estimate at 100 papers:
```
100 papers × ~3000 tokens average = 300K tokens
text-embedding-3-small: ~$0.001 total
```

Checkpoint: skip chunks that already have an entry in the vector DB.

---

## Stage 5: Summarization

Two passes, both LLM:

**Section summaries**: one call per section. Input: section text. Output: 1–2 sentence summary.

**Paper summaries**: one call per paper. Input: title + abstract + section summaries. Output: 2–3 sentence summary.

Summaries stored in paper/section objects in `.ogx-index.json`.

Cost estimate at 100 papers, 5 sections each:
```
500 section calls × ~400 tokens input + ~100 tokens output = 250K tokens
100 paper calls × ~600 tokens input + ~150 tokens output = 75K tokens
Claude Haiku: ~$0.04 total
```

---

## Stage 6: Candidate Retrieval

For each concept in `.ogx-concepts.json`:
1. Embed the concept description
2. Retrieve top-K chunks by cosine similarity (K = 10 default)
3. These are candidates for LLM classification in stage 7

This step is cheap. It narrows the LLM call surface from (papers × concepts) to (K × concepts).

---

## Stage 7: Relationship Classification

For each (concept, candidate_chunks) pair:

Prompt structure:
```
Concept: Instrumental Variables
Description: Causal inference method using exogenous variation...

Chunk text: "I instrument for the total number of highways built with..."

Does this chunk indicate the paper:
(a) uses this method
(b) compares to this method
(c) only mentions it in passing
(d) not related

Answer with type and confidence (0–1).
```

Output: `{ type: "uses", confidence: 0.92 }` or `{ type: "none" }`

Edges above `--confidence-threshold` are stored as `status: pending` (or `accepted` if `--auto-accept`).

---

## Stage 8: Edge Generation

For each accepted/pending classification:

```json
{
  "id": "edge_<hash>",
  "from": "<paper-id>",
  "to": "<concept-id>",
  "type": "uses",
  "status": "pending",
  "source": "llm+embedding",
  "confidence": 0.92,
  "evidence": [
    {
      "chunk_id": "baum-snow-2007#highway_system:p5:c2",
      "text": "I instrument for the total number of highways..."
    }
  ]
}
```

Written to `.ogx-edges.json`.

---

## Stage 9: Compile Index

Merge all objects into `.ogx-index.json`:

```json
{
  "compiled_at": "<timestamp>",
  "source_hashes": { "<path>": "<hash>", ... },
  "nodes": { ... },
  "edges": [ ... ]
}
```

The renderer loads this on startup.

---

## Checkpoint / Resume

Before processing any file:
1. Check if `.ogx-chunks/<id>.json` exists and source hash matches → skip chunking + embedding
2. Check if paper already has a summary in `.ogx-index.json` → skip summarization
3. Check if edge for this (paper, concept) pair already exists → skip classification

This makes the pipeline safe to interrupt and restart without re-spending API budget.

---

## Rate Limiting

Anthropic and OpenAI both have per-minute token limits.
The ingest script should:
- Batch embedding calls (up to 2048 inputs per call for OpenAI)
- Add configurable delay between LLM calls (`--rate-limit-ms`, default 200ms)
- Respect 429 responses with exponential backoff

---

## Open Questions

- PDF figure extraction: useful but complex. Defer unless user requests it.
- Multi-paper summarization (corpus-level): what is this collection about as a whole?
- Concept suggestion from clusters: run after embeddings, before classification
- Zotero live sync: watch for collection changes and run incremental ingest
