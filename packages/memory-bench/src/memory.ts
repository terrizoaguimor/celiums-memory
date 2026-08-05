// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Celiums Solutions LLC

/** Memory client for the benchmark system under test. */

import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process';
import { mkdir } from 'node:fs/promises';
import { createInterface } from 'node:readline';
import { resolve } from 'node:path';

type RpcResponse = {
  id?: number;
  error?: { message?: string };
  result?: { isError?: boolean; content?: { text?: string }[]; structuredContent?: unknown };
};

type RecallRow = { content?: string; memory?: { content?: string } };

interface MemoryTransport {
  call(name: string, args: Record<string, unknown>): Promise<unknown>;
  close(): Promise<void>;
}

function unwrap(response: RpcResponse, tool: string): unknown {
  if (response.error) throw new Error(`mcp ${tool}: ${response.error.message ?? 'RPC error'}`);
  if (response.result?.isError) {
    throw new Error(`mcp ${tool}: ${response.result.content?.[0]?.text ?? 'tool error'}`);
  }
  if (response.result?.structuredContent !== undefined) return response.result.structuredContent;
  const text = response.result?.content?.[0]?.text;
  if (text === undefined) return null;
  try {
    return JSON.parse(text);
  } catch {
    return text;
  }
}

class HttpTransport implements MemoryTransport {
  private readonly base = (process.env.MEMORY_BASE_URL || '').replace(/\/$/, '');
  private readonly key = process.env.CELIUMS_BENCH_CMK || '';

  async call(name: string, args: Record<string, unknown>): Promise<unknown> {
    if (!this.base) throw new Error('MEMORY_BASE_URL is required for HTTP transport');
    const response = await fetch(`${this.base}/mcp`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Accept: 'application/json, text/event-stream',
        ...(this.key ? { Authorization: `Bearer ${this.key}` } : {}),
      },
      body: JSON.stringify({
        jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name, arguments: args },
      }),
    });
    if (!response.ok) throw new Error(`mcp ${name} HTTP ${response.status}`);
    return unwrap(await response.json() as RpcResponse, name);
  }

  async close(): Promise<void> {}
}

class StdioTransport implements MemoryTransport {
  private child?: ChildProcessWithoutNullStreams;
  private nextId = 1;
  private readonly pending = new Map<number, {
    resolve: (response: RpcResponse) => void;
    reject: (error: Error) => void;
  }>();

  constructor(private readonly instanceId: string) {}

  async call(name: string, args: Record<string, unknown>): Promise<unknown> {
    await this.start();
    const response = await this.request('tools/call', { name, arguments: args });
    return unwrap(response, name);
  }

  async close(): Promise<void> {
    if (!this.child) return;
    const child = this.child;
    this.child = undefined;
    child.stdin.end();
    await new Promise<void>((done) => {
      if (child.exitCode !== null) return done();
      child.once('exit', () => done());
      setTimeout(() => {
        child.kill();
        done();
      }, 2_000).unref();
    });
  }

  private async start(): Promise<void> {
    if (this.child) return;
    const binary = process.env.CELIUMS_MEMORY_BIN;
    if (!binary) throw new Error('CELIUMS_MEMORY_BIN is required for stdio transport');
    const root = resolve(process.env.BENCH_RUST_DATA_DIR || '.bench-data');
    const dataDir = resolve(root, this.instanceId.replace(/[^a-zA-Z0-9_.-]/g, '_'));
    await mkdir(dataDir, { recursive: true });

    const child = spawn(binary, [
      'mcp', '--data', dataDir, '--tenant-id', `bench-${this.instanceId}`,
    ], {
      stdio: ['pipe', 'pipe', 'pipe'],
      windowsHide: true,
    });
    this.child = child;
    createInterface({ input: child.stdout }).on('line', (line) => this.handleLine(line));
    child.stderr.on('data', (chunk) => process.stderr.write(`[memory:${this.instanceId}] ${chunk}`));
    child.once('error', (error) => this.rejectAll(error));
    child.once('exit', (code) => {
      if (code && code !== 0) this.rejectAll(new Error(`celiums-memory exited with code ${code}`));
    });

    await this.request('initialize', {
      protocolVersion: '2025-11-25',
      capabilities: {},
      clientInfo: { name: 'celiums-memory-bench', version: '2.0.0' },
    });
    this.notify('notifications/initialized', {});
  }

  private request(method: string, params: Record<string, unknown>): Promise<RpcResponse> {
    const id = this.nextId++;
    return new Promise((resolveRequest, reject) => {
      this.pending.set(id, { resolve: resolveRequest, reject });
      this.write({ jsonrpc: '2.0', id, method, params });
    });
  }

  private notify(method: string, params: Record<string, unknown>): void {
    this.write({ jsonrpc: '2.0', method, params });
  }

  private write(message: Record<string, unknown>): void {
    if (!this.child?.stdin.writable) throw new Error('celiums-memory stdio is not writable');
    this.child.stdin.write(`${JSON.stringify(message)}\n`);
  }

  private handleLine(line: string): void {
    let response: RpcResponse;
    try {
      response = JSON.parse(line) as RpcResponse;
    } catch {
      this.rejectAll(new Error(`invalid MCP JSON: ${line.slice(0, 160)}`));
      return;
    }
    if (typeof response.id !== 'number') return;
    const pending = this.pending.get(response.id);
    if (!pending) return;
    this.pending.delete(response.id);
    pending.resolve(response);
  }

  private rejectAll(error: Error): void {
    for (const pending of this.pending.values()) pending.reject(error);
    this.pending.clear();
  }
}

function makeTransport(instanceId: string): MemoryTransport {
  return process.env.MEMORY_TRANSPORT === 'http'
    ? new HttpTransport()
    : new StdioTransport(instanceId);
}

export class BenchMemory {
  private readonly transport: MemoryTransport;
  private rejected = 0;

  constructor(private readonly runId: string) {
    this.transport = makeTransport(runId);
  }

  private get projectId() { return `bench:${this.runId}`; }

  get rejectedWrites(): number { return this.rejected; }

  async ingestSession(session: {
    sessionId: string;
    timestamp?: string;
    turns: { role: string; content: string }[];
  }): Promise<void> {
    for (let index = 0; index < session.turns.length; index++) {
      const turn = session.turns[index];
      const stamp = session.timestamp ? ` [${session.timestamp}]` : '';
      try {
        await this.transport.call('remember', {
          tenant_id: `bench-${this.runId}`,
          user_id: `bench-${this.runId}`,
          project_id: this.projectId,
          session_id: session.sessionId,
          source_kind: 'benchmark',
          source_id: `${session.sessionId}#${index}`,
          actor: turn.role,
          embedding_provider: 'celiums',
          embedding_model: 'deterministic-word-bigram-hash',
          embedding_revision: 'v1',
          content: `(${session.sessionId}#${index}, ${turn.role})${stamp} ${turn.content}`,
          tags: ['bench', session.sessionId, this.runId],
        });
      } catch (error) {
        if (!(error instanceof Error) || !error.message.includes('blocked by the ethics engine')) {
          throw error;
        }
        this.rejected++;
      }
    }
  }

  async recall(query: string, limit = 12): Promise<string[]> {
    const result = await this.transport.call('recall', {
      query, tenant_id: `bench-${this.runId}`, user_id: `bench-${this.runId}`,
      project_id: this.projectId, limit,
      embedding_provider: 'celiums',
      embedding_model: 'deterministic-word-bigram-hash',
      embedding_revision: 'v1',
    }) as { results?: RecallRow[]; memories?: RecallRow[] };
    const rows: RecallRow[] = Array.isArray(result?.results)
      ? result.results
      : Array.isArray(result?.memories) ? result.memories : [];
    return rows
      .map((memory) => String(memory.content ?? memory.memory?.content ?? ''))
      .filter(Boolean);
  }

  close(): Promise<void> {
    return this.transport.close();
  }
}
