// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Celiums Solutions LLC

/**
 * SSE broker — in-process pub/sub for the unified `/v1/events` stream
 * defined by CELIUMS-API-CONTRACT.md §3.13.
 *
 * Each user-tenant pair gets its own channel. Publishers (the
 * cognitive engine, atlas-server callbacks, AAL state machine, ethics
 * dispatcher) call `broker.publish(channelKey, event)`. Subscribers
 * (Console long-poll handlers) call `broker.subscribe(channelKey,
 * onEvent)`.
 *
 * Single-process design — fine for single-user / VPS deploys. In
 * multi-replica enterprise K8s we'll swap this for a Valkey pub/sub
 * adapter behind the same interface; see `attachAdapter()`.
 *
 * Retention: each channel retains its last N events with monotonic
 * sequence ids so reconnecting clients can replay via `Last-Event-ID`.
 */

import { randomUUID } from 'node:crypto';

/** Event type catalog per §3.13. Add new variants here. */
export type CeliumsEvent =
  // Conversation streaming
  | { type: 'message.token'; conversation_id: string; message_id: string; token: string }
  | { type: 'message.tool_call'; message_id: string; skill_id: string; inputs: unknown }
  | {
      type: 'message.tool_result';
      message_id: string;
      skill_id: string;
      output: unknown;
      status: 'success' | 'partial' | 'error';
    }
  | {
      type: 'message.done';
      conversation_id: string;
      message_id: string;
      tokens: { in: number; out: number };
      atlas_decision_id?: string;
    }
  // Channels (propioceptive)
  | {
      type: 'channel.active';
      conversation_id: string;
      channel: 'sense' | 'plan' | 'execute' | 'evaluate' | 'communicate' | 'internal';
      content?: string;
    }
  | { type: 'channel.idle'; conversation_id: string; channel: string }
  // Memory
  | {
      type: 'memory.created';
      memory_id: string;
      valence: number;
      importance: number;
      tags: string[];
    }
  | { type: 'memory.updated'; memory_id: string }
  // Proactive
  | {
      type: 'proactive.chip';
      chip_id: string;
      message: string;
      source: string;
      expires_at: string;
    }
  // AAL
  | { type: 'aal.pending.created'; pending_id: string; level: 'R3' | 'R4' | 'R5' }
  | {
      type: 'aal.pending.resolved';
      pending_id: string;
      resolution: 'approved' | 'rejected' | 'expired';
    }
  // Ethics
  | {
      type: 'ethics.verdict';
      verdict_id: string;
      layer: 'A' | 'B' | 'C';
      result: 'allow' | 'warn' | 'deny';
      action: string;
    }
  // Quota
  | {
      type: 'quota.warning';
      resource: string;
      usage_pct: number;
      reset_at: string;
    }
  // Atlas
  | {
      type: 'atlas.decision';
      decision_id: string;
      tier: 'T0' | 'T1' | 'T2' | 'T3' | 'T4' | 'T5';
      model: string;
      cost_usd: number;
    };

interface RetainedEvent {
  id: number;
  ts: number;
  event: CeliumsEvent;
}

type Subscriber = (event: CeliumsEvent, id: number) => void;

export interface BrokerAdapter {
  publish(channelKey: string, event: CeliumsEvent, id: number): void | Promise<void>;
  subscribe(channelKey: string, handler: Subscriber): () => void;
}

const RETENTION_PER_CHANNEL = 1000;
const RETENTION_TTL_MS = 5 * 60 * 1000;

class InProcessBroker implements BrokerAdapter {
  private subscribers = new Map<string, Set<Subscriber>>();
  private retained = new Map<string, RetainedEvent[]>();
  private sequence = 0;

  publish(channelKey: string, event: CeliumsEvent, id: number): void {
    // Retain for replay.
    const list = this.retained.get(channelKey) ?? [];
    list.push({ id, ts: Date.now(), event });
    // Trim by count.
    while (list.length > RETENTION_PER_CHANNEL) list.shift();
    // Trim by age.
    const cutoff = Date.now() - RETENTION_TTL_MS;
    while (list.length > 0 && list[0]!.ts < cutoff) list.shift();
    this.retained.set(channelKey, list);

    // Fan-out to live subscribers.
    const subs = this.subscribers.get(channelKey);
    if (subs) {
      for (const sub of subs) {
        try {
          sub(event, id);
        } catch (err) {
          console.error('[sse-broker] subscriber threw:', (err as Error).message);
        }
      }
    }
  }

  subscribe(channelKey: string, handler: Subscriber): () => void {
    let set = this.subscribers.get(channelKey);
    if (!set) {
      set = new Set();
      this.subscribers.set(channelKey, set);
    }
    set.add(handler);
    return () => {
      set!.delete(handler);
      if (set!.size === 0) this.subscribers.delete(channelKey);
    };
  }

  /** Get retained events with `id > sinceId`. Used for Last-Event-ID replay. */
  replay(channelKey: string, sinceId: number): RetainedEvent[] {
    const list = this.retained.get(channelKey) ?? [];
    return list.filter((r) => r.id > sinceId);
  }

  nextId(): number {
    return ++this.sequence;
  }
}

let activeBroker: InProcessBroker = new InProcessBroker();

export interface SseBroker {
  publish(channelKey: string, event: CeliumsEvent): number;
  subscribe(channelKey: string, handler: Subscriber): () => void;
  replay(channelKey: string, sinceId: number): RetainedEvent[];
}

export const broker: SseBroker = {
  publish(channelKey, event) {
    const id = activeBroker.nextId();
    activeBroker.publish(channelKey, event, id);
    return id;
  },
  subscribe(channelKey, handler) {
    return activeBroker.subscribe(channelKey, handler);
  },
  replay(channelKey, sinceId) {
    return activeBroker.replay(channelKey, sinceId);
  },
};

/**
 * Channel key convention: `<tenant_id>:<user_id>:<filter>`.
 * `filter` is either `*` (all events) or `conversation:<id>` for
 * conversation-scoped streams.
 */
export function channelKey(
  tenantId: string,
  userId: string,
  filter: { conversationId?: string } = {},
): string {
  const f = filter.conversationId ? `conversation:${filter.conversationId}` : '*';
  return `${tenantId}:${userId}:${f}`;
}

/** Serialize a CeliumsEvent into SSE wire format. */
export function serializeSseEvent(id: number, event: CeliumsEvent): string {
  return `event: ${event.type}\ndata: ${JSON.stringify(event)}\nid: ${id}\n\n`;
}

/** Generate a stable request id for log correlation. */
export function newRequestId(): string {
  return `req_${randomUUID().slice(0, 12)}`;
}
