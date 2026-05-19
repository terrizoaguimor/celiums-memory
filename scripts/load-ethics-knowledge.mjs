#!/usr/bin/env node
// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Celiums Solutions LLC
/**
 * load-ethics-knowledge.mjs — populate the OpenSearch `ethics_knowledge`
 * index that the Ethics Engine's Layer K (precedent) consults.
 *
 * The corpus is NOT in the git tree. It is published as a GitHub Release
 * asset (`ethics_knowledge.jsonl`, ~32 MB, ~1857 docs, embeddings
 * precomputed — no TEI needed here). This script downloads it, verifies
 * its SHA-256, creates the index with the exact prod mapping, and
 * bulk-indexes it. Idempotent: docs use `module_hash` as `_id` (upsert);
 * re-running is safe. The engine runs on Layers A+B without this; Layer
 * K abstains cleanly until the index exists.
 *
 * Env:
 *   OPENSEARCH_URL        required (https://user:pass@host:25060)
 *   ETHICS_INDEX          default "ethics_knowledge"
 *   ETHICS_CORPUS_URL     default = the v2.0.0 release asset
 *   ETHICS_CORPUS_SHA256  default = known sha of the v2.0.0 asset
 *
 * Flags:
 *   --dry-run   download + sha-verify + parse + build, NO writes
 *   --force     delete + recreate the index before loading
 *
 * Usage:
 *   OPENSEARCH_URL="https://user:pass@host:25060" \
 *     node scripts/load-ethics-knowledge.mjs            # or: pnpm ethics:load
 */

import { createHash } from 'node:crypto';
import { parseArgs } from 'node:util';

const { values: args } = parseArgs({
  options: {
    'dry-run': { type: 'boolean', default: false },
    force:     { type: 'boolean', default: false },
  },
  strict: false,
});
const DRY = args['dry-run'];
const FORCE = args.force;

const INDEX = process.env.ETHICS_INDEX || 'ethics_knowledge';
const CORPUS_URL =
  process.env.ETHICS_CORPUS_URL ||
  'https://github.com/terrizoaguimor/celiums-memory/releases/download/v2.0.0/ethics_knowledge.jsonl';
const EXPECTED_SHA =
  process.env.ETHICS_CORPUS_SHA256 ||
  '2cbc7ed608a0af4d861b8e10c14e83a27b7726057215d3d6708efaa102ea82e3';

// OPENSEARCH_URL may embed user:pass — Node fetch rejects creds in URL.
let OS_URL, OS_AUTH;
if (process.env.OPENSEARCH_URL) {
  const u = new URL(process.env.OPENSEARCH_URL);
  if (u.username || u.password) {
    OS_AUTH = 'Basic ' + Buffer.from(`${decodeURIComponent(u.username)}:${decodeURIComponent(u.password)}`).toString('base64');
    u.username = '';
    u.password = '';
  }
  OS_URL = u.toString().replace(/\/$/, '');
}
if (!OS_URL && !DRY) {
  console.error('OPENSEARCH_URL is required (or use --dry-run).');
  process.exit(1);
}
const osHeaders = (extra = {}) => (OS_AUTH ? { Authorization: OS_AUTH, ...extra } : extra);

// Exact prod mapping (measured from the live index — do not "improve").
const INDEX_BODY = {
  settings: {
    index: { knn: true, 'knn.algo_param': { ef_search: 100 } },
  },
  mappings: {
    properties: {
      embedding: {
        type: 'knn_vector',
        dimension: 1024,
        method: { engine: 'lucene', space_type: 'cosinesimil', name: 'hnsw', parameters: { ef_construction: 128, m: 16 } },
      },
      concept: { type: 'text' },
      aliases: { type: 'text' },
      aliases_by_lang: { type: 'object' },
      explanation_en: { type: 'text' },
      benign_counterparts: { type: 'text' },
      distinction_rules: { type: 'text' },
      legitimate_exceptions: { type: 'text' },
      jurisdictional_notes: { type: 'text' },
      legal_references: { type: 'text' },
      category: { type: 'keyword' },
      severity: { type: 'keyword' },
      verdict: { type: 'keyword' },
      topic_id: { type: 'keyword' },
      module_hash: { type: 'keyword' },
      curator_score: { type: 'float' },
      verifier_score: { type: 'float' },
      ingested_at: { type: 'date' },
    },
  },
};

async function main() {
  console.log(`Source: ${CORPUS_URL}`);
  const res = await fetch(CORPUS_URL, { redirect: 'follow' });
  if (!res.ok) throw new Error(`download failed: HTTP ${res.status}`);
  const buf = Buffer.from(await res.arrayBuffer());
  const sha = createHash('sha256').update(buf).digest('hex');
  console.log(`Downloaded: ${(buf.length / 1048576).toFixed(1)} MB · sha256=${sha}`);
  if (sha !== EXPECTED_SHA) {
    console.error(`SHA-256 MISMATCH\n  expected ${EXPECTED_SHA}\n  got      ${sha}\nAbort (set ETHICS_CORPUS_SHA256 to override after a re-export).`);
    process.exit(2);
  }
  console.log('SHA-256 OK ✓');

  const docs = [];
  for (const line of buf.toString('utf8').split('\n')) {
    const t = line.trim();
    if (!t) continue;
    const d = JSON.parse(t);
    if (!Array.isArray(d.embedding) || d.embedding.length !== 1024) {
      throw new Error(`doc missing/!=1024-dim embedding (module_hash=${d.module_hash})`);
    }
    if (!d.module_hash) throw new Error('doc missing module_hash (needed as _id)');
    docs.push(d);
  }
  console.log(`Parsed: ${docs.length} docs · all embeddings 1024-dim ✓`);

  if (DRY) {
    console.log(`[DRY RUN] would create index "${INDEX}" + bulk ${docs.length} docs.`);
    console.log(`  sample _id=${docs[0].module_hash} concept="${String(docs[0].concept).slice(0, 60)}"`);
    return;
  }

  // Index lifecycle (idempotent).
  const head = await fetch(`${OS_URL}/${INDEX}`, { method: 'HEAD', headers: osHeaders() });
  const exists = head.status === 200;
  if (exists && FORCE) {
    await fetch(`${OS_URL}/${INDEX}`, { method: 'DELETE', headers: osHeaders() });
    console.log(`Deleted existing index (--force).`);
  }
  if (!exists || FORCE) {
    const cr = await fetch(`${OS_URL}/${INDEX}`, {
      method: 'PUT',
      headers: osHeaders({ 'Content-Type': 'application/json' }),
      body: JSON.stringify(INDEX_BODY),
    });
    if (!cr.ok) throw new Error(`create index ${cr.status}: ${(await cr.text()).slice(0, 300)}`);
    console.log(`Created index "${INDEX}" with prod mapping.`);
  } else {
    console.log(`Index "${INDEX}" exists — upserting (use --force to recreate).`);
  }

  const CHUNK = 100;
  let indexed = 0, failed = 0;
  for (let i = 0; i < docs.length; i += CHUNK) {
    const slice = docs.slice(i, i + CHUNK);
    const lines = [];
    for (const d of slice) {
      lines.push(JSON.stringify({ index: { _index: INDEX, _id: d.module_hash } }));
      lines.push(JSON.stringify(d));
    }
    const br = await fetch(`${OS_URL}/_bulk`, {
      method: 'POST',
      headers: osHeaders({ 'Content-Type': 'application/x-ndjson' }),
      body: lines.join('\n') + '\n',
    });
    if (!br.ok) throw new Error(`_bulk ${br.status}: ${(await br.text()).slice(0, 300)}`);
    const j = await br.json();
    const errs = j.errors ? j.items.filter((it) => it.index?.error) : [];
    if (errs.length) {
      failed += errs.length;
      console.error('[bulk error sample]', JSON.stringify(errs[0].index.error).slice(0, 200));
    }
    indexed += slice.length - errs.length;
    process.stdout.write(`  ${indexed}/${docs.length}\r`);
  }
  console.log(`\nIndexed: ${indexed}  Failed: ${failed}`);

  await fetch(`${OS_URL}/${INDEX}/_refresh`, { method: 'POST', headers: osHeaders() });
  const cnt = await fetch(`${OS_URL}/${INDEX}/_count`, { headers: osHeaders() }).then((r) => r.json());
  console.log(`Index "${INDEX}" doc count: ${cnt.count} (expected ${docs.length})`);
  if (cnt.count < docs.length) process.exit(3);
  console.log('Ethics knowledge corpus loaded ✓');
}

main().catch((err) => {
  console.error('Fatal:', err.message || err);
  process.exit(1);
});
