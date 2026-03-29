# Graph Model

> How nodes, edges, and sources compose into the rendered graph.
> See data-model.md for object schemas.

---

## Graph Sources

The graph is assembled from multiple registered sources.
Each source produces `{ nodes, links }`. `buildGraph()` merges all active sources.

| Source ID | Nodes | Links | Active when |
|---|---|---|---|
| `filesystem` | files, folders | parent-child structural | always |
| `extraLinks` | (existing nodes) | user-created session links | when `state.extraLinks` non-empty |
| `research` | concept nodes | semantic edges (accepted) | when index loaded |

Adding a new source = registering an entry. No changes to `buildGraph()` core logic.

---

## Node Identity Resolution

When two sources contribute a node with the same ID:

- **Merge**: research layer enriches filesystem node (paper node = file node + index metadata)
- **No duplicate**: only one graph node exists per ID
- **Priority**: research metadata wins for display fields; filesystem wins for path/type

Example:
```
filesystem:  { id: "baum-snow-2007", type: "file", relPath: "papers/baum-snow-2007.md" }
research:    { id: "baum-snow-2007", type: "paper", title: "Did Highways...", concepts: [...] }
merged:      { id: "baum-snow-2007", type: "paper", relPath: "...", title: "...", concepts: [...] }
```

---

## Node Type Registry

Node types declare their behavior. `nodeIsVisible()` and rendering consult the registry.

```js
NODE_TYPES = {
  file: {
    source:       "filesystem",
    render:       "file",
    visibleIn:    ["files", "hybrid"],
    participates: ["graph", "filters", "working-set"]
  },
  folder: {
    source:       "filesystem",
    render:       "folder",
    visibleIn:    ["folders", "hybrid"],
    participates: ["graph", "filters"]
  },
  concept: {
    source:       "research",
    render:       "concept",
    visibleIn:    ["research", "hybrid"],
    participates: ["graph", "filters"],
    virtual:      true
  },
  paper: {
    source:       "filesystem+research",
    render:       "paper",
    visibleIn:    ["files", "hybrid", "research"],
    participates: ["graph", "filters", "working-set", "semantic-edges"]
  }
}
```

---

## Edge Rendering (by type)

| Edge type | Color | Style | Source |
|---|---|---|---|
| structural (parent-child) | grey | solid | filesystem |
| `ext` | green | dashed | extraLinks |
| `tags` | purple | dashed | extraLinks |
| `name` | yellow | dashed | extraLinks |
| `grep` | orange | dashed | extraLinks |
| `imports` | blue | dashed | extraLinks |
| `refs` | teal | dashed | extraLinks |
| `uses` | — | TBD | research |
| `studies` | — | TBD | research |
| `extends` | — | TBD | research |
| `contradicts` | — | TBD | research |

Research edge colors TBD when research source is implemented.

---

## Concept Node Rendering

Concept nodes are:
- Larger than file nodes
- Pinnable to fixed positions (act as gravity anchors)
- Labeled by `label` field, not filename
- Colored by concept type (METHOD / TOPIC / DATA / CLAIM)
- No file-open action (virtual nodes)

Papers with edges to a concept node are pulled toward it by the physics simulation.
This creates natural clustering: papers using the same method cluster together.

---

## Filter Pipeline Execution Order

Filters are not always commutative. Execution order matters:

```
1. pre-filters       (text search, tag filter, concept filter)
   → reduces working set
2. expansion         (children / siblings / +1 / parents)
   → adds neighbors of seed set
3. post-filters      (allowed intersection — keeps only items that passed pre-filters)
   → removes anything expansion added that wasn't in the allowed set
```

This matches the existing `getWorkingSetItems()` logic and must be preserved when
refactoring to a composable filter pipeline.

---

## Open Questions

- Concept node positions: fully free (physics) or partially fixed (anchored)?
- Edge weight → spring strength mapping for semantic edges
- How to handle concept hierarchy (METHOD → METHOD:IV) in the graph visually
- Whether cluster nodes (auto-discovered topic groups) are a fourth node type
