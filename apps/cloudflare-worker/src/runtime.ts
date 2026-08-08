import {
  OperationConflictError,
  TenantJournal,
  type JournalReceipt,
  type JournalStorage,
} from './journal';

export const OPERATION_HEADER = 'x-celiums-operation-id';
export const TENANT_HEADER = 'x-celiums-tenant-id';
export const MAX_OPERATION_ID_LENGTH = 255;
export const MAX_BODY_LENGTH = 1024 * 1024;
export const MAX_BINARY_BODY_LENGTH = 512 * 1024 * 1024;

export type ForwardRequest = (request: Request) => Promise<Response>;
export type BeforeFinalize = (response: Response, operationId: string) => Promise<void>;

export interface BinaryObjectStore {
  put(key: string, value: ArrayBuffer | Uint8Array): Promise<unknown>;
  get(key: string): Promise<{ body: ReadableStream } | null>;
  delete(key: string): Promise<void>;
}

export async function forwardWithJournal(
  request: Request,
  storage: JournalStorage,
  forward: ForwardRequest,
  beforeFinalize?: BeforeFinalize,
): Promise<Response> {
  if (request.method === 'GET' || request.method === 'HEAD') return forward(request);

  const body = await request.text();
  if (new TextEncoder().encode(body).byteLength > MAX_BODY_LENGTH) {
    return Response.json({ error: { code: 'body_too_large' } }, { status: 413 });
  }

  const forwardedRequest = requestWithBody(request, body);
  if (!requestNeedsJournal(request, body)) return forward(forwardedRequest);

  let operationId: string | null;
  try {
    operationId = operationIdFromRequest(request);
  } catch {
    return Response.json({ error: { code: 'invalid_operation_id' } }, { status: 400 });
  }
  if (!operationId) {
    return Response.json({ error: { code: 'operation_id_required' } }, { status: 400 });
  }

  const tenantId = request.headers.get(TENANT_HEADER);
  if (!tenantId) return Response.json({ error: { code: 'tenant_required' } }, { status: 400 });

  const journal = new TenantJournal(storage, tenantId);
  const prepared = await journal.prepare({
    operationId,
    tenantId,
    method: request.method,
    path: new URL(request.url).pathname + new URL(request.url).search,
    body,
    bodyHash: await sha256(body),
    mcpSessionId: request.headers.get('mcp-session-id') ?? undefined,
    createdAtMs: Date.now(),
  });

  if (prepared.reused) {
    if (prepared.command.status !== 'pending' && prepared.command.receipt) {
      return responseFromReceipt(prepared.command.receipt);
    }
  }

  const response = await forward(forwardedRequest);
  if (beforeFinalize) await beforeFinalize(response.clone(), operationId);
  const receipt = await receiptFromResponse(response);
  const terminalStatus = response.ok ? 'applied' : 'rejected';

  try {
    await journal.finalize(operationId, terminalStatus, receipt);
  } catch (error) {
    if (error instanceof OperationConflictError) throw error;
    return Response.json({ error: { code: 'receipt_persist_failed' } }, { status: 503 });
  }

  return responseFromReceipt(receipt);
}

export async function forwardBinaryWithJournal(
  request: Request,
  storage: JournalStorage,
  objectStore: BinaryObjectStore,
  forward: ForwardRequest,
): Promise<Response> {
  const operationId = request.headers.get(OPERATION_HEADER);
  if (!operationId || operationId.length > MAX_OPERATION_ID_LENGTH) {
    return Response.json({ error: { code: 'operation_id_required' } }, { status: 400 });
  }
  const tenantId = request.headers.get(TENANT_HEADER);
  if (!tenantId) return Response.json({ error: { code: 'tenant_required' } }, { status: 400 });

  const bytes = new Uint8Array(await request.arrayBuffer());
  if (bytes.byteLength > MAX_BINARY_BODY_LENGTH) {
    return Response.json({ error: { code: 'body_too_large' } }, { status: 413 });
  }
  const bodyRef = `pending/${encodeURIComponent(tenantId)}/${encodeURIComponent(operationId)}.bin`;
  const prepared = await new TenantJournal(storage, tenantId).prepare({
    operationId,
    tenantId,
    method: request.method,
    path: new URL(request.url).pathname,
    body: '',
    bodyHash: await sha256Bytes(bytes),
    bodyRef,
    contentType: request.headers.get('content-type') ?? undefined,
    mcpSessionId: request.headers.get('mcp-session-id') ?? undefined,
    createdAtMs: Date.now(),
  });
  if (prepared.reused && prepared.command.status !== 'pending' && prepared.command.receipt) {
    return responseFromReceipt(prepared.command.receipt);
  }

  await objectStore.put(bodyRef, bytes);
  const pendingObject = await objectStore.get(bodyRef);
  if (!pendingObject) return Response.json({ error: { code: 'checkpoint_missing' } }, { status: 503 });
  const response = await forward(new Request(request, { body: pendingObject.body, duplex: 'half' } as RequestInit));
  const receipt = await receiptFromResponse(response);
  await new TenantJournal(storage, tenantId).finalize(
    operationId,
    response.ok ? 'applied' : 'rejected',
    receipt,
  );
  await objectStore.delete(bodyRef);
  return responseFromReceipt(receipt);
}

function operationIdFromRequest(request: Request): string | null {
  const operationId = request.headers.get(OPERATION_HEADER);
  if (!operationId) return null;
  if (operationId.length > MAX_OPERATION_ID_LENGTH || /[\u0000-\u001f\u007f]/.test(operationId)) {
    throw new Error('invalid operation id');
  }
  return operationId;
}

function requestNeedsJournal(request: Request, body: string): boolean {
  if (new URL(request.url).pathname !== '/mcp') return true;

  try {
    const message = JSON.parse(body) as { method?: string };
    return ![
      'initialize',
      'notifications/initialized',
      'ping',
      'tools/list',
      'resources/list',
      'resources/templates/list',
      'resources/read',
      'resources/subscribe',
      'resources/unsubscribe',
    ].includes(message.method ?? '');
  } catch {
    return true;
  }
}

function requestWithBody(request: Request, body: string): Request {
  if (request.method === 'GET' || request.method === 'HEAD') return request;
  return new Request(request.url, {
    method: request.method,
    headers: request.headers,
    body,
  });
}

async function sha256(value: string): Promise<string> {
  return sha256Bytes(new TextEncoder().encode(value));
}

async function sha256Bytes(value: Uint8Array): Promise<string> {
  const digest = await crypto.subtle.digest('SHA-256', value);
  return [...new Uint8Array(digest)].map((byte) => byte.toString(16).padStart(2, '0')).join('');
}

async function receiptFromResponse(response: Response): Promise<JournalReceipt> {
  const body = await response.text();
  return {
    status: response.status,
    statusText: response.statusText,
    headers: Object.fromEntries(response.headers),
    body,
  };
}

function responseFromReceipt(receipt: JournalReceipt): Response {
  return new Response(receipt.body, {
    status: receipt.status,
    statusText: receipt.statusText,
    headers: receipt.headers,
  });
}
