# celiums-memory-engine

Durable cognitive memory semantics over the pinned Hyphae `1.0.0` contract.
The engine provides scoped memory, recall, governance, journal, ingestion,
claims, graph, consolidation and portability primitives.

Filesystem-backed opening and Hyphae native recovery are intentionally part of
the current native runtime boundary. Cloudflare production runs this native
engine in a Container coordinated by a Durable Object.
