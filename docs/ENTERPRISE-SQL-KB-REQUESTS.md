# Enterprise SQL & Knowledge Base — Development Requests

> Status: **draft for team review**  
> Target: `dev` branch  
> Context: Celiums Memory + Hyphae, positioned for regulated enterprise (banking, health, government, legal).  
> Goal: strengthen the product layer on top of the already-solid storage engine.

---

## 1. Context

The storage core is closed and verified:

- WAL, MVCC, append-only hash-chained journal (BLAKE3 over Hyphae)
- Hybrid retrieval in v2.0.0: BM25 + vectors, reciprocal-rank fusion, attested model stages, deterministic chunking with provenance
- Verified exit ramp from Weaviate (3,633 objects, sealed fidelity receipt)
- License: Apache 2.0 across the software tree

What is missing for enterprise is the **product layer above the engine**: row-level permissions, auditable knowledge versioning, and provenance-validated ingestion. An auditor must be able to answer *who uploaded this, when, and under what policy* — today there is no native answer for that.

---

## 2. SQL layer — requests

The engine (SQL, WAL, MVCC, verifiable proofs) is solid. The work is the product surface:

### 2.1 Row-level security / permissions

- [ ] Policy expressions evaluated per row at read and write time (tenant, role, attribute-based)
- [ ] Deny-by-default: a query without an explicit policy returns zero rows, never an error that leaks existence
- [ ] Policy definitions themselves are versioned and hash-chained in the journal — changing a policy is an auditable event
- [ ] Integration with the existing RBAC / OIDC boundary; no second auth system

### 2.2 Materialized views

- [ ] Declarative materialized views over SQL + Hyphae structures
- [ ] Refresh is an explicit, idempotent, journaled operation (not a silent background job)
- [ ] Stale-view detection: a view whose underlying data moved reports its generation, so callers never read a silently outdated aggregate

### 2.3 Context-aware query planner

- [ ] Planner that takes the caller's identity, active project, and conversation context into account when choosing indexes and join order
- [ ] Cost model that prefers verified, low-latency paths (microsecond BM25, exact Q15) over broad scans when the context allows
- [ ] Explain output includes the policy decisions applied, for audit

### 2.4 Guardrail for generated SQL (Llama 4 Scout integration)

- [ ] Model proposes SQL; a validator executes — never the model directly
- [ ] Validator checks: schema allow-list, row policy compliance, estimated cost ceiling, no DDL/DML unless explicitly permitted
- [ ] Rejected queries return a structured reason the model can use to retry

---

## 3. Knowledge Base — requests

Retrieval hybrid in v2.0 is good. Enterprise KB needs governance on top:

### 3.1 ACL per document

- [ ] Each indexed document carries an access-control list (principals + roles) evaluated at retrieval time
- [ ] A recall that the caller is not allowed to see returns *absence*, not an error — no existence leak
- [ ] ACL changes are journaled events; historical recalls remain attributable to the ACL that was in force

### 3.2 Versioned knowledge with auditable history

- [ ] Documents are versioned; every version is content-addressed (SHA-256) and linked in the hash chain
- [ ] `recall` can target a specific version or "as of" a timestamp — time-travel over knowledge, not just over memory
- [ ] Diff between versions is first-class and itself verifiable
- [ ] Deletion is soft + policy-gated: tombstone in the chain, residue report on hard delete

### 3.3 Provenance-validated ingestion pipeline

- [ ] Every ingest path requires: source identity, timestamp, content hash, and the policy under which it was accepted
- [ ] Rejected or quarantined documents are recorded with reason — nothing is silently dropped
- [ ] Pipeline stages (parse → chunk → embed → index) each emit a receipt; the full chain is reconstructable from the journal
- [ ] Compatible with the existing Weaviate exit-ramp pattern: migration produces a sealed fidelity receipt

### 3.4 Answers to the auditor's questions

The KB must natively answer, with cryptographic proof:

1. Who uploaded this document, and when?
2. Under which policy was it accepted?
3. Which versions existed, and what changed between them?
4. Who retrieved it, and what ACL was in force at that moment?
5. Was it ever modified or deleted after ingestion?

---

## 4. Non-goals (explicit)

- No horizontal clustering or multi-node replication in this phase — single-process ownership stays
- No second vector store; Hyphae remains the only index
- No bundled LLM; Scout (or any provider) stays caller-supplied, behind the validator
- No weakening of the append-only journal or the BLAKE3 chain — governance layers build on them, never around them

---

## 5. Acceptance criteria

- [ ] All new surfaces covered by conformance tests (native + Container) using the same fixtures and result schema
- [ ] Every mutating operation carries an `X-Celiums-Operation-Id`, a receipt, and a chain-verifiable record
- [ ] A red-team exercise: attempt to read a row/document outside the caller's policy → zero rows, no error leak
- [ ] An auditor dry-run: reconstruct the full provenance of one document from journal alone, in under a minute
- [ ] Benchmarks: row-policy evaluation adds < 5% to p99 recall latency on the existing hybrid path

---

## 6. Suggested sequencing

1. **ACL per document + row policy** (unblocks regulated pilots)
2. **Provenance-validated ingestion** (unblocks the auditor story)
3. **Versioned knowledge + time-travel recall**
4. **Materialized views + context-aware planner**
5. **Scout SQL validator** (depends on 1 and 4)

---

*Prepared from the enterprise positioning discussion. Ready for the team to break into issues.*
