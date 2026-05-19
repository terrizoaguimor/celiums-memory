// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Celiums Solutions LLC

/**
 * Local embedder — implements ADR-022 §"Embeddings".
 *
 * In `cloud-synced` (ZK) mode, embeddings MUST be computed locally so
 * the plaintext vector is what's synced — the server never sees plaintext
 * content, only its vector.
 *
 * Default model: gte-small (384-dim, ~30 MB ONNX). Fallback for runtimes
 * without ONNX: all-MiniLM-L6-v2 (also 384-dim).
 *
 * This module declares the contract. The actual ONNX runtime is a
 * peer-dependency the operator wires (onnxruntime-node or
 * onnxruntime-web). The package ships a stub that throws a clear error
 * if no runtime is bound, so production deployments fail loudly rather
 * than silently producing zero vectors.
 */

import type { EncryptedBlob } from './types.js';
import { SyncError } from './types.js';

export interface EmbedderModel {
  /** Stable identifier — used for cache invalidation when the model
   *  changes. */
  id: string;
  /** Vector dimension. */
  dim: number;
  /** Optional path to the ONNX file on disk. */
  modelPath?: string;
}

export interface LocalEmbedder {
  readonly model: EmbedderModel;
  /** Embed a single string. Returns Float32Array of length model.dim. */
  embed(text: string): Promise<Float32Array>;
  /** Optional batch embed; default impl maps embed() over each input. */
  embedBatch?(texts: string[]): Promise<Float32Array[]>;
}

/** Stub embedder. Throws on first use with a clear error pointing
 *  operators at the install path. Used as the default so production
 *  deployments fail loudly rather than silently embedding zeros. */
export class StubLocalEmbedder implements LocalEmbedder {
  readonly model: EmbedderModel = { id: 'stub', dim: 384 };

  async embed(_text: string): Promise<Float32Array> {
    throw new SyncError('cloud-synced', 'embed',
      'no local embedder configured. ZK mode requires a local embedding model. ' +
      'Install onnxruntime-node + a 384-dim model (gte-small recommended) and ' +
      'wire it via configure({ embedder: makeOnnxEmbedder(...) }). ' +
      'See docs/sync-modes.md §"Local embeddings".',
    );
  }
}

/** Deterministic test embedder — hashes the input into a stable
 *  pseudo-vector. NOT semantically meaningful; used in tests only. */
export class HashEmbedder implements LocalEmbedder {
  constructor(public readonly model: EmbedderModel = { id: 'test-hash', dim: 384 }) {}

  async embed(text: string): Promise<Float32Array> {
    const out = new Float32Array(this.model.dim);
    let h = 2166136261;
    for (let i = 0; i < text.length; i++) {
      h = Math.imul(h ^ text.charCodeAt(i), 16777619);
    }
    // Splatter the hash into the vector deterministically.
    for (let i = 0; i < out.length; i++) {
      h = Math.imul(h ^ (h >>> 13), 1274126177);
      out[i] = ((h >>> 0) / 0xffffffff) * 2 - 1; // [-1, 1]
    }
    return out;
  }
}

/** Confirms the supplied embedder produces vectors of the model's stated
 *  dimension. Used by the install wizard sanity check + tests. */
export async function verifyEmbedder(embedder: LocalEmbedder): Promise<{ ok: true } | { ok: false; reason: string }> {
  try {
    const v = await embedder.embed('test');
    if (v.length !== embedder.model.dim) {
      return { ok: false, reason: `embedder returned ${v.length}-dim vector, model claims ${embedder.model.dim}` };
    }
    return { ok: true };
  } catch (e) {
    return { ok: false, reason: (e as Error).message };
  }
}

/** Type-narrowing helper used by the ZK pipeline — confirms that an
 *  EncryptedBlob's metadata claims a vector dimension consistent with
 *  the operator's embedder. */
export function vectorDimMatches(blob: EncryptedBlob, dim: number, fieldName = 'embedding_dim'): boolean {
  const meta = (blob.aad ? safeParseJson(blob.aad) : null) as Record<string, unknown> | null;
  if (!meta) return true; // no claim, can't refute
  return meta[fieldName] === undefined || meta[fieldName] === dim;
}

function safeParseJson(s: string): unknown {
  try { return JSON.parse(s); } catch { return null; }
}
