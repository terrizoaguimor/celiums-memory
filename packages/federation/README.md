# @celiums/federation — Knowledge Federation Layer

Real-time curated knowledge across 10 verified public APIs. Replaces the
retired `universal_knowledge` raw-dump tool; becomes `research_search` v2.

**Separate deployable service.** Does NOT touch the `celiums-memory` MCP
image (decision #1). Mirrors the `tier-classifier` service pattern.
Additive to — not a replacement for — the curated `skills` corpus.

## Phases (#166, ~5–6 days)

- **F1 — connector library** ✅ *(this scaffold)*
  10 normalized connectors, polite UA `Celiums-Research mailto:hello@celiums.ai`,
  per-call timeout 8s + retry 1x + per-connector circuit breaker,
  Valkey cache (TTL 24h `science` / 1h `wiki-web`, decision #3),
  parallel fan-out (`Promise.allSettled`, one dead API never sinks the rest).
- **F2 — router** query → domain → connector subset (reuses the intent
  classifier task #49). Replaces the explicit `sources`/`domain` selection
  in `POST /v1/search`.
- **F3 — RRF fusion + dedup** by DOI/title; OPTIONAL ingest of frequent
  hits → permanent curated `skills` modules (decision #4).
- **F4 — wire MCP** as `research_search` v2; clean `universal_knowledge`
  deprecation.

## Connectors (latency measured from cluster VPC)

| id | domain | cache | ~ms |
|---|---|---|---|
| clinicaltrials | medical | science | 48 |
| pubmed | medical | science | 124 |
| arxiv | scientific | science | 211 |
| wikidata | general | wiki-web | 227 |
| crossref | scientific | science | 272 |
| wikipedia | general | wiki-web | 334 |
| openfda | medical | science | 424 |
| openalex | scientific | science | 438 |
| europepmc | medical+scientific | science | 662 |
| semanticscholar | scientific | science | 1005 |

## Endpoints

- `GET  /health` — liveness + cache reachability + breaker snapshot
- `GET  /v1/connectors` — registry introspection
- `POST /v1/search` — `{ query, sources?:string[] | domain?, limit?, timeoutMs? }`
  → `{ query, cached, sources:[{source,ok,count,ms,error?}], documents:FedDocument[] }`

## Env

| var | purpose |
|---|---|
| `PORT` | default 5200 |
| `REDIS_URL` / `VALKEY_URL` | result cache (optional — live-only if unset) |
| `S2_API_KEY` | Semantic Scholar (decision #2 — raises rate limit) |
| `NCBI_API_KEY` | PubMed E-utilities (3→10 req/s) |
| `FDA_API_KEY` | OpenFDA (raises limits) |

Keyless operation works for all 10 (lower shared rate limits).
