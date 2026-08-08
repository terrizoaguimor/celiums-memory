import { describe, expect, it } from 'vitest';
import { TenantJournal, type JournalStorage, type JournalTransaction } from './journal';
import { forwardBinaryWithJournal, forwardWithJournal, OPERATION_HEADER, TENANT_HEADER, type BinaryObjectStore } from './runtime';

class MemoryStorage implements JournalStorage {
  private readonly values = new Map<string, unknown>();

  get<T>(key: string): Promise<T | undefined> {
    return Promise.resolve(this.values.get(key) as T | undefined);
  }

  list<T>(prefix: string): Promise<T[]> {
    return Promise.resolve([...this.values.entries()]
      .filter(([key]) => key.startsWith(prefix))
      .map(([, value]) => value as T));
  }

  async transaction<T>(closure: (transaction: JournalTransaction) => Promise<T>): Promise<T> {
    return closure({
      get: <Value>(key: string) => this.get<Value>(key),
      put: async <Value>(key: string, value: Value) => {
        this.values.set(key, value);
      },
    });
  }
}

class BinaryStore implements BinaryObjectStore {
  private readonly values = new Map<string, Uint8Array>();

  async put(key: string, value: ArrayBuffer | Uint8Array): Promise<void> {
    this.values.set(key, value instanceof Uint8Array ? value : new Uint8Array(value));
  }

  async get(key: string): Promise<{ body: ReadableStream } | null> {
    const value = this.values.get(key);
    return value ? { body: new ReadableStream({ start(controller) { controller.enqueue(value); controller.close(); } }) } : null;
  }

  async delete(key: string): Promise<void> {
    this.values.delete(key);
  }
}

function request(operationId: string, tenantId = 'tenant-a', body = '{"value":1}') {
  return new Request('https://memory.example/mcp', {
    method: 'POST',
    headers: {
      [OPERATION_HEADER]: operationId,
      [TENANT_HEADER]: tenantId,
      'Content-Type': 'application/json',
    },
    body,
  });
}

describe('forwardWithJournal', () => {
  it('forwards once and replays the durable receipt for a retry', async () => {
    const storage = new MemoryStorage();
    let forwards = 0;
    const forward = async () => {
      forwards++;
      return Response.json({ forwards });
    };

    const first = await forwardWithJournal(request('op-1'), storage, forward);
    const retry = await forwardWithJournal(request('op-1'), storage, forward);

    expect(first.status).toBe(200);
    expect(await first.json()).toEqual({ forwards: 1 });
    expect(await retry.json()).toEqual({ forwards: 1 });
    expect(forwards).toBe(1);
  });

  it('rejects operation reuse with a different payload before forwarding', async () => {
    const storage = new MemoryStorage();
    const forward = async () => Response.json({ ok: true });
    await forwardWithJournal(request('op-1', 'tenant-a', '{"value":1}'), storage, forward);

    await expect(
      forwardWithJournal(request('op-1', 'tenant-a', '{"value":2}'), storage, forward),
    ).rejects.toThrow('operation_id was reused with different content');
  });

  it('replays a command whose first attempt ended ambiguously', async () => {
    const storage = new MemoryStorage();
    let forwards = 0;

    await expect(
      forwardWithJournal(request('op-pending'), storage, async () => {
        forwards++;
        throw new Error('container unavailable');
      }),
    ).rejects.toThrow('container unavailable');

    const response = await forwardWithJournal(
      request('op-pending'),
      storage,
      async () => {
        forwards++;
        return Response.json({ unexpected: true });
      },
    );

    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ unexpected: true });
    expect(forwards).toBe(2);
  });

  it('does not journal MCP notifications or protocol setup', async () => {
    const storage = new MemoryStorage();
    const methods = ['initialize', 'notifications/initialized', 'ping', 'tools/list'];

    for (const method of methods) {
      const response = await forwardWithJournal(
        new Request('https://memory.example/mcp', {
          method: 'POST',
          headers: { [TENANT_HEADER]: 'tenant-a', 'Content-Type': 'application/json' },
          body: JSON.stringify({ jsonrpc: '2.0', id: 1, method }),
        }),
        storage,
        async () => new Response(method),
      );
      expect(await response.text()).toBe(method);
    }

    expect(await new TenantJournal(storage, 'tenant-a').highWaterMark()).toBe(0);
  });

  it('keeps the same operation id independent across tenant journals', async () => {
    const tenantAStorage = new MemoryStorage();
    const tenantBStorage = new MemoryStorage();
    const forward = async () => Response.json({ ok: true });
    const first = await forwardWithJournal(request('op-1', 'tenant-a'), tenantAStorage, forward);
    const second = await forwardWithJournal(request('op-1', 'tenant-b'), tenantBStorage, forward);

    expect(first.status).toBe(200);
    expect(second.status).toBe(200);
  });

  it('does not journal requests without an operation id', async () => {
    const storage = new MemoryStorage();
    let forwards = 0;
    const response = await forwardWithJournal(
      new Request('https://memory.example/healthz'),
      storage,
      async () => {
        forwards++;
        return new Response('ok');
      },
    );

    expect(await response.text()).toBe('ok');
    expect(forwards).toBe(1);
    expect(await new TenantJournal(storage, 'tenant-a').highWaterMark()).toBe(0);
  });

  it('requires an operation id for MCP tool calls', async () => {
    let forwards = 0;
    const response = await forwardWithJournal(
      new Request('https://memory.example/mcp', {
        method: 'POST',
        headers: { [TENANT_HEADER]: 'tenant-a', 'Content-Type': 'application/json' },
        body: JSON.stringify({
          jsonrpc: '2.0',
          id: 1,
          method: 'tools/call',
          params: { name: 'remember', arguments: { content: 'test' } },
        }),
      }),
      new MemoryStorage(),
      async () => {
        forwards++;
        return new Response('unexpected');
      },
    );

    expect(response.status).toBe(400);
    expect(await response.json()).toEqual({ error: { code: 'operation_id_required' } });
    expect(forwards).toBe(0);
  });

  it('allows MCP initialization without an operation id', async () => {
    const response = await forwardWithJournal(
      new Request('https://memory.example/mcp', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'initialize' }),
      }),
      new MemoryStorage(),
      async () => new Response('initialized'),
    );

    expect(response.status).toBe(200);
    expect(await response.text()).toBe('initialized');
  });

  it('does not buffer MCP SSE reads even if a client supplies an operation id', async () => {
    const storage = new MemoryStorage();
    const response = await forwardWithJournal(
      new Request('https://memory.example/mcp', {
        method: 'GET',
        headers: { [OPERATION_HEADER]: 'op-read', [TENANT_HEADER]: 'tenant-a' },
      }),
      storage,
      async () => new Response('event: ready\n\n', { headers: { 'content-type': 'text/event-stream' } }),
    );

    expect(response.headers.get('content-type')).toBe('text/event-stream');
    expect(await new TenantJournal(storage, 'tenant-a').get('op-read')).toBeUndefined();
  });

  it('rejects malformed operation ids before forwarding', async () => {
    let forwards = 0;
    const response = await forwardWithJournal(
      request('x'.repeat(256)),
      new MemoryStorage(),
      async () => {
        forwards++;
        return new Response('unexpected');
      },
    );

    expect(response.status).toBe(400);
    expect(forwards).toBe(0);
  });

  it('rejects a body over the durable journal limit before forwarding', async () => {
    let forwards = 0;
    const response = await forwardWithJournal(
      request('op-large', 'tenant-a', 'x'.repeat(1024 * 1024 + 1)),
      new MemoryStorage(),
      async () => {
        forwards++;
        return new Response('unexpected');
      },
    );

    expect(response.status).toBe(413);
    expect(forwards).toBe(0);
  });

  it('preserves arbitrary binary checkpoint bytes through the pending object store', async () => {
    const storage = new MemoryStorage();
    const objects = new BinaryStore();
    const expected = new Uint8Array([0, 255, 1, 128]);
    let forwarded: Uint8Array | undefined;
    const response = await forwardBinaryWithJournal(
      new Request('https://memory.example/v1/checkpoints/import', {
        method: 'PUT',
        headers: { [OPERATION_HEADER]: 'op-binary', [TENANT_HEADER]: 'tenant-a' },
        body: expected,
      }),
      storage,
      objects,
      async (request) => {
        forwarded = new Uint8Array(await request.arrayBuffer());
        return new Response('ok');
      },
    );

    expect(response.status).toBe(200);
    expect([...forwarded ?? []]).toEqual([...expected]);
  });
});
