// HTTP client for the Celiums Memory engine.
//
// All endpoints are reachable on a single host; the extension proxies
// recall/remember directly via REST, while MCP tool calls are owned by
// the host editor's own MCP runtime once we register the server.

interface RecallHit {
  id: string;
  content: string;
  score?: number;
  createdAt?: string;
  metadata?: Record<string, unknown>;
}

export class CeliumsClient {
  constructor(
    private readonly url: string,
    private readonly apiKey: string,
    private readonly userId: string,
  ) {}

  private headers(): Record<string, string> {
    return {
      'Content-Type': 'application/json',
      'Authorization': `Bearer ${this.apiKey}`,
    };
  }

  // /health is public — no auth required. We use it as a connectivity
  // probe before saving credentials so the user gets a real error
  // instead of a silent "saved but everything 401s" experience.
  async ping(): Promise<{ ok: boolean; detail?: string }> {
    try {
      const res = await fetch(`${this.url.replace(/\/$/, '')}/health`, {
        method: 'GET',
      });
      if (!res.ok) return { ok: false, detail: `HTTP ${res.status}` };
      return { ok: true };
    } catch (e) {
      return { ok: false, detail: (e as Error).message };
    }
  }

  // Authenticated probe: confirms the API key is recognised. Hits
  // /recall with an empty query, which the engine accepts
  // but returns nothing for.
  async authProbe(): Promise<{ ok: boolean; status: number; detail?: string }> {
    try {
      const res = await fetch(`${this.url.replace(/\/$/, '')}/recall`, {
        method: 'POST',
        headers: this.headers(),
        body: JSON.stringify({ userId: this.userId, query: 'ping', limit: 1 }),
      });
      if (res.status === 401 || res.status === 403) {
        return { ok: false, status: res.status, detail: 'API key rejected' };
      }
      if (!res.ok) return { ok: false, status: res.status, detail: await res.text() };
      return { ok: true, status: res.status };
    } catch (e) {
      return { ok: false, status: 0, detail: (e as Error).message };
    }
  }

  async recall(query: string, limit = 10): Promise<RecallHit[]> {
    const res = await fetch(`${this.url.replace(/\/$/, '')}/recall`, {
      method: 'POST',
      headers: this.headers(),
      body: JSON.stringify({ userId: this.userId, query, limit }),
    });
    if (!res.ok) throw new Error(`recall failed: HTTP ${res.status} — ${await res.text()}`);
    const data = await res.json() as { results?: RecallHit[]; memories?: RecallHit[] };
    return data.results ?? data.memories ?? [];
  }

  async remember(content: string, metadata?: Record<string, unknown>): Promise<{ id?: string }> {
    const res = await fetch(`${this.url.replace(/\/$/, '')}/store`, {
      method: 'POST',
      headers: this.headers(),
      body: JSON.stringify({ userId: this.userId, content, metadata }),
    });
    if (!res.ok) throw new Error(`remember failed: HTTP ${res.status} — ${await res.text()}`);
    return await res.json() as { id?: string };
  }
}
