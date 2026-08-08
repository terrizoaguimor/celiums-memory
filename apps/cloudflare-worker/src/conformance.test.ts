import { describe, expect, it } from 'vitest';
import { resolveTenant } from './auth';
import { checkpointArtifact, persistCheckpoint } from './checkpoint';
import { TenantJournal } from './journal';
import { forwardBinaryWithJournal, forwardWithJournal } from './runtime';

class ConformanceStorage {
  private readonly values = new Map<string, unknown>();
  private readonly objects = new Map<string, Uint8Array>();

  async get<T>(key: string): Promise<T | undefined> {
    return this.values.get(key) as T | undefined;
  }

  async put<T>(key: string, value: T): Promise<void> {
    this.values.set(key, value);
  }

  async list<T>(prefix: string): Promise<T[]> {
    return [...this.values.entries()]
      .filter(([key]) => key.startsWith(prefix))
      .map(([, value]) => value as T);
  }

  async transaction<T>(closure: (transaction: {
    get<Value>(key: string): Promise<Value | undefined>;
    put<Value>(key: string, value: Value): Promise<void>;
  }) => Promise<T>): Promise<T> {
    return closure({
      get: <Value>(key: string) => this.get<Value>(key),
      put: <Value>(key: string, value: Value) => this.put(key, value),
    });
  }

  async objectPut(key: string, value: ArrayBuffer | Uint8Array): Promise<void> {
    this.objects.set(key, value instanceof Uint8Array ? value : new Uint8Array(value));
  }

  async objectGet(key: string): Promise<{ body: ReadableStream } | null> {
    const value = this.objects.get(key);
    return value ? { body: new ReadableStream({ start(controller) { controller.enqueue(value); controller.close(); } }) } : null;
  }

  async objectDelete(key: string): Promise<void> {
    this.objects.delete(key);
  }
}

describe('native/Container contract', () => {
  it('binds authentication, journal and checkpoint pointer to one tenant', async () => {
    const environment = { MYCELIUM_API_KEYS: 'key-a:tenant-a:user:subject:owner' };
    const request = new Request('https://memory.example/mcp', {
      headers: { Authorization: 'Bearer key-a', 'x-celiums-tenant-id': 'tenant-a' },
    });
    expect(resolveTenant(request, environment)).toBe('tenant-a');

    const storage = new ConformanceStorage();
    const journal = new TenantJournal(storage, 'tenant-a');
    await journal.prepare({
      operationId: 'op-conformance', tenantId: 'tenant-a', method: 'POST', path: '/mcp',
      body: '{}', bodyHash: 'hash', createdAtMs: 1,
    });
    expect((await journal.get('op-conformance'))?.tenantId).toBe('tenant-a');

    await persistCheckpoint(
      'tenant-a', storage, {
        put: (key, value) => storage.objectPut(key, value as ArrayBuffer | Uint8Array),
        get: (key) => storage.objectGet(key),
        delete: (key) => storage.objectDelete(key),
      }, {
        checkpointId: 'cp-conformance', checkpointSequence: 3, snapshotDigest: 'digest',
        ciphertextBlake3: 'cipher', ciphertextBytes: 2, plaintextBytes: 2, createdAtMs: 1,
      }, new Response(new Uint8Array([1, 2])),
    );

    const artifact = await checkpointArtifact(storage, { get: (key) => storage.objectGet(key) }, 'cp-conformance');
    expect(artifact.status).toBe(200);
    expect(artifact.headers.get('x-celiums-checkpoint-sequence')).toBe('3');
  });

  it('keeps native mutating requests idempotent across the same contract', async () => {
    const storage = new ConformanceStorage();
    let calls = 0;
    const makeRequest = () => new Request('https://memory.example/mcp', {
      method: 'POST',
      headers: { 'x-celiums-operation-id': 'op-native', 'x-celiums-tenant-id': 'tenant-a', 'content-type': 'application/json' },
      body: '{}',
    });
    const forward = async () => { calls++; return Response.json({ calls }); };
    const first = await forwardWithJournal(makeRequest(), storage, forward);
    const retry = await forwardWithJournal(makeRequest(), storage, forward);
    expect(await first.json()).toEqual({ calls: 1 });
    expect(await retry.json()).toEqual({ calls: 1 });
    expect(calls).toBe(1);
  });
});
