export const CHECKPOINT_PREFIX = 'tenants/';
export const CHECKPOINT_POINTER_KEY = 'checkpoint:active';
export const CHECKPOINT_HISTORY_KEY = 'checkpoint:history';
export const CHECKPOINT_RETENTION = 3;
export const CHECKPOINT_CONTENT_TYPE = 'application/vnd.celiums.checkpoint';

export interface CheckpointPointer {
  checkpointId: string;
  r2Key: string;
  checkpointSequence: number;
  snapshotDigest: string;
  ciphertextBlake3: string;
  ciphertextBytes: number;
  plaintextBytes: number;
  createdAtMs: number;
}

export interface CheckpointStore {
  put(key: string, value: ReadableStream | ArrayBuffer | string, options?: { httpMetadata?: { contentType?: string } }): Promise<unknown>;
  get(key: string): Promise<{ body: ReadableStream } | null>;
  delete(key: string): Promise<void>;
}

export interface CheckpointPointerStorage {
  get<T>(key: string): Promise<T | undefined>;
  put<T>(key: string, value: T): Promise<void>;
}

export async function persistCheckpoint(
  tenantId: string,
  pointerStorage: CheckpointPointerStorage,
  bucket: CheckpointStore,
  metadata: Omit<CheckpointPointer, 'r2Key'>,
  artifact: Response,
): Promise<CheckpointPointer> {
  if (!artifact.ok || !artifact.body) throw new Error('checkpoint export did not return an artifact');

  const pointer: CheckpointPointer = {
    ...metadata,
    r2Key: checkpointKey(tenantId, metadata.checkpointId),
  };
  await bucket.put(pointer.r2Key, artifact.body, {
    httpMetadata: { contentType: CHECKPOINT_CONTENT_TYPE },
  });
  const history = (await pointerStorage.get<CheckpointPointer[]>(CHECKPOINT_HISTORY_KEY)) ?? [];
  const retained = [pointer, ...history.filter((entry) => entry.checkpointId !== pointer.checkpointId)]
    .slice(0, CHECKPOINT_RETENTION);
  await pointerStorage.put(CHECKPOINT_POINTER_KEY, pointer);
  await pointerStorage.put(CHECKPOINT_HISTORY_KEY, retained);
  for (const expired of history.slice(CHECKPOINT_RETENTION - 1)) {
    await bucket.delete(expired.r2Key);
  }
  return pointer;
}

export async function readActiveCheckpoint(
  pointerStorage: CheckpointPointerStorage,
): Promise<CheckpointPointer | undefined> {
  return pointerStorage.get<CheckpointPointer>(CHECKPOINT_POINTER_KEY);
}

export async function checkpointArtifact(
  pointerStorage: CheckpointPointerStorage,
  bucket: Pick<CheckpointStore, 'get'>,
  checkpointId?: string,
): Promise<Response> {
  const pointer = await readActiveCheckpoint(pointerStorage);
  if (!pointer) return Response.json({ error: { code: 'checkpoint_not_found' } }, { status: 404 });
  if (checkpointId && checkpointId !== pointer.checkpointId) {
    return Response.json({ error: { code: 'checkpoint_not_found' } }, { status: 404 });
  }
  const object = await bucket.get(pointer.r2Key);
  if (!object) return Response.json({ error: { code: 'checkpoint_missing' } }, { status: 503 });

  return new Response(object.body, {
    headers: {
      'Content-Type': CHECKPOINT_CONTENT_TYPE,
      'X-Celiums-Checkpoint-Id': pointer.checkpointId,
      'X-Celiums-Checkpoint-Sequence': String(pointer.checkpointSequence),
      'X-Celiums-Snapshot-Digest': pointer.snapshotDigest,
      'X-Celiums-Ciphertext-BLAKE3': pointer.ciphertextBlake3,
    },
  });
}

function checkpointKey(tenantId: string, checkpointId: string): string {
  return `${CHECKPOINT_PREFIX}${encodeURIComponent(tenantId)}/checkpoints/${encodeURIComponent(checkpointId)}.bin`;
}
