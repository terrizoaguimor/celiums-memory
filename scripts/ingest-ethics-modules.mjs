#!/usr/bin/env node
/**
 * ingest-ethics-modules.mjs
 *
 * Ingests harvested ethical concept modules into the OpenSearch
 * `ethics_knowledge` index, using TEI (gte-large-en-v1.5, 1024-dim)
 * for embeddings.
 *
 * Why OpenSearch (not Postgres pgvector):
 *   - Hybrid search out of the box: BM25 lexical + k-NN vector + filters
 *   - Multi-language tokenization for aliases
 *   - Already provisioned in the Celiums fleet (managed DO Database
 *     `celiums-search`, OpenSearch 2.19.4)
 *
 * Usage (run from a host with TEI access on $TEI_URL):
 *
 *   TEI_URL="http://localhost:18090" \
 *   OPENSEARCH_URL="https://doadmin:...@celiums-search-...:25060" \
 *   INDEX="ethics_knowledge" \
 *   node scripts/ingest-ethics-modules.mjs --input /tmp/modules.json
 *
 * Flags:
 *   --input <path>   default /tmp/modules.json
 *   --dry-run        parse + map, no embeddings, no writes
 *   --batch <n>      embedding/bulk batch size (default 16)
 *
 * Schema mapping (harvester JSON → OpenSearch doc):
 *   verdict:  harmful → block, context_dependent → flag, legitimate_with_exceptions → flag
 *   severity: moderate → medium (rest pass through)
 *   aliases:  dict<lang, string[]> → flat string[] (all languages combined)
 *
 * Idempotent: docs use module_hash (sha256 prefix of concept) as _id.
 * Re-running upserts existing docs.
 */

import { readFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { parseArgs } from 'node:util';

// ─── CLI ──────────────────────────────────────────────────────────────────
const { values: args } = parseArgs({
  options: {
    input:    { type: 'string',  default: '/tmp/modules.json' },
    'dry-run': { type: 'boolean', default: false },
    batch:    { type: 'string',  default: '16' },
  },
  strict: false,
});
const INPUT_PATH = args.input;
const DRY_RUN    = args['dry-run'];
const BATCH_SIZE = Math.max(1, parseInt(args.batch, 10) || 16);

// ─── Endpoints ────────────────────────────────────────────────────────────
const TEI_URL  = process.env.TEI_URL  || 'http://localhost:18090';
const OS_INDEX = process.env.INDEX || 'ethics_knowledge';

// OPENSEARCH_URL may include user:pass@host. Node 22 fetch rejects credentials
// in URL — extract them into a Basic auth header.
let OS_URL_CLEAN, OS_AUTH_HEADER;
if (process.env.OPENSEARCH_URL) {
  const u = new URL(process.env.OPENSEARCH_URL);
  if (u.username || u.password) {
    OS_AUTH_HEADER = 'Basic ' + Buffer.from(`${u.username}:${u.password}`).toString('base64');
    u.username = '';
    u.password = '';
  }
  OS_URL_CLEAN = u.toString().replace(/\/$/, '');
}

if (!OS_URL_CLEAN && !DRY_RUN) {
  console.error('OPENSEARCH_URL is required (or use --dry-run).');
  process.exit(1);
}

function osHeaders(extra = {}) {
  return OS_AUTH_HEADER
    ? { Authorization: OS_AUTH_HEADER, ...extra }
    : extra;
}

// ─── TEI embeddings (gte-large-en-v1.5, 1024-dim) ─────────────────────────
async function embedBatch(texts) {
  const res = await fetch(`${TEI_URL}/embed`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ inputs: texts, normalize: true, truncate: true }),
  });
  if (!res.ok) {
    const body = await res.text().catch(() => '');
    throw new Error(`TEI ${res.status}: ${body.slice(0, 200)}`);
  }
  return res.json(); // [[float, ...], ...]
}

// ─── Schema mapping ───────────────────────────────────────────────────────
const VERDICT_MAP = {
  harmful: 'block',
  context_dependent: 'flag',
  legitimate_with_exceptions: 'flag',
};
const SEVERITY_MAP = {
  critical: 'critical',
  high: 'high',
  moderate: 'medium',
  medium: 'medium',
  low: 'low',
};

function flattenAliases(aliases) {
  if (!aliases) return [];
  if (Array.isArray(aliases)) return aliases.filter(s => typeof s === 'string');
  if (typeof aliases !== 'object') return [];
  const out = [];
  for (const arr of Object.values(aliases)) {
    if (Array.isArray(arr)) {
      for (const s of arr) {
        if (typeof s === 'string' && s.trim()) out.push(s.trim());
      }
    }
  }
  return [...new Set(out)];
}

function toArray(v) {
  if (v == null) return [];
  if (Array.isArray(v)) return v.filter(s => typeof s === 'string' && s.trim());
  if (typeof v === 'string' && v.trim()) return [v.trim()];
  if (typeof v === 'object') {
    // dict<key, string> → "key: value" lines
    return Object.entries(v)
      .filter(([, vv]) => typeof vv === 'string' && vv.trim())
      .map(([k, vv]) => `${k}: ${vv.trim()}`);
  }
  return [];
}

function toText(v) {
  // For free-text fields. dict-shaped notes get flattened into a string.
  if (v == null) return null;
  if (typeof v === 'string') return v.trim() || null;
  if (Array.isArray(v)) return v.filter(Boolean).join('\n') || null;
  if (typeof v === 'object') {
    return Object.entries(v)
      .filter(([, vv]) => typeof vv === 'string' && vv.trim())
      .map(([k, vv]) => `${k}: ${vv.trim()}`)
      .join('\n') || null;
  }
  return null;
}

function moduleHash(concept) {
  return createHash('sha256').update(concept.toLowerCase().trim()).digest('hex').slice(0, 32);
}

function mapModule(raw) {
  const verdict  = VERDICT_MAP[raw.verdict];
  const severity = SEVERITY_MAP[raw.severity];
  if (!verdict || !severity || !raw.concept?.trim()) return null;
  const aliases = flattenAliases(raw.aliases);
  const aliases_by_lang =
    raw.aliases && typeof raw.aliases === 'object' && !Array.isArray(raw.aliases)
      ? raw.aliases
      : null;
  return {
    _id: moduleHash(raw.concept),
    doc: {
      concept: raw.concept.trim(),
      aliases,
      aliases_by_lang,
      verdict,
      severity,
      category: raw.category ?? null,
      explanation_en: raw.explanation_en ?? null,
      legal_references: toArray(raw.legal_references),
      jurisdictional_notes: toText(raw.jurisdictional_notes),
      legitimate_exceptions: toArray(raw.legitimate_exceptions),
      benign_counterparts: toArray(raw.benign_counterparts),
      distinction_rules: toArray(raw.distinction_rules),
      topic_id: raw._topicId ?? null,
      curator_score: typeof raw._curatorScore === 'number' ? raw._curatorScore : null,
      verifier_score: typeof raw._verifierScore === 'number' ? raw._verifierScore : null,
      module_hash: moduleHash(raw.concept),
      ingested_at: new Date().toISOString(),
    },
  };
}

function embedText(d) {
  // Compose a richer signal than concept alone: concept + first aliases + first 200ch of explanation
  const aliasSample = (d.aliases || []).slice(0, 8).join(', ');
  const expl = (d.explanation_en || '').slice(0, 200);
  return [d.concept, aliasSample, expl].filter(Boolean).join(' :: ').slice(0, 1500);
}

// ─── OpenSearch bulk ──────────────────────────────────────────────────────
async function bulkIndex(docs) {
  // Build NDJSON bulk body
  const lines = [];
  for (const { _id, doc } of docs) {
    lines.push(JSON.stringify({ index: { _index: OS_INDEX, _id } }));
    lines.push(JSON.stringify(doc));
  }
  const body = lines.join('\n') + '\n';
  const res = await fetch(`${OS_URL_CLEAN}/_bulk`, {
    method: 'POST',
    headers: osHeaders({ 'Content-Type': 'application/x-ndjson' }),
    body,
  });
  if (!res.ok) {
    const errBody = await res.text().catch(() => '');
    throw new Error(`OpenSearch _bulk ${res.status}: ${errBody.slice(0, 300)}`);
  }
  const json = await res.json();
  if (json.errors) {
    const failed = json.items.filter(it => it.index?.error).slice(0, 3);
    console.error('[bulk errors sample]', JSON.stringify(failed, null, 2));
  }
  return json;
}

// ─── Main ─────────────────────────────────────────────────────────────────
async function main() {
  console.log(`Reading: ${INPUT_PATH}`);
  const raw = JSON.parse(readFileSync(INPUT_PATH, 'utf8'));
  const modules = Array.isArray(raw) ? raw : raw.modules ?? [];
  console.log(`Loaded: ${modules.length} raw modules`);

  const mapped = modules.map(mapModule).filter(Boolean);
  console.log(`Mapped: ${mapped.length}  Skipped: ${modules.length - mapped.length}`);

  const dist = mapped.reduce((acc, { doc }) => {
    const k = `${doc.verdict}/${doc.severity}`;
    acc[k] = (acc[k] || 0) + 1;
    return acc;
  }, {});
  console.log('Distribution:', dist);

  if (DRY_RUN) {
    console.log('[DRY RUN] Sample doc:');
    console.log(JSON.stringify(mapped[0], null, 2));
    return;
  }

  // Verify TEI
  const tinfo = await fetch(`${TEI_URL}/info`).then(r => r.json());
  console.log(`TEI: model=${tinfo.model_id}`);

  // Embed in batches, attach to each doc
  console.log(`Embedding (batch=${BATCH_SIZE})…`);
  let embedded = 0;
  for (let i = 0; i < mapped.length; i += BATCH_SIZE) {
    const batch = mapped.slice(i, i + BATCH_SIZE);
    const texts = batch.map(({ doc }) => embedText(doc));
    try {
      const vecs = await embedBatch(texts);
      batch.forEach(({ doc }, j) => { doc.embedding = vecs[j]; });
      embedded += batch.length;
      process.stdout.write(`  ${embedded}/${mapped.length}\r`);
    } catch (err) {
      console.error(`\n[WARN] batch ${i}: ${err.message}`);
    }
  }
  console.log(`\nEmbedded: ${embedded}/${mapped.length}`);

  // Verify dim
  const sample = mapped.find(({ doc }) => Array.isArray(doc.embedding));
  if (sample) {
    console.log(`Embedding dim: ${sample.doc.embedding.length} (index expects 1024)`);
    if (sample.doc.embedding.length !== 1024) {
      console.error('FATAL: embedding dim mismatch.');
      process.exit(2);
    }
  }

  // Bulk index in chunks of 50 to keep payload reasonable
  console.log('Indexing into OpenSearch…');
  const CHUNK = 50;
  let indexed = 0, errors = 0;
  for (let i = 0; i < mapped.length; i += CHUNK) {
    const chunk = mapped.slice(i, i + CHUNK).filter(({ doc }) => Array.isArray(doc.embedding));
    if (chunk.length === 0) continue;
    try {
      const r = await bulkIndex(chunk);
      indexed += chunk.length - (r.errors ? r.items.filter(it => it.index?.error).length : 0);
      if (r.errors) errors += r.items.filter(it => it.index?.error).length;
    } catch (err) {
      console.error(`[ERR] chunk ${i}: ${err.message}`);
      errors += chunk.length;
    }
    process.stdout.write(`  ${indexed}/${mapped.length}\r`);
  }
  console.log(`\nDone. indexed=${indexed}  errors=${errors}`);

  // Refresh + count
  await fetch(`${OS_URL_CLEAN}/${OS_INDEX}/_refresh`, { method: 'POST', headers: osHeaders() });
  const cnt = await fetch(`${OS_URL_CLEAN}/${OS_INDEX}/_count`, { headers: osHeaders() }).then(r => r.json());
  console.log(`Index ${OS_INDEX} doc count: ${cnt.count}`);
}

main().catch(err => {
  console.error('Fatal:', err);
  process.exit(1);
});
