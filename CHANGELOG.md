# Changelog

## 2026-03-29

### Graph and workspace UX

- Added selection-focused graph rendering that mutes non-working-set nodes while keeping the current scoped set visible.
- Updated folder/file selection so the reader deck, graph visibility, and selection summary stay aligned.
- Added a selection panel footer with right-aligned `folders`, `files`, and `total` counts.
- Made the mode chip clickable so it cycles `folders -> files -> hybrid`.
- Added a `./testenvpdfs` quick-load button alongside the existing sample environment button.

### Concepts and graph extensions

- Added concept node support with typed directional concept edges.
- Added explicit concept persistence through `.ogx-concepts.json`.
- Added CLI support for concept-aware edge creation and concept save/list/remove flows.

### PDF and media indexing

- Added PDF parsing support and browse-tab PDF rendering.
- Changed default PDF cards to cheap metadata-first previews instead of automatic head/tail extraction.
- Added persistent media query storage through `.ogx-media-index.json`.
- Added `load`, `+load`, and `-load` commands for storing materialized file queries in the media index.
- Added stored-query rendering support, including `render [n] | ...` and default render-over-index behavior for PDFs/images when indexed content exists.

### Runtime and safety

- Added a software-rendered startup path for Chromium GPU issues via `pnpm start:safe` and `OGX_DISABLE_GPU=1`.
- Added `docs/testenvpdfs/` to `.gitignore` for local PDF fixture testing.
