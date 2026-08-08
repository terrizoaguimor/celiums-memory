import { describe, expect, it } from 'vitest';
import { checkpointArtifact, persistCheckpoint, type CheckpointStore } from './checkpoint';

class MemoryStore implements CheckpointStore {
  private readonly values = new Map<string, unknown>();
  private readonly objects = new Map<string, ReadableStream>();

  async put(key: string, value: ReadableStream | ArrayBuffer | string): Promise<unknown> {
    if (value instanceof ReadableStream) this.objects.set(key, value);
    else this.values.set(key, value);
    return undefined;
  }

  async get(key: string): Promise<{ body: ReadableStream } | null> {
    const body = this.objects.get(key);
    return body ? { body } : null;
  }

  async delete(key: string): Promise<void> {
    this.objects.delete(key);
  }

  async pointer<T>(key: string): Promise<T | undefined> {
    return this.values.get(key) as T | undefined;
  }

  async pointerPut<T>(key: string, value: T): Promise<void> {
    this.values.set(key, value);
  }
}

function pointers(store: MemoryStore) {
  return {
    get: <Value>(key: string) => store.pointer<Value>(key),
    put: <Value>(key: string, value: Value) => store.pointerPut(key, value),
  };
}

describe('checkpoint R2 bridge', () => {
  it('stores the artifact before advancing the active pointer', async () => {
    const store = new MemoryStore();
    const pointer = await persistCheckpoint(
      'tenant/a',
      pointers(store),
      store,
      {
        checkpointId: 'cp-1',
        checkpointSequence: 7,
        snapshotDigest: 'digest',
        ciphertextBlake3: 'ciphertext',
        ciphertextBytes: 3,
        plaintextBytes: 3,
        createdAtMs: 1,
      },
      new Response(new ReadableStream({ start(controller) { controller.enqueue(new Uint8Array([1, 2, 3])); controller.close(); } })),
    );

    expect(pointer.r2Key).toBe('tenants/tenant%2Fa/checkpoints/cp-1.bin');
    expect(await store.pointer('checkpoint:active')).toEqual(pointer);
  });

  it('serves the active artifact without exposing an internal path', async () => {
    const store = new MemoryStore();
    await persistCheckpoint(
      'tenant-a',
      pointers(store),
      store,
      {
        checkpointId: 'cp-1', checkpointSequence: 1, snapshotDigest: 'digest',
        ciphertextBlake3: 'cipher', ciphertextBytes: 2, plaintextBytes: 2, createdAtMs: 1,
      },
      new Response(new Uint8Array([4, 5])),
    );

    const response = await checkpointArtifact(
      pointers(store),
      store,
    );
    expect(response.status).toBe(200);
    expect(response.headers.get('content-type')).toBe('application/vnd.celiums.checkpoint');
    expect(response.headers.get('x-celiums-checkpoint-sequence')).toBe('1');
  });

  it('retains only the newest checkpoint pointers', async () => {
    const store = new MemoryStore();
    const pointerStorage = pointers(store);
    const bucket = store;
    for (let sequence = 1; sequence <= 4; sequence++) {
      await persistCheckpoint('tenant-a', pointerStorage, bucket, {
        checkpointId: `cp-${sequence}`,
        checkpointSequence: sequence,
        snapshotDigest: `digest-${sequence}`,
        ciphertextBlake3: `cipher-${sequence}`,
        ciphertextBytes: 1,
        plaintextBytes: 1,
        createdAtMs: sequence,
      }, new Response(new Uint8Array([sequence])));
    }

    const history = await store.pointer<Array<{ checkpointId: string }>>('checkpoint:history');
    expect(history?.map((entry) => entry.checkpointId)).toEqual(['cp-4', 'cp-3', 'cp-2']);
  });
});
