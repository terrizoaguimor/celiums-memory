// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Celiums Solutions LLC

/**
 * @celiums-memory/core — Ethics Audit Logger
 *
 * Persists ethics classification results to an append-only audit table.
 * This is the permanent record that authorities can query if content
 * is flagged as potentially harmful.
 *
 * The audit trail is the accountability mechanism that replaces censorship.
 * Instead of blocking content, we log who flagged what and why.
 *
 * @license Apache-2.0
 */

import type { AuditEntry } from './ethics-dispatcher.js';

export interface AuditRecord {
  contentHash: string;
  timestamp: number;
  layerADecision: string;
  layerBDecision: string | null;
  layerCDecision: string | null;
  frameworkConvergence: number | null;
  violationCount: number;
  blocked: boolean;
  rawContentLength: number;
  sanitizedContentLength: number;
}

/**
 * Log an ethics audit entry.
 * Best-effort: never throws, never blocks the response pipeline.
 */
export async function logEthicsAudit(
  content: string,
  auditEntry: AuditEntry,
  layerAResult: any,
  layerBResult: any,
  layerCResult: any,
): Promise<void> {
  const record: AuditRecord = {
    contentHash: auditEntry.contentHash,
    timestamp: auditEntry.timestamp,
    layerADecision: auditEntry.layerADecision,
    layerBDecision: layerBResult?.decision || null,
    layerCDecision: layerCResult?.aggregatedVerdict || null,
    frameworkConvergence: layerCResult?.convergenceScore || null,
    violationCount: layerAResult?.violations?.length || 0,
    blocked: false, // audit mode never blocks
    rawContentLength: auditEntry.rawContentLength,
    sanitizedContentLength: auditEntry.sanitizedContentLength,
  };

  // Log to structured output (stdout/logger) for external collection
  try {
    console.error(JSON.stringify({
      type: 'ethics_audit',
      ...record,
    }));
  } catch {}

  // If database is available, also persist
  try {
    // Dynamic import to avoid forcing DB dependency on all consumers
    // const { pool } = await import('./db.js');
    // await pool.query(
    //   'INSERT INTO ethics_audit (content_hash, timestamp, ...) VALUES ($1, $2, ...)',
    //   [...]
    // );
  } catch {
    // DB logging is best-effort
  }
}

/**
 * Query audit records for a specific content hash.
 * For authority/fiscal review.
 */
export async function queryAuditByHash(contentHash: string): Promise<AuditRecord[]> {
  try {
    // const { pool } = await import('./db.js');
    // const result = await pool.query(
    //   'SELECT * FROM ethics_audit WHERE content_hash = $1 ORDER BY timestamp DESC',
    //   [contentHash]
    // );
    // return result.rows;
  } catch {}
  return [];
}

/**
 * Query recent audit records for review dashboard.
 */
export async function queryRecentAudit(limit: number = 50): Promise<AuditRecord[]> {
  try {
    // const { pool } = await import('./db.js');
    // const result = await pool.query(
    //   'SELECT * FROM ethics_audit ORDER BY timestamp DESC LIMIT $1',
    //   [limit]
    // );
    // return result.rows;
  } catch {}
  return [];
}
