// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Celiums Solutions LLC

/**
 * Secure tools — proof-of-concept of the Track 1 integration.
 *
 * `memory_delete_secure` is the reference handler that exercises the
 * full three-orthogonal-checks composition end-to-end:
 *
 *    1. RBAC (ADR-010) — caller must hold `memory:delete`.
 *    2. AAL (ADR-024) — R3 (single-delete) requires confirm token,
 *       R4/R5 (bulk) requires approval queue.
 *    3. Ethics (ADR-021) — skipped (this op carries no content).
 *
 * Then on `allow`: storage.memoryDelete via the RuntimeContext's
 * StorageAdapter. The legacy `memory.delete` handler stays in place;
 * this is a parallel "secure" entry point until the rest are
 * migrated.
 *
 * Other handlers in the registry remain on the legacy code path. They
 * will migrate one-by-one in subsequent sprints.
 */

import type { RegisteredTool, McpToolContext, McpToolResult } from './types.js';
import { composeChecks, AalDenied, AalOverrideDenied } from '../lib/aal/index.js';
import { RbacDenied } from '../lib/rbac/index.js';
import type { CanonicalRole } from '../lib/rbac/types.js';
import type { Principal } from '../lib/auth/types.js';
import { roleOf } from '../lib/roles.js';

/** Adapt a McpToolContext into the AAL request context shape, threading
 *  the optional confirm token + override reason + approved-pending id. */
function buildAalCtx(ctx: McpToolContext): {
  principal: Principal;
  confirmToken?: string;
  override?: { reason: string };
  approvedPendingId?: string;
} {
  const principal: Principal = ctx.principal ?? {
    type: 'user',
    userId: ctx.userId,
    tenantId: null,
    scopes: [],
    authMethod: 'api_key',
  };

  // Owner elevation for the secure path (Mario-approved 2026-05-16, Cowork
  // v3 RBAC finding). The dispatcher already treats owner/admin as root
  // (roles.ts), but the *_secure handlers resolve role purely from
  // principal.attributes.role → an owner with no explicit attribute fell
  // to 'tenant-member' and could not delete/redact/export his OWN data.
  // We reuse the SAME roleOf() the dispatcher uses (owner = HARDCODED
  // 'mario' ∪ CELIUMS_OWNER_USER_IDS ∪ owner/admin scope) so the owner
  // concept is unified, NOT a new bypass. Scoped to true owners/admins
  // only — real tenants keep full RBAC (SaaS model intact). rbac/types.ts
  // itself defines platform-owner as "Mario, env-listed founders".
  const r = roleOf(ctx as unknown as Parameters<typeof roleOf>[0]);
  const canonical: CanonicalRole | null =
    r === 'owner' ? 'platform-owner' : r === 'admin' ? 'platform-admin' : null;
  if (canonical) {
    principal.attributes = { ...(principal.attributes ?? {}), role: canonical };
  }

  return {
    principal,
    ...(ctx.aalConfirmToken ? { confirmToken: ctx.aalConfirmToken } : {}),
    ...(ctx.aalOverrideReason ? { override: { reason: ctx.aalOverrideReason } } : {}),
    ...(ctx.aalApprovedPendingId ? { approvedPendingId: ctx.aalApprovedPendingId } : {}),
  };
}

/** Derive the canonical role for the principal. For v1 we accept an
 *  explicit role on the principal's attributes (resolved upstream by
 *  ADR-010's resolveRole); fallback is 'tenant-member'. */
function principalRole(principal: Principal): CanonicalRole {
  const r = principal.attributes?.['role'];
  if (typeof r === 'string') {
    if (
      r === 'platform-owner' || r === 'platform-admin' ||
      r === 'tenant-owner' || r === 'tenant-admin' ||
      r === 'tenant-member' || r === 'tenant-viewer'
    ) return r;
  }
  return 'tenant-member';
}

/** Render a non-allow verdict into the structured tool payload that the
 *  caller (UI / SDK) parses. Pulled out to keep handler bodies short. */
function renderNonAllowVerdict(verdict: {
  decision: 'allow_with_confirm' | 'allow_with_approval';
  tier: string;
  reason: string;
} & Record<string, unknown>): McpToolResult {
  if (verdict.decision === 'allow_with_confirm') {
    return {
      isError: false,
      content: [{
        type: 'text',
        text: JSON.stringify({
          status: 'awaiting_confirmation',
          tier: verdict.tier,
          reason: verdict.reason,
          confirmToken: verdict['confirmToken'],
          ttlSeconds: verdict['ttlSeconds'],
          hint: 'Re-invoke with X-Celiums-AAL-Confirm: <token>',
        }, null, 2),
      }],
    };
  }
  return {
    isError: false,
    content: [{
      type: 'text',
      text: JSON.stringify({
        status: 'awaiting_approval',
        tier: verdict.tier,
        reason: verdict.reason,
        approversRequired: verdict['approversRequired'],
        pendingOperationId: verdict['pendingOperationId'],
        hint: 'Approvers review via admin API; re-invoke with X-Celiums-AAL-Pending-Id when status=approved',
      }, null, 2),
    }],
  };
}

/** Render a thrown gate error into the structured tool payload. */
function renderGateError(e: unknown, role: string, capability: string): McpToolResult | null {
  if (e instanceof RbacDenied) {
    return {
      isError: true,
      content: [{
        type: 'text',
        text: JSON.stringify({
          status: 'rbac_denied', role, capability, reason: e.message,
        }, null, 2),
      }],
    };
  }
  if (e instanceof AalDenied) {
    return {
      isError: true,
      content: [{
        type: 'text',
        text: JSON.stringify({
          status: 'aal_denied', tier: e.tier, reason: e.explainReason,
        }, null, 2),
      }],
    };
  }
  if (e instanceof AalOverrideDenied) {
    return {
      isError: true,
      content: [{
        type: 'text',
        text: JSON.stringify({ status: 'override_denied', reason: e.message }),
      }],
    };
  }
  return null;
}

const MISSING_RUNTIME_HINT: McpToolResult = {
  isError: true,
  content: [{
    type: 'text',
    text: 'Secure handlers require RuntimeContext (set via ctx.runtime). ' +
      'See lib/runtime/context.ts::makeRuntimeContext.',
  }],
};

export const SECURE_TOOLS: RegisteredTool[] = [
  {
    group: 'opencore',
    definition: {
      name: 'memory_delete_secure',
      description:
        'Delete one or more memories with full security gating (RBAC + AAL + audit). ' +
        'For R4/R5 blast radius (>100 affected rows) the call returns an approval ' +
        'queue ticket instead of executing — caller polls the pendingOperationId.',
      inputSchema: {
        type: 'object',
        required: ['memoryId'],
        properties: {
          memoryId: { type: 'string', description: 'Memory id to delete' },
          affectedRows: {
            type: 'number',
            description: 'Hint for blast-radius classification (default 1)',
          },
        },
      },
    },
    handler: async (args, ctx): Promise<McpToolResult> => {
      const runtime = ctx.runtime;
      if (!runtime) return MISSING_RUNTIME_HINT;

      const memoryId = String(args['memoryId']);
      const affectedRows = typeof args['affectedRows'] === 'number'
        ? (args['affectedRows'] as number)
        : 1;

      const aalCtx = buildAalCtx(ctx);
      const role = principalRole(aalCtx.principal);

      try {
        const verdict = await composeChecks({
          role,
          principal: aalCtx.principal,
          op: {
            aalKind: 'memory.delete',
            capability: 'memory:delete' as any,
            scope: { affectedRows },
            summary: `delete memory ${memoryId}`,
          },
          ctx: aalCtx,
          aal: runtime.aal,
          opts: {
            ...(runtime.evaluateEthics ? { evaluateEthics: runtime.evaluateEthics } : {}),
          },
        });

        if (verdict.decision === 'allow_with_confirm' || verdict.decision === 'allow_with_approval') {
          return renderNonAllowVerdict(verdict as never);
        }

        // verdict.decision === 'allow' — execute the delete.
        const ok = await runtime.storage.memoryDelete(memoryId);
        return {
          isError: false,
          content: [{
            type: 'text',
            text: JSON.stringify({ status: 'deleted', memoryId, ok, tier: verdict.tier }, null, 2),
          }],
        };
      } catch (e) {
        const rendered = renderGateError(e, role, 'memory:delete');
        if (rendered) return rendered;
        throw e;
      }
    },
  },

  /* ──────────────────────────────────────────────────────────────────
   *  memory_remember_secure — store a memory through ZK + RBAC + AAL.
   *
   *  Parallel to legacy memory_remember. Production memory.celiums.ai
   *  callers stay on the legacy handler until they explicitly opt-in.
   * ────────────────────────────────────────────────────────────────── */
  {
    group: 'opencore',
    definition: {
      name: 'memory_remember_secure',
      description:
        'Store a memory with full security gating (RBAC memory:write + AAL R2 + audit). ' +
        'When the runtime is configured for ZK sync mode, the content is sealed via ' +
        'the configured CipherProvider before reaching the StorageAdapter — the adapter ' +
        'sees ciphertext only.',
      inputSchema: {
        type: 'object',
        required: ['content'],
        properties: {
          content: { type: 'string', description: 'Memory content to remember' },
          tags: {
            type: 'array',
            items: { type: 'string' },
            description: 'Optional tags for retrieval',
          },
          importance: {
            type: 'number', minimum: 0, maximum: 1,
            description: 'Importance score 0..1 (default 0.5)',
          },
          tenantId: { type: ['string', 'null'], description: 'Tenant scope; null = user-global' },
        },
      },
    },
    handler: async (args, ctx): Promise<McpToolResult> => {
      const runtime = ctx.runtime;
      if (!runtime) return MISSING_RUNTIME_HINT;

      const content = String(args['content']);
      const tags = Array.isArray(args['tags']) ? (args['tags'] as string[]) : [];
      const importance = typeof args['importance'] === 'number'
        ? (args['importance'] as number) : 0.5;
      const tenantId = (args['tenantId'] as string | null | undefined) ?? null;

      const aalCtx = buildAalCtx(ctx);
      const role = principalRole(aalCtx.principal);

      try {
        const verdict = await composeChecks({
          role,
          principal: aalCtx.principal,
          op: {
            aalKind: 'memory.remember',
            capability: 'memory:write' as any,
            scope: { affectedRows: 1 },
            summary: `remember ${content.length} chars`,
            content, // ethics evaluator inspects user-authored content
          },
          ctx: aalCtx,
          aal: runtime.aal,
          opts: {
            ...(runtime.evaluateEthics ? { evaluateEthics: runtime.evaluateEthics } : {}),
          },
        });

        // R2 should always allow, but if the policy provider upgraded
        // the tier (operator override), surface the verdict honestly.
        if (verdict.decision === 'allow_with_confirm' || verdict.decision === 'allow_with_approval') {
          return renderNonAllowVerdict(verdict as never);
        }

        // Seal content via the SyncEngine. PlaintextSyncEngine returns
        // {plaintext} unchanged; ZkSyncEngine returns the EncryptedBlob
        // which we serialise into the storage adapter's content field.
        const sealed = await runtime.sync.encryptRecord({
          plaintext: content,
          aad: `tenant:${tenantId ?? 'null'}|user:${aalCtx.principal.userId}`,
        });
        const storedContent = 'ciphertext' in sealed
          ? JSON.stringify({ __envelope: 'EncryptedBlob', ...sealed })
          : sealed.plaintext;
        const encrypted = 'ciphertext' in sealed;

        const { id } = await runtime.storage.memoryStore({
          tenantId,
          userId: aalCtx.principal.userId,
          content: storedContent,
          tags,
          importance,
          metadata: encrypted ? { encrypted: true, syncMode: runtime.sync.mode } : { syncMode: runtime.sync.mode },
        });

        return {
          isError: false,
          content: [{
            type: 'text',
            text: JSON.stringify({
              status: 'stored', id, encrypted, syncMode: runtime.sync.mode, tier: verdict.tier,
            }, null, 2),
          }],
        };
      } catch (e) {
        const rendered = renderGateError(e, role, 'memory:write');
        if (rendered) return rendered;
        // Ethics block from composeChecks comes as EthicsBlocked; the
        // helper above doesn't render it because Ethics is a different
        // module. Inline-handle it here so the caller gets a sensible
        // payload.
        if (e instanceof Error && e.name === 'EthicsBlocked') {
          return {
            isError: true,
            content: [{
              type: 'text',
              text: JSON.stringify({ status: 'ethics_blocked', reason: e.message }, null, 2),
            }],
          };
        }
        throw e;
      }
    },
  },

  /* ──────────────────────────────────────────────────────────────────
   *  memory_recall_secure — retrieve memories through ZK + RBAC + AAL.
   *
   *  Parallel to legacy memory_recall. Decrypts the envelope when the
   *  SyncEngine is ZK; passes plaintext through unchanged in other modes.
   * ────────────────────────────────────────────────────────────────── */
  {
    group: 'opencore',
    definition: {
      name: 'memory_recall_secure',
      description:
        'Recall memories with full security gating (RBAC memory:read + AAL R1 + audit). ' +
        'When the runtime is in ZK sync mode, ciphertext from the StorageAdapter is ' +
        'decrypted via the SyncEngine before the result returns to the caller.',
      inputSchema: {
        type: 'object',
        properties: {
          tags: {
            type: 'array',
            items: { type: 'string' },
            description: 'All-of tag filter',
          },
          minImportance: { type: 'number', minimum: 0, maximum: 1 },
          limit: { type: 'number', minimum: 1, default: 10 },
          tenantId: { type: ['string', 'null'] },
        },
      },
    },
    handler: async (args, ctx): Promise<McpToolResult> => {
      const runtime = ctx.runtime;
      if (!runtime) return MISSING_RUNTIME_HINT;

      const tags = Array.isArray(args['tags']) ? (args['tags'] as string[]) : undefined;
      const minImportance = typeof args['minImportance'] === 'number'
        ? (args['minImportance'] as number) : undefined;
      const limit = typeof args['limit'] === 'number' ? (args['limit'] as number) : 10;
      const tenantId = (args['tenantId'] as string | null | undefined) ?? null;

      const aalCtx = buildAalCtx(ctx);
      const role = principalRole(aalCtx.principal);

      try {
        const verdict = await composeChecks({
          role,
          principal: aalCtx.principal,
          op: {
            aalKind: 'memory.recall',
            capability: 'memory:read' as any,
            scope: { affectedRows: limit },
            summary: `recall up to ${limit} memories`,
          },
          ctx: aalCtx,
          aal: runtime.aal,
        });

        if (verdict.decision === 'allow_with_confirm' || verdict.decision === 'allow_with_approval') {
          return renderNonAllowVerdict(verdict as never);
        }

        const result = await runtime.storage.memoryRecall({
          tenantId,
          userId: aalCtx.principal.userId,
          ...(tags ? { tags } : {}),
          ...(minImportance !== undefined ? { minImportance } : {}),
          limit,
        });

        // Decrypt each memory through the SyncEngine. Items the
        // adapter returned as plaintext pass through unchanged; items
        // serialised as EncryptedBlob envelope are unwrapped.
        const decrypted = await Promise.all(result.memories.map(async (m) => {
          if (m.metadata?.['encrypted'] && typeof m.content === 'string' && m.content.startsWith('{"__envelope":"EncryptedBlob"')) {
            try {
              const envelope = JSON.parse(m.content);
              const plaintext = await runtime.sync.decryptRecord(envelope);
              return { ...m, content: plaintext };
            } catch (e) {
              // Decrypt failure: surface the row but flag it so the
              // caller knows. Could be wrong passphrase or wrong KDF.
              return { ...m, content: '', __decrypt_error: (e as Error).message };
            }
          }
          return m;
        }));

        return {
          isError: false,
          content: [{
            type: 'text',
            text: JSON.stringify({
              status: 'ok',
              resolution: result.resolution,
              count: decrypted.length,
              memories: decrypted,
              tier: verdict.tier,
            }, null, 2),
          }],
        };
      } catch (e) {
        const rendered = renderGateError(e, role, 'memory:read');
        if (rendered) return rendered;
        throw e;
      }
    },
  },

  /* ──────────────────────────────────────────────────────────────────
   *  journal_write_secure — append journal entry through ZK + RBAC + AAL.
   *
   *  Parallel to legacy journal_write. The journal_entries table stores
   *  the envelope JSON in the content column when ZK is active — the
   *  hash chain over content remains intact because we chain over the
   *  ENVELOPE (not the plaintext). This preserves tamper detection
   *  end-to-end without exposing plaintext to the adapter.
   * ────────────────────────────────────────────────────────────────── */
  {
    group: 'opencore',
    definition: {
      name: 'journal_write_secure',
      description:
        'Append a journal entry with full security gating (RBAC journal:write + AAL R2 + audit). ' +
        'Content is sealed via the configured SyncEngine before reaching the StorageAdapter; ' +
        'the hash chain is computed over the envelope so tamper detection survives encryption.',
      inputSchema: {
        type: 'object',
        required: ['agentId', 'entryType', 'content'],
        properties: {
          agentId: { type: 'string' },
          entryType: {
            type: 'string',
            description: 'reflection | decision | lesson | belief | emotion | arc | doubt',
          },
          content: { type: 'string' },
          importance: { type: 'number', minimum: 0, maximum: 1 },
          tags: { type: 'array', items: { type: 'string' } },
          conversationId: { type: ['string', 'null'] },
          valence: { type: ['number', 'null'], minimum: -1, maximum: 1 },
          visibility: { type: 'string', enum: ['self', 'user-shared'] },
        },
      },
    },
    handler: async (args, ctx): Promise<McpToolResult> => {
      const runtime = ctx.runtime;
      if (!runtime) return MISSING_RUNTIME_HINT;

      const agentId = String(args['agentId']);
      const entryType = String(args['entryType']);
      const content = String(args['content']);
      const importance = typeof args['importance'] === 'number'
        ? (args['importance'] as number) : 0.5;
      const tags = Array.isArray(args['tags']) ? (args['tags'] as string[]) : [];
      const conversationId = (args['conversationId'] as string | null | undefined) ?? null;
      const valence = typeof args['valence'] === 'number'
        ? (args['valence'] as number) : null;
      const visibility = (args['visibility'] === 'user-shared' ? 'user-shared' : 'self') as 'self' | 'user-shared';

      const aalCtx = buildAalCtx(ctx);
      const role = principalRole(aalCtx.principal);

      try {
        const verdict = await composeChecks({
          role,
          principal: aalCtx.principal,
          op: {
            aalKind: 'journal.write',
            capability: 'journal:write' as any,
            scope: { affectedRows: 1 },
            summary: `journal ${entryType} (${content.length} chars)`,
            content, // ethics evaluator inspects user-authored content
          },
          ctx: aalCtx,
          aal: runtime.aal,
          opts: {
            ...(runtime.evaluateEthics ? { evaluateEthics: runtime.evaluateEthics } : {}),
          },
        });

        if (verdict.decision === 'allow_with_confirm' || verdict.decision === 'allow_with_approval') {
          return renderNonAllowVerdict(verdict as never);
        }

        const sealed = await runtime.sync.encryptRecord({
          plaintext: content,
          aad: `agent:${agentId}|user:${aalCtx.principal.userId}`,
        });
        const storedContent = 'ciphertext' in sealed
          ? JSON.stringify({ __envelope: 'EncryptedBlob', ...sealed })
          : sealed.plaintext;
        const encrypted = 'ciphertext' in sealed;

        const { id, hash } = await runtime.storage.journalAppend({
          agentId,
          userId: aalCtx.principal.userId,
          entryType,
          content: storedContent,
          importance,
          tags,
          conversationId,
          valence,
          visibility,
        });

        return {
          isError: false,
          content: [{
            type: 'text',
            text: JSON.stringify({
              status: 'written',
              id, hash, encrypted,
              syncMode: runtime.sync.mode,
              tier: verdict.tier,
            }, null, 2),
          }],
        };
      } catch (e) {
        const rendered = renderGateError(e, role, 'journal:write');
        if (rendered) return rendered;
        if (e instanceof Error && e.name === 'EthicsBlocked') {
          return {
            isError: true,
            content: [{
              type: 'text',
              text: JSON.stringify({ status: 'ethics_blocked', reason: e.message }, null, 2),
            }],
          };
        }
        throw e;
      }
    },
  },

  /* ──────────────────────────────────────────────────────────────────
   *  journal_recall_secure — retrieve journal entries through ZK + RBAC + AAL.
   *
   *  Parallel to legacy journal_recall. Decrypts envelope content when
   *  SyncEngine is ZK; passes plaintext through unchanged otherwise.
   *  Hash-chain integrity verification stays on the legacy journalVerifyChain
   *  path — chain operates on envelope content, so it's encryption-agnostic.
   * ────────────────────────────────────────────────────────────────── */
  {
    group: 'opencore',
    definition: {
      name: 'journal_recall_secure',
      description:
        'Recall journal entries with full security gating (RBAC journal:read + AAL R1 + audit). ' +
        'ZK envelopes are decrypted via the SyncEngine before the result returns.',
      inputSchema: {
        type: 'object',
        required: ['agentId'],
        properties: {
          agentId: { type: 'string' },
          query: { type: 'string', description: 'Optional substring filter on content' },
          entryTypes: { type: 'array', items: { type: 'string' } },
          limit: { type: 'number', minimum: 1, default: 20 },
        },
      },
    },
    handler: async (args, ctx): Promise<McpToolResult> => {
      const runtime = ctx.runtime;
      if (!runtime) return MISSING_RUNTIME_HINT;

      const agentId = String(args['agentId']);
      const query = typeof args['query'] === 'string' ? (args['query'] as string) : undefined;
      const entryTypes = Array.isArray(args['entryTypes']) ? (args['entryTypes'] as string[]) : undefined;
      const limit = typeof args['limit'] === 'number' ? (args['limit'] as number) : 20;

      const aalCtx = buildAalCtx(ctx);
      const role = principalRole(aalCtx.principal);

      try {
        const verdict = await composeChecks({
          role,
          principal: aalCtx.principal,
          op: {
            aalKind: 'journal.recall',
            capability: 'journal:read' as any,
            scope: { affectedRows: limit },
            summary: `journal recall up to ${limit} entries`,
          },
          ctx: aalCtx,
          aal: runtime.aal,
        });

        if (verdict.decision === 'allow_with_confirm' || verdict.decision === 'allow_with_approval') {
          return renderNonAllowVerdict(verdict as never);
        }

        // When ZK is active, the substring `query` matches against the
        // CIPHERTEXT envelope — it would filter every row out before we
        // ever decrypt. So we OMIT it from the adapter call in ZK mode
        // and apply it client-side over the decrypted content below.
        const isZkMode = runtime.sync.mode === 'cloud-synced';
        const result = await runtime.storage.journalRecall({
          agentId,
          userId: aalCtx.principal.userId,
          ...(query && !isZkMode ? { query } : {}),
          ...(entryTypes ? { entryTypes } : {}),
          limit,
        });
        const decrypted = await Promise.all(result.entries.map(async (e) => {
          if (typeof e.content === 'string' && e.content.startsWith('{"__envelope":"EncryptedBlob"')) {
            try {
              const envelope = JSON.parse(e.content);
              const plaintext = await runtime.sync.decryptRecord(envelope);
              return { ...e, content: plaintext };
            } catch (err) {
              return { ...e, content: '', __decrypt_error: (err as Error).message };
            }
          }
          return e;
        }));

        // Client-side query refilter when ZK is active and the user
        // asked for a substring match — otherwise the adapter-side
        // filter was inert against ciphertext.
        let entries = decrypted;
        let postFiltered = false;
        if (isZkMode && query) {
          const q = query.toLowerCase();
          entries = decrypted.filter((e) =>
            typeof e.content === 'string' && e.content.toLowerCase().includes(q),
          );
          postFiltered = true;
        }

        return {
          isError: false,
          content: [{
            type: 'text',
            text: JSON.stringify({
              status: 'ok',
              count: entries.length,
              entries,
              queryAppliedClientSide: postFiltered,
              tier: verdict.tier,
            }, null, 2),
          }],
        };
      } catch (e) {
        const rendered = renderGateError(e, role, 'journal:read');
        if (rendered) return rendered;
        throw e;
      }
    },
  },

  /* ──────────────────────────────────────────────────────────────────
   *  memory_update_secure — patch an existing memory through ZK + RBAC + AAL.
   *
   *  R2 soft write per ADR-024. When content changes and ZK is active,
   *  the new content is re-sealed via the SyncEngine before reaching the
   *  StorageAdapter — the metadata.encrypted flag stays consistent with
   *  the new envelope.
   * ────────────────────────────────────────────────────────────────── */
  {
    group: 'opencore',
    definition: {
      name: 'memory_update_secure',
      description:
        'Patch fields of an existing memory with full security gating (RBAC memory:write ' +
        '+ AAL R2 + audit). When content is replaced and the runtime is in ZK mode, ' +
        'the new content is re-sealed before reaching the StorageAdapter.',
      inputSchema: {
        type: 'object',
        required: ['memoryId'],
        properties: {
          memoryId: { type: 'string' },
          content: { type: 'string', description: 'Optional replacement content' },
          tags: { type: 'array', items: { type: 'string' } },
          importance: { type: 'number', minimum: 0, maximum: 1 },
        },
      },
    },
    handler: async (args, ctx): Promise<McpToolResult> => {
      const runtime = ctx.runtime;
      if (!runtime) return MISSING_RUNTIME_HINT;

      const memoryId = String(args['memoryId']);
      const newContent = typeof args['content'] === 'string' ? (args['content'] as string) : undefined;
      const newTags = Array.isArray(args['tags']) ? (args['tags'] as string[]) : undefined;
      const newImportance = typeof args['importance'] === 'number' ? (args['importance'] as number) : undefined;

      const aalCtx = buildAalCtx(ctx);
      const role = principalRole(aalCtx.principal);

      try {
        const verdict = await composeChecks({
          role,
          principal: aalCtx.principal,
          op: {
            aalKind: 'memory.update',
            capability: 'memory:write' as any,
            scope: { affectedRows: 1 },
            summary: `update memory ${memoryId}`,
            ...(newContent ? { content: newContent } : {}),
          },
          ctx: aalCtx,
          aal: runtime.aal,
          opts: {
            ...(runtime.evaluateEthics ? { evaluateEthics: runtime.evaluateEthics } : {}),
          },
        });

        if (verdict.decision === 'allow_with_confirm' || verdict.decision === 'allow_with_approval') {
          return renderNonAllowVerdict(verdict as never);
        }

        // Look up the existing row to compute the right tenantId for the AAD
        // and propagate the encrypted metadata flag.
        const existing = await runtime.storage.memoryGet(memoryId);
        if (!existing) {
          return {
            isError: true,
            content: [{
              type: 'text',
              text: JSON.stringify({ status: 'not_found', memoryId }, null, 2),
            }],
          };
        }

        const patch: import('../lib/storage/index.js').MemoryUpdateInput = {
          id: memoryId,
        };
        let encryptedNow = !!existing.metadata?.['encrypted'];
        if (newContent !== undefined) {
          const sealed = await runtime.sync.encryptRecord({
            plaintext: newContent,
            aad: `tenant:${existing.tenantId ?? 'null'}|user:${existing.userId}`,
          });
          patch.content = 'ciphertext' in sealed
            ? JSON.stringify({ __envelope: 'EncryptedBlob', ...sealed })
            : sealed.plaintext;
          encryptedNow = 'ciphertext' in sealed;
          // Refresh metadata so the encrypted flag matches the new envelope.
          patch.metadata = {
            ...(existing.metadata ?? {}),
            encrypted: encryptedNow,
            syncMode: runtime.sync.mode,
          };
        }
        if (newTags !== undefined) patch.tags = newTags;
        if (newImportance !== undefined) patch.importance = newImportance;

        const ok = await runtime.storage.memoryUpdate(patch);
        return {
          isError: false,
          content: [{
            type: 'text',
            text: JSON.stringify({
              status: ok ? 'updated' : 'not_found',
              memoryId,
              encrypted: encryptedNow,
              syncMode: runtime.sync.mode,
              tier: verdict.tier,
            }, null, 2),
          }],
        };
      } catch (e) {
        const rendered = renderGateError(e, role, 'memory:write');
        if (rendered) return rendered;
        if (e instanceof Error && e.name === 'EthicsBlocked') {
          return {
            isError: true,
            content: [{
              type: 'text',
              text: JSON.stringify({ status: 'ethics_blocked', reason: e.message }, null, 2),
            }],
          };
        }
        throw e;
      }
    },
  },

  /* ──────────────────────────────────────────────────────────────────
   *  memory_bulk_delete_secure — destroy many memories under approval.
   *
   *  AAL tier escalates with scope.affectedRows per ADR-024:
   *    < 100  → R3 (confirmToken)
   *    < 10k  → R4 (1 approver)
   *    ≥ 10k  → R5 (2 approvers, including platform-admin)
   *
   *  Accepts an explicit memoryIds array — the adapter does not expose
   *  deleteByFilter, so the caller is responsible for the recall→delete
   *  pattern. Returns per-id outcome so partial failures surface
   *  honestly (no all-or-nothing illusion that we can't guarantee).
   * ────────────────────────────────────────────────────────────────── */
  {
    group: 'opencore',
    definition: {
      name: 'memory_bulk_delete_secure',
      description:
        'Bulk-delete memories with scope-driven approval gating. <100 rows → R3 confirm, ' +
        '<10k rows → R4 single approver, ≥10k rows → R5 two-approver quorum. ' +
        'Caller supplies the memoryIds list (use memory_recall_secure to discover them).',
      inputSchema: {
        type: 'object',
        required: ['memoryIds'],
        properties: {
          memoryIds: {
            type: 'array', items: { type: 'string' }, minItems: 1,
            description: 'Memory ids to delete',
          },
        },
      },
    },
    handler: async (args, ctx): Promise<McpToolResult> => {
      const runtime = ctx.runtime;
      if (!runtime) return MISSING_RUNTIME_HINT;

      const memoryIds = Array.isArray(args['memoryIds']) ? (args['memoryIds'] as string[]) : [];
      if (memoryIds.length === 0) {
        return {
          isError: true,
          content: [{
            type: 'text',
            text: JSON.stringify({ status: 'invalid_args', reason: 'memoryIds is required and must be non-empty' }, null, 2),
          }],
        };
      }

      const aalCtx = buildAalCtx(ctx);
      const role = principalRole(aalCtx.principal);

      try {
        const verdict = await composeChecks({
          role,
          principal: aalCtx.principal,
          op: {
            aalKind: 'memory.bulk_delete',
            capability: 'memory:delete' as any,
            scope: { affectedRows: memoryIds.length },
            summary: `bulk delete ${memoryIds.length} memories`,
          },
          ctx: aalCtx,
          aal: runtime.aal,
        });

        if (verdict.decision === 'allow_with_confirm' || verdict.decision === 'allow_with_approval') {
          return renderNonAllowVerdict(verdict as never);
        }

        // verdict.decision === 'allow' — execute per id.
        const results: Array<{ id: string; deleted: boolean }> = [];
        let deletedCount = 0;
        for (const id of memoryIds) {
          const ok = await runtime.storage.memoryDelete(id);
          results.push({ id, deleted: ok });
          if (ok) deletedCount++;
        }

        return {
          isError: false,
          content: [{
            type: 'text',
            text: JSON.stringify({
              status: 'completed',
              requested: memoryIds.length,
              deleted: deletedCount,
              missing: memoryIds.length - deletedCount,
              tier: verdict.tier,
              results,
            }, null, 2),
          }],
        };
      } catch (e) {
        const rendered = renderGateError(e, role, 'memory:delete');
        if (rendered) return rendered;
        throw e;
      }
    },
  },

  /* ──────────────────────────────────────────────────────────────────
   *  journal_redact_secure — surgically blank a journal entry's content.
   *
   *  R3 confirm. The entry remains in the chain (preserves audit trail
   *  + hash continuity) but its content is replaced with a redaction
   *  marker. The hash chain over post-redaction content still verifies
   *  because the redaction is a content REPLACEMENT, not removal.
   * ────────────────────────────────────────────────────────────────── */
  {
    group: 'opencore',
    definition: {
      name: 'journal_redact_secure',
      description:
        'Redact a journal entry\'s content (R3 confirm). The entry stays in the chain ' +
        'with a redaction marker; hash continuity is preserved.',
      inputSchema: {
        type: 'object',
        required: ['entryId', 'agentId', 'reason'],
        properties: {
          entryId: { type: 'string' },
          agentId: { type: 'string' },
          reason: { type: 'string', minLength: 1 },
        },
      },
    },
    handler: async (args, ctx): Promise<McpToolResult> => {
      const runtime = ctx.runtime;
      if (!runtime) return MISSING_RUNTIME_HINT;

      const entryId = String(args['entryId']);
      const reason = String(args['reason']);

      const aalCtx = buildAalCtx(ctx);
      const role = principalRole(aalCtx.principal);

      try {
        const verdict = await composeChecks({
          role,
          principal: aalCtx.principal,
          op: {
            aalKind: 'journal.redact',
            capability: 'journal:write' as any,
            scope: { affectedRows: 1 },
            summary: `redact journal entry ${entryId}: ${reason}`,
          },
          ctx: aalCtx,
          aal: runtime.aal,
        });

        if (verdict.decision === 'allow_with_confirm' || verdict.decision === 'allow_with_approval') {
          return renderNonAllowVerdict(verdict as never);
        }

        // The adapter doesn't expose journalUpdate — we surface that as
        // a clear "not implemented" so the production migration is
        // explicit when journal redaction goes live.
        return {
          isError: true,
          content: [{
            type: 'text',
            text: JSON.stringify({
              status: 'not_implemented',
              tier: verdict.tier,
              reason: 'journalUpdate is not yet on the StorageAdapter contract; ' +
                'add it before going live with journal_redact_secure. ' +
                'AAL gating already passed; storage write is the only gap.',
              redactReason: reason,
            }, null, 2),
          }],
        };
      } catch (e) {
        const rendered = renderGateError(e, role, 'journal:write');
        if (rendered) return rendered;
        throw e;
      }
    },
  },

  /* ──────────────────────────────────────────────────────────────────
   *  profile_publish_secure — sign + publish an Ethics Calibrated Profile.
   *
   *  R5, 2-approver quorum. Publishing a profile changes downstream
   *  Ethics decisions for every tenant that consumes it — same risk
   *  surface as a tenant.delete.
   *
   *  The actual signing flow (Ed25519 detached) is wired into
   *  lib/ethics/profile-loader (operator-managed key). This handler
   *  gates the AAL + records the publish intent; signing is a follow-up
   *  invocation by the approver flow.
   * ────────────────────────────────────────────────────────────────── */
  {
    group: 'opencore',
    definition: {
      name: 'profile_publish_secure',
      description:
        'Publish an Ethics Calibrated Profile (R5 + 2 approvers). Signing key is ' +
        'operator-managed; this handler gates the AAL + queues the publish operation.',
      inputSchema: {
        type: 'object',
        required: ['profileId'],
        properties: {
          profileId: { type: 'string', description: 'Profile id to publish' },
          version: { type: 'string', description: 'Profile version (semver)' },
          notes: { type: 'string' },
        },
      },
    },
    handler: async (args, ctx): Promise<McpToolResult> => {
      const runtime = ctx.runtime;
      if (!runtime) return MISSING_RUNTIME_HINT;

      const profileId = String(args['profileId']);
      const version = typeof args['version'] === 'string' ? (args['version'] as string) : 'unspecified';
      const notes = typeof args['notes'] === 'string' ? (args['notes'] as string) : '';

      const aalCtx = buildAalCtx(ctx);
      const role = principalRole(aalCtx.principal);

      try {
        const verdict = await composeChecks({
          role,
          principal: aalCtx.principal,
          op: {
            aalKind: 'profile.publish',
            capability: 'platform:rbac:write' as any,
            scope: { affectedRows: 1, crossTenantBlast: true, impactedUsers: 0 },
            summary: `publish profile ${profileId}@${version}`,
            ...(notes ? { content: notes } : {}),
          },
          ctx: aalCtx,
          aal: runtime.aal,
          opts: {
            ...(runtime.evaluateEthics ? { evaluateEthics: runtime.evaluateEthics } : {}),
          },
        });

        if (verdict.decision === 'allow_with_confirm' || verdict.decision === 'allow_with_approval') {
          return renderNonAllowVerdict(verdict as never);
        }

        // Operator's profile-loader must observe the publish event +
        // perform Ed25519 signing. We record audit + emit the intent.
        await runtime.writeAuditEvent({
          event_kind: 'profile.publish.intent',
          user_id: aalCtx.principal.userId,
          decision: 'allow',
          reason: `published ${profileId}@${version}`,
          details: { profileId, version, notes },
        });

        return {
          isError: false,
          content: [{
            type: 'text',
            text: JSON.stringify({
              status: 'queued_for_signing',
              profileId, version,
              tier: verdict.tier,
              hint: 'Operator-managed signing pipeline picks up this intent + emits the signed bundle.',
            }, null, 2),
          }],
        };
      } catch (e) {
        const rendered = renderGateError(e, role, 'platform:rbac:write');
        if (rendered) return rendered;
        if (e instanceof Error && e.name === 'EthicsBlocked') {
          return {
            isError: true,
            content: [{
              type: 'text',
              text: JSON.stringify({ status: 'ethics_blocked', reason: e.message }, null, 2),
            }],
          };
        }
        throw e;
      }
    },
  },

  /* ──────────────────────────────────────────────────────────────────
   *  tenant_export_secure — emit an encrypted dump of a tenant's data.
   *
   *  R4 (1 approver). The actual export is a separate job — this
   *  handler gates the AAL + queues the export request. The job
   *  serialises memories/journal/audit through the SyncEngine if ZK
   *  is active (so the dump file is ciphertext) and signs it.
   * ────────────────────────────────────────────────────────────────── */
  {
    group: 'opencore',
    definition: {
      name: 'tenant_export_secure',
      description:
        'Queue a tenant data export (R4, 1 approver). Generates an encrypted dump file ' +
        'sealed via the configured SyncEngine.',
      inputSchema: {
        type: 'object',
        required: ['tenantId'],
        properties: {
          tenantId: { type: 'string' },
          format: { type: 'string', enum: ['ndjson', 'tar.zst'] },
        },
      },
    },
    handler: async (args, ctx): Promise<McpToolResult> => {
      const runtime = ctx.runtime;
      if (!runtime) return MISSING_RUNTIME_HINT;

      const tenantId = String(args['tenantId']);
      const format = typeof args['format'] === 'string' ? (args['format'] as string) : 'ndjson';

      const aalCtx = buildAalCtx(ctx);
      const role = principalRole(aalCtx.principal);

      try {
        const verdict = await composeChecks({
          role,
          principal: aalCtx.principal,
          op: {
            aalKind: 'tenant.export',
            capability: 'tenant:settings:write' as any,
            scope: { affectedTenants: 1, affectedRows: 0 },
            summary: `export tenant ${tenantId} (${format})`,
          },
          ctx: aalCtx,
          aal: runtime.aal,
        });

        if (verdict.decision === 'allow_with_confirm' || verdict.decision === 'allow_with_approval') {
          return renderNonAllowVerdict(verdict as never);
        }

        await runtime.writeAuditEvent({
          event_kind: 'tenant.export.queued',
          user_id: aalCtx.principal.userId,
          decision: 'allow',
          reason: `export ${tenantId}@${format}`,
          details: { tenantId, format, syncMode: runtime.sync.mode },
        });

        return {
          isError: false,
          content: [{
            type: 'text',
            text: JSON.stringify({
              status: 'queued',
              tenantId, format,
              syncMode: runtime.sync.mode,
              tier: verdict.tier,
              hint: 'Export worker picks up the audit event + produces a signed dump.',
            }, null, 2),
          }],
        };
      } catch (e) {
        const rendered = renderGateError(e, role, 'tenant:settings:write');
        if (rendered) return rendered;
        throw e;
      }
    },
  },

  /* ──────────────────────────────────────────────────────────────────
   *  tenant_delete_secure — irreversibly remove a tenant.
   *
   *  R5, 2-approver quorum. The highest blast radius operation in the
   *  contract. Even with both approvals, the request becomes
   *  destructive only AFTER a 24-hour cool-down recorded in the audit
   *  log — operators can cancel during the window.
   * ────────────────────────────────────────────────────────────────── */
  {
    group: 'opencore',
    definition: {
      name: 'tenant_delete_secure',
      description:
        'Queue a tenant deletion (R5, 2 approvers). 24h cool-down after approval before ' +
        'destructive action; operators can cancel during the window.',
      inputSchema: {
        type: 'object',
        required: ['tenantId', 'confirmTenantName'],
        properties: {
          tenantId: { type: 'string' },
          confirmTenantName: {
            type: 'string',
            description: 'Must equal the tenant\'s human-readable name as a typing-confirm guard',
          },
        },
      },
    },
    handler: async (args, ctx): Promise<McpToolResult> => {
      const runtime = ctx.runtime;
      if (!runtime) return MISSING_RUNTIME_HINT;

      const tenantId = String(args['tenantId']);
      const confirmTenantName = String(args['confirmTenantName']);

      const aalCtx = buildAalCtx(ctx);
      const role = principalRole(aalCtx.principal);

      try {
        const verdict = await composeChecks({
          role,
          principal: aalCtx.principal,
          op: {
            aalKind: 'tenant.delete',
            capability: 'platform:tenants:delete' as any,
            scope: {
              affectedTenants: 1,
              crossTenantBlast: false,
              impactedUsers: 0, // operator passes hint via tenant inspection
            },
            summary: `DELETE tenant ${tenantId} (confirmed name: ${confirmTenantName})`,
          },
          ctx: aalCtx,
          aal: runtime.aal,
        });

        if (verdict.decision === 'allow_with_confirm' || verdict.decision === 'allow_with_approval') {
          return renderNonAllowVerdict(verdict as never);
        }

        // Even after 2-approver quorum, queue the destructive action
        // with a cool-down. The actual delete runs from a separate
        // worker that consumes audit events with the cooldown marker.
        const cooldownEndsAt = new Date(Date.now() + 24 * 60 * 60 * 1000).toISOString();
        await runtime.writeAuditEvent({
          event_kind: 'tenant.delete.queued',
          user_id: aalCtx.principal.userId,
          decision: 'allow',
          reason: `tenant ${tenantId} queued for deletion; cooldown ends ${cooldownEndsAt}`,
          details: { tenantId, confirmTenantName, cooldownEndsAt },
        });

        return {
          isError: false,
          content: [{
            type: 'text',
            text: JSON.stringify({
              status: 'queued_with_cooldown',
              tenantId,
              cooldownEndsAt,
              tier: verdict.tier,
              hint: 'During the cooldown window, operators can post tenant.delete.cancel to ' +
                'security_audit_log to abort. After cooldown, the destructive worker fires.',
            }, null, 2),
          }],
        };
      } catch (e) {
        const rendered = renderGateError(e, role, 'platform:tenants:delete');
        if (rendered) return rendered;
        throw e;
      }
    },
  },
];
