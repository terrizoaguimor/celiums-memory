<!-- SPDX-License-Identifier: Apache-2.0 -->

# Universal Knowledge — Corpus attribution

The **Universal Knowledge corpus** is the curated body of expert
knowledge modules that backs the `forage`, `absorb`, and `sense` MCP
tools when called against `memory.celiums.ai`. It is served as a
hosted Celiums service and is **not redistributed** under this
repository's Apache 2.0 license.

This document discloses the upstream sources the corpus is composed
from, the licensing posture for each, and what end users can and
cannot do with returned content.

---

## What this corpus is

A curated collection of expert knowledge modules — domain-specific,
machine-readable, version-controlled — covering software engineering,
operations, infrastructure, security, data engineering, mathematics,
and adjacent fields.

Current scale (audited 2026-05-12, floor-reported per
[`canonical-numbers.md`](canonical-numbers.md)):
**4M+ documents, 300K+ curated modules** in the corpus.
The corpus is **actively growing**.

---

## Licensing posture

> Short version: the corpus is composed of items each governed by its
> own license. Celiums Solutions LLC does not transfer ownership of
> upstream content; we curate, normalise, and serve it. Where the
> upstream license requires attribution, that attribution is preserved
> in the module's metadata and returned in API responses.

### Categories of source material

1. **Public-domain / CC0 reference material.** Mathematical
   identities, RFC excerpts (where the license permits), classical
   algorithm descriptions. No attribution required by law; preserved
   anyway when known.
2. **Permissively licensed open documentation** (MIT, Apache 2.0,
   CC-BY 4.0). Required attribution propagated to module metadata
   under the `attribution` field. Visible in `forage` / `absorb`
   responses.
3. **CC-BY-SA / share-alike licensed content.** Subject to upstream
   share-alike obligations. We do not redistribute share-alike content
   as part of the OSS engine; it is accessible only via the hosted
   `memory.celiums.ai` API, where the upstream terms continue to apply
   to downstream re-publication.
4. **Editorial commentary + Celiums-authored synthesis.** Original
   work by the Celiums curation team; copyright Celiums Solutions LLC,
   licensed under the same Apache 2.0 / CC-BY 4.0 split described
   below.
5. **Quoted sources** — short excerpts under fair-use / fair-dealing
   doctrines (US 17 USC §107, EU Directive 2001/29/EC §5(3)(d), and
   national equivalents). Each quote carries its source attribution.

### What gets shipped where

| Asset | Lives where | License |
|---|---|---|
| The corpus content itself | `memory.celiums.ai` hosted service | per-document upstream + Celiums service terms |
| The corpus schema | `packages/core/src/lib/knowledge/types.ts` | Apache 2.0 |
| Module metadata fields (`attribution`, `source_url`, `upstream_license`, `accessed_at`) | API response shape | machine-readable schema is open; payload obeys per-document license |

**We do NOT mirror the full corpus into this repository.** Per
[ADR-021](adr/0021-ethics-layers-oss-service-strategy.md) §"Anti-pattern
9" and `NewGuidelines.md`, the schema is open; the corpus content is
curated editorial work and remains a service.

---

## What you can do with returned content

The `forage`, `absorb`, and `sense` tools return module text. End-user
permissions depend on the per-module `upstream_license` field:

- **Apache-2.0 / MIT / BSD / ISC / CC-BY**: standard permissive use.
  Attribution required (preserved by Celiums in the response).
- **CC-BY-SA**: derivative work obligations apply downstream. You may
  use the content; if you publish a derivative, you must publish it
  under a compatible share-alike license.
- **Fair-use excerpts**: cite the upstream source; substantial reuse
  beyond what fair-use permits requires separate licensing from the
  upstream rightsholder.
- **Celiums-authored editorial synthesis**: CC-BY 4.0. Attribution:
  *"Celiums Universal Knowledge,
  [https://celiums.ai/knowledge](https://celiums.ai/knowledge)"*.

The `upstream_license` field in every module's metadata is the
authoritative answer. If it is missing or empty, treat the module as
restricted and contact `hello@celiums.ai` before reuse beyond
private read.

---

## How curation works

The Celiums curation team:

1. **Surveys** an upstream landscape (e.g., "Postgres replication
   patterns").
2. **Selects** modules under compatible licenses (preferring permissive
   + CC-BY).
3. **Normalises** the content into the canonical module schema —
   sections, examples, eval-score, version, references.
4. **Verifies** with subject-matter editorial review.
5. **Publishes** to the production corpus index with attribution +
   provenance metadata baked in.

Versioning: every module has a `version` field bumped on curation
changes. The hosted endpoint serves the latest version by default;
historical versions are accessible via `?version=` for reproducibility
(important for the `audit.profileId` traceability requirement in
[ADR-021](adr/0021-ethics-layers-oss-service-strategy.md)).

---

## Take-down + correction process

Upstream rightsholders, authors, or anyone with a credible claim can
request take-down or correction:

- **Email**: `hello@celiums.ai`
- **Required information**: the specific module(s) (URL or id),
  nature of the claim (incorrect attribution, license violation, factual
  error, removal request), and contact info.
- **SLA**: acknowledgement within 5 business days, resolution within
  20 business days for clear-cut cases.
- **DMCA**: see [`SECURITY.md`](../SECURITY.md) for the registered
  DMCA contact (overlap with security disclosure flow).

We **do not** charge for take-down processing.

---

## What we do not do

- **Train models** on the corpus without explicit per-source
  permission. The corpus is a retrieval substrate, not a training set.
- **Bundle the corpus as a downloadable archive**. Hosted access only;
  per ADR-021, the curation is the moat.
- **Remix upstream content into "Celiums" original work without
  attribution**. Editorial discipline requires attribution preservation.

---

## Last updated

2026-05-12. *Corpus composition changes monthly; the attribution policy
above changes via [ADR-019 §"Tier 3 explicit consent"](adr/0019-project-governance.md)
process.*
