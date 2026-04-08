import http, { IncomingMessage, ServerResponse } from 'node:http';
import { URL } from 'node:url';
import {
  MemoryConfig,
  MemoryEngine,
  RecallResponse,
  ConsolidationResult,
} from '@celiums-memory/types';
import { createMemoryEngine } from '@celiums-memory/core';

/**
 * Request body for storing a memory.
 */
interface StoreMemoryRequest {
  userId: string;
  content: string;
  source?: string;
  tags?: string[];
}

/**
 * Request body for recalling memories.
 */
interface RecallMemoriesRequest {
  userId: string;
  query: string;
  limit?: number;
  minImportance?: number;
}

/**
 * Request body for assembling context.
 */
interface ContextRequest {
  userId: string;
  currentMessage: string;
  maxTokens?: number;
}

/**
 * Request body for session consolidation.
 */
interface ConsolidateRequest {
  userId: string;
  conversation: string;
}

/**
 * Request body for deleting memories.
 */
interface DeleteMemoriesRequest {
  userId: string;
  memoryId?: string;
  all?: boolean;
}

/**
 * Generic JSON response shape.
 */
interface JsonResponse<T = unknown> {
  success: boolean;
  data?: T;
  error?: {
    message: string;
    code?: string;
    details?: unknown;
  };
}

/**
 * Server configuration.
 */
export interface ServerOptions {
  port?: number;
  host?: string;
  config?: MemoryConfig;
}

/**
 * Creates a memory config from environment variables.
 */
function configFromEnv(): MemoryConfig {
  return {
    databaseUrl: process.env.DATABASE_URL,
    qdrantUrl: process.env.QDRANT_URL,
    valkeyUrl: process.env.VALKEY_URL,
  } as MemoryConfig;
}

/**
 * Reads and parses a JSON body from an HTTP request.
 */
async function readJsonBody<T>(req: IncomingMessage): Promise<T> {
  const chunks: Buffer[] = [];

  for await (const chunk of req) {
    chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
  }

  const raw = Buffer.concat(chunks).toString('utf8');

  if (!raw.trim()) {
    return {} as T;
  }

  try {
    return JSON.parse(raw) as T;
  } catch (error) {
    const err = new Error('Invalid JSON body');
    (err as Error & { code?: string }).code = 'INVALID_JSON';
    throw err;
  }
}

/**
 * Writes a JSON response with standard headers.
 */
function sendJson<T>(
  res: ServerResponse,
  statusCode: number,
  payload: JsonResponse<T>,
): void {
  res.statusCode = statusCode;
  res.setHeader('Content-Type', 'application/json; charset=utf-8');
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET,POST,DELETE,OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization');
  res.end(JSON.stringify(payload));
}

/**
 * Sends a no-content response.
 */
function sendNoContent(res: ServerResponse): void {
  res.statusCode = 204;
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET,POST,DELETE,OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization');
  res.end();
}

/**
 * Parses a query-string number.
 */
function parseOptionalNumber(value: string | null): number | undefined {
  if (value == null || value === '') return undefined;
  const num = Number(value);
  return Number.isFinite(num) ? num : undefined;
}

/**
 * Parses a boolean-ish query string.
 */
function parseBoolean(value: string | null): boolean | undefined {
  if (value == null) return undefined;
  if (value === 'true' || value === '1') return true;
  if (value === 'false' || value === '0') return false;
  return undefined;
}

/**
 * Converts unknown errors into safe API errors.
 */
function normalizeError(error: unknown): { message: string; code?: string; details?: unknown } {
  if (error instanceof Error) {
    const anyErr = error as Error & { code?: string; details?: unknown };
    return {
      message: anyErr.message,
      code: anyErr.code,
      details: anyErr.details,
    };
  }

  return {
    message: 'Unknown error',
  };
}

/**
 * Validates a non-empty string field.
 */
function assertNonEmptyString(
  value: unknown,
  fieldName: string,
): asserts value is string {
  if (typeof value !== 'string' || value.trim().length === 0) {
    const err = new Error(`Field "${fieldName}" is required and must be a non-empty string`);
    (err as Error & { code?: string }).code = 'VALIDATION_ERROR';
    throw err;
  }
}

/**
 * Creates an HTTP server exposing the Celiums Memory REST API.
 */
export function createCeliumsMemoryServer(options: ServerOptions = {}) {
  const engine: MemoryEngine = createMemoryEngine(options.config ?? configFromEnv());
  const port = options.port ?? Number(process.env.PORT ?? 3200);
  const host = options.host ?? '0.0.0.0';

  const server = http.createServer(async (req, res) => {
    try {
      if (!req.url || !req.method) {
        sendJson(res, 400, {
          success: false,
          error: { message: 'Invalid request' },
        });
        return;
      }

      if (req.method === 'OPTIONS') {
        sendNoContent(res);
        return;
      }

      const url = new URL(req.url, `http://${req.headers.host ?? 'localhost'}`);
      const { pathname, searchParams } = url;

      if (req.method === 'GET' && pathname === '/health') {
        sendJson(res, 200, {
          success: true,
          data: {
            status: 'ok',
            service: '@celiums-memory/server',
            timestamp: new Date().toISOString(),
          },
        });
        return;
      }

      if (req.method === 'POST' && pathname === '/v1/memories/store') {
        const body = await readJsonBody<StoreMemoryRequest>(req);
        assertNonEmptyString(body.userId, 'userId');
        assertNonEmptyString(body.content, 'content');

        const result = await (engine as any).storeMemory({
          userId: body.userId,
          content: body.content,
          source: body.source ?? 'api',
          tags: Array.isArray(body.tags) ? body.tags : [],
        });

        sendJson(res, 200, {
          success: true,
          data: result,
        });
        return;
      }

      if (req.method === 'POST' && pathname === '/v1/memories/recall') {
        const body = await readJsonBody<RecallMemoriesRequest>(req);
        assertNonEmptyString(body.userId, 'userId');
        assertNonEmptyString(body.query, 'query');

        const result: RecallResponse = await (engine as any).recall({
          userId: body.userId,
          query: body.query,
          limit: typeof body.limit === 'number' ? body.limit : 10,
          minImportance:
            typeof body.minImportance === 'number' ? body.minImportance : 0,
        });

        sendJson(res, 200, {
          success: true,
          data: result,
        });
        return;
      }

      if (req.method === 'POST' && pathname === '/v1/memories/context') {
        const body = await readJsonBody<ContextRequest>(req);
        assertNonEmptyString(body.userId, 'userId');
        assertNonEmptyString(body.currentMessage, 'currentMessage');

        const result = await (engine as any).getContext({
          userId: body.userId,
          currentMessage: body.currentMessage,
          maxTokens: typeof body.maxTokens === 'number' ? body.maxTokens : 2048,
        });

        sendJson(res, 200, {
          success: true,
          data: result,
        });
        return;
      }

      if (req.method === 'POST' && pathname === '/v1/memories/consolidate') {
        const body = await readJsonBody<ConsolidateRequest>(req);
        assertNonEmptyString(body.userId, 'userId');
        assertNonEmptyString(body.conversation, 'conversation');

        const result: ConsolidationResult = await (engine as any).consolidate({
          userId: body.userId,
          conversation: body.conversation,
        });

        sendJson(res, 200, {
          success: true,
          data: result,
        });
        return;
      }

      if (req.method === 'DELETE' && pathname === '/v1/memories') {
        let body: Partial<DeleteMemoriesRequest> = {};
        try {
          body = await readJsonBody<DeleteMemoriesRequest>(req);
        } catch {
          body = {};
        }

        const userId = body.userId ?? searchParams.get('userId') ?? undefined;
        const memoryId = body.memoryId ?? searchParams.get('memoryId') ?? undefined;
        const all = body.all ?? parseBoolean(searchParams.get('all')) ?? false;

        assertNonEmptyString(userId, 'userId');

        if (!memoryId && !all) {
          const err = new Error('Provide "memoryId" or set "all" to true');
          (err as Error & { code?: string }).code = 'VALIDATION_ERROR';
          throw err;
        }

        let result: unknown;
        if (all) {
          result = await (engine as any).deleteAllMemories({ userId });
        } else {
          result = await (engine as any).deleteMemory({ userId, memoryId });
        }

        sendJson(res, 200, {
          success: true,
          data: result ?? { deleted: true, userId, memoryId: memoryId ?? null, all },
        });
        return;
      }

      if (req.method === 'GET' && pathname === '/v1/memories/stats') {
        const userId = searchParams.get('userId');
        assertNonEmptyString(userId, 'userId');

        const result = await (engine as any).getStats({ userId });

        sendJson(res, 200, {
          success: true,
          data: result,
        });
        return;
      }

      if (req.method === 'GET' && pathname === '/v1/memories/export') {
        const userId = searchParams.get('userId');
        assertNonEmptyString(userId, 'userId');

        const result = await (engine as any).exportMemories({ userId });

        sendJson(res, 200, {
          success: true,
          data: result,
        });
        return;
      }

      if (req.method === 'POST' && pathname === '/v1/memories/import') {
        const body = await readJsonBody<{ userId: string; memories: unknown[] }>(req);
        assertNonEmptyString(body.userId, 'userId');

        if (!Array.isArray(body.memories)) {
          const err = new Error('Field "memories" must be an array');
          (err as Error & { code?: string }).code = 'VALIDATION_ERROR';
          throw err;
        }

        const result = await (engine as any).importMemories({
          userId: body.userId,
          memories: body.memories,
        });

        sendJson(res, 200, {
          success: true,
          data: result,
        });
        return;
      }

      sendJson(res, 404, {
        success: false,
        error: {
          message: `Route not found: ${req.method} ${pathname}`,
          code: 'NOT_FOUND',
        },
      });
    } catch (error) {
      const normalized = normalizeError(error);
      const statusCode =
        normalized.code === 'VALIDATION_ERROR' || normalized.code === 'INVALID_JSON'
          ? 400
          : 500;

      sendJson(res, statusCode, {
        success: false,
        error: normalized,
      });
    }
  });

  return {
    server,
    engine,
    port,
    host,
    /**
     * Starts the HTTP server.
     */
    async start(): Promise<void> {
      await new Promise<void>((resolve, reject) => {
        server.once('error', reject);
        server.listen(port, host, () => {
          server.off('error', reject);
          resolve();
        });
      });
    },
    /**
     * Stops the HTTP server.
     */
    async stop(): Promise<void> {
      await new Promise<void>((resolve, reject) => {
        server.close((err) => (err ? reject(err) : resolve()));
      });
    },
  };
}

/**
 * Starts the server when the module is executed directly.
 */
export async function main(): Promise<void> {
  const app = createCeliumsMemoryServer();
  await app.start();
  process.stdout.write(
    `Celiums Memory server listening on http://${app.host}:${app.port}\n`,
  );
}

if (require.main === module) {
  main().catch((error) => {
    process.stderr.write(
      `Failed to start Celiums Memory server: ${
        error instanceof Error ? error.message : String(error)
      }\n`,
    );
    process.exit(1);
  });
}