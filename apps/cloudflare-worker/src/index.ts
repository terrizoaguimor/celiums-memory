import { Container, getContainer } from '@cloudflare/containers';
import { resolveTenant as resolveTenantFromRequest } from './auth';
import { forwardBinaryWithJournal, forwardWithJournal } from './runtime';
import { checkpointArtifact, persistCheckpoint } from './checkpoint';
import { TenantJournal } from './journal';
import type { JournalStorage, JournalTransaction } from './journal';

interface Env {
  TENANT_RUNTIME: DurableObjectNamespace<TenantRuntimeDO>;
  MYCELIUM_API_KEYS?: string;
  CELIUMS_API_KEY_PEPPER?: string;
  CELIUMS_CONFIRMATION_SECRET?: string;
  CHECKPOINTS: R2Bucket;
  CHECKPOINT_JOBS?: Queue<CheckpointJob>;
  CELIUMS_CHECKPOINT_KEY_HEX?: string;
  CELIUMS_INTERNAL_API_KEY?: string;
}

interface CheckpointJob {
  tenantId: string;
  operationId: string;
  kind: 'replay-pending' | 'checkpoint-export';
}

export class TenantRuntimeDO extends Container<Env> {
  defaultPort = 3210;
  sleepAfter = '10m';

  constructor(ctx: DurableObjectState<Env>, env: Env) {
    super(ctx, env);
    this.envVars = {
      CELIUMS_API_KEYS: env.MYCELIUM_API_KEYS ?? '',
      CELIUMS_API_KEY_PEPPER: env.CELIUMS_API_KEY_PEPPER ?? '',
      CELIUMS_CONFIRMATION_SECRET: env.CELIUMS_CONFIRMATION_SECRET ?? '',
      CELIUMS_CHECKPOINT_KEY_HEX: env.CELIUMS_CHECKPOINT_KEY_HEX ?? '',
      CELIUMS_TENANT_ID: tenantFromObjectName(ctx.id.name),
      CELIUMS_INTERNAL_API_KEY: apiKeyForTenant(env.MYCELIUM_API_KEYS, tenantFromObjectName(ctx.id.name)),
    };
  }

  async fetch(request: Request): Promise<Response> {
    return this.ctx.blockConcurrencyWhile(async () => {
      const pathname = new URL(request.url).pathname;
      if (request.method === 'GET' && pathname.startsWith('/v1/checkpoints/export/')) {
        return checkpointArtifact(
          checkpointPointerStorage(this.ctx.storage),
          this.env.CHECKPOINTS,
          pathname.split('/').pop(),
        );
      }
      const forward = (forwarded: Request) => this.containerFetch(forwarded);
      if (request.method === 'PUT' && pathname === '/v1/checkpoints/import') {
        return forwardBinaryWithJournal(
          request,
          storageAdapter(this.ctx.storage),
          this.env.CHECKPOINTS,
          forward,
        );
      }
      if (request.method === 'POST' && pathname === '/v1/checkpoints/export') {
        return forwardWithJournal(
          request,
          storageAdapter(this.ctx.storage),
          forward,
          (response) => this.persistExport(response, request),
        );
      }
      if (request.method === 'POST' && pathname === '/v1/checkpoints/replay') {
        const tenantId = request.headers.get('x-celiums-tenant-id');
        const operationId = request.headers.get('x-celiums-operation-id');
        if (!tenantId || !operationId) {
          return Response.json({ error: { code: 'operation_id_required' } }, { status: 400 });
        }
        if (this.env.CHECKPOINT_JOBS) {
          await this.env.CHECKPOINT_JOBS.send({ tenantId, operationId, kind: 'replay-pending' });
          return Response.json({ queued: true, operation_id: operationId }, { status: 202 });
        }
        return this.replayPending();
      }
      return forwardWithJournal(request, storageAdapter(this.ctx.storage), forward);
    });
  }

  private async persistExport(response: Response, request: Request): Promise<void> {
    const metadata = await response.json() as {
      checkpoint_id?: string;
      checkpoint_sequence?: number;
      snapshot_digest?: string;
      ciphertext_blake3?: string;
      ciphertext_bytes?: number;
      plaintext_bytes?: number;
    };
    if (!metadata.checkpoint_id || metadata.checkpoint_sequence === undefined ||
        !metadata.snapshot_digest || !metadata.ciphertext_blake3 ||
        metadata.ciphertext_bytes === undefined || metadata.plaintext_bytes === undefined) {
      throw new Error('checkpoint export metadata is incomplete');
    }
    const artifactResponse = await this.containerFetch(
      new Request(new URL(`/v1/checkpoints/export/${metadata.checkpoint_id}`, request.url), {
        headers: request.headers,
      }),
    );
    await persistCheckpoint(
      request.headers.get('x-celiums-tenant-id') ?? 'unknown',
      checkpointPointerStorage(this.ctx.storage),
      this.env.CHECKPOINTS,
      {
        checkpointId: metadata.checkpoint_id,
        checkpointSequence: metadata.checkpoint_sequence,
        snapshotDigest: metadata.snapshot_digest,
        ciphertextBlake3: metadata.ciphertext_blake3,
        ciphertextBytes: metadata.ciphertext_bytes,
        plaintextBytes: metadata.plaintext_bytes,
        createdAtMs: Date.now(),
      },
      artifactResponse,
    );
  }

  async replayPending(): Promise<Response> {
    const storage = storageAdapter(this.ctx.storage);
    const tenant = this.envVars?.['CELIUMS_TENANT_ID'];
    if (!tenant) return Response.json({ error: { code: 'tenant_required' } }, { status: 503 });
    const journal = new TenantJournal(storage, tenant);
    const pending = await journal.pending();
    const replayed = [];
    for (const command of pending) {
      const body = command.bodyRef ? await this.env.CHECKPOINTS.get(command.bodyRef) : undefined;
      if (command.bodyRef && !body) {
        return Response.json({ error: { code: 'checkpoint_missing' } }, { status: 503 });
      }
      const response = await this.containerFetch(new Request(`https://container${command.path}`, {
        method: command.method,
        headers: {
          Authorization: `Bearer ${this.envVars?.CELIUMS_INTERNAL_API_KEY ?? ''}`,
          'x-celiums-operation-id': command.operationId,
          'x-celiums-tenant-id': tenant,
          ...(command.contentType ? { 'content-type': command.contentType } : {}),
          ...(command.mcpSessionId ? {
            'mcp-session-id': command.mcpSessionId,
            'mcp-protocol-version': '2025-11-25',
          } : {}),
        },
        body: body?.body ?? (command.body || undefined),
      }));
      const receipt = {
        status: response.status,
        statusText: response.statusText,
        headers: Object.fromEntries(response.headers),
        body: await response.text(),
      };
      await journal.finalize(command.operationId, response.ok ? 'applied' : 'rejected', receipt);
      if (command.bodyRef) await this.env.CHECKPOINTS.delete(command.bodyRef);
      replayed.push(command.operationId);
    }
    return Response.json({ replayed });
  }

  async alarm(): Promise<void> {
    await this.replayPending();
    await this.scheduleCheckpointAlarm();
  }

  private async scheduleCheckpointAlarm(): Promise<void> {
    await this.ctx.storage.setAlarm(Date.now() + 15 * 60 * 1000);
  }
}

function checkpointPointerStorage(storage: DurableObjectStorage) {
  return {
    get: <Value>(key: string) => storage.get<Value>(key),
    put: <Value>(key: string, value: Value) => storage.put(key, value),
  };
}

function tenantFromObjectName(name: string | undefined): string {
  return name?.startsWith('tenant:') ? name.slice('tenant:'.length) : '';
}

function apiKeyForTenant(records: string | undefined, tenant: string): string {
  return records?.split(',')
    .map((record) => record.trim().split(':'))
    .find((parts) => parts.length === 5 && parts[1] === tenant)?.[0] ?? '';
}

function tenantInstance(env: Env, tenant: string): TenantRuntimeDO {
  return getContainer(env.TENANT_RUNTIME, `tenant:${tenant}`) as unknown as TenantRuntimeDO;
}

function storageAdapter(storage: DurableObjectStorage): JournalStorage {
  return {
    get: <Value>(key: string) => storage.get<Value>(key),
    list: async <Value>(prefix: string) => [...(await storage.list<Value>({ prefix })).values()],
    transaction: async <Value>(closure: (transaction: JournalTransaction) => Promise<Value>) =>
      storage.transaction((transaction) => closure({
        get: <Entry>(key: string) => transaction.get<Entry>(key),
        put: <Entry>(key: string, value: Entry) => transaction.put(key, value),
      })),
  };
}

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    const tenant = resolveTenantFromRequest(request, env);
    if (!tenant) {
      return Response.json({ error: { code: 'unauthenticated' } }, { status: 401 });
    }
    return tenantInstance(env, tenant).fetch(request);
  },

  async queue(batch: MessageBatch<CheckpointJob>, env: Env): Promise<void> {
    for (const message of batch.messages) {
      const stub = getContainer(env.TENANT_RUNTIME, `tenant:${message.body.tenantId}`) as unknown as TenantRuntimeDO;
      await stub.replayPending();
      message.ack();
    }
  },
};
