/**
 * @celiums/adapter-rest — REST API adapter (OpenAI-compatible)
 *
 * Exposes the Celiums Knowledge Engine as a REST API that follows
 * the OpenAI API format. Any application that works with OpenAI's
 * API can work with Celiums by changing the base URL.
 *
 * Endpoints:
 * - GET  /health                          → Engine health check
 * - GET  /v1/modules                      → List/search modules
 * - GET  /v1/modules/:name               → Get module by name
 * - POST /v1/modules/search              → Semantic search
 * - GET  /v1/categories                   → List all categories
 * - POST /v1/tools/:name                 → Execute a tool
 * - GET  /v1/tools                        → List available tools
 * - POST /v1/chat/completions            → OpenAI-compatible chat (with knowledge injection)
 *
 * @example
 * ```typescript
 * import { createEngine } from "@celiums/core";
 * import { RestAdapter } from "@celiums/adapter-rest";
 *
 * const engine = await createEngine(config);
 * const rest = new RestAdapter(engine, { port: 3000 });
 * await rest.start();
 * // API available at http://localhost:3000
 * ```
 *
 * @package @celiums/adapter-rest
 * @license Apache-2.0
 */

import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import type { CeliumsEngine, CeliumsAdapter, ToolName } from "@celiums/types";

export interface RestAdapterConfig {
  /** Port to listen on (default: 3000) */
  port?: number;
  /** Host to bind to (default: "0.0.0.0") */
  host?: string;
  /** Enable CORS headers (default: true) */
  cors?: boolean;
}

export class RestAdapter implements CeliumsAdapter {
  name = "rest";
  private engine: CeliumsEngine;
  private config: RestAdapterConfig;
  private server: ReturnType<typeof createServer> | null = null;

  constructor(engine: CeliumsEngine, config: RestAdapterConfig = {}) {
    this.engine = engine;
    this.config = config;
  }

  async initialize(engine: CeliumsEngine): Promise<void> {
    this.engine = engine;
  }

  /**
   * Start the REST API server.
   */
  async start(): Promise<void> {
    const port = this.config.port ?? 3000;
    const host = this.config.host ?? "0.0.0.0";

    this.server = createServer(async (req, res) => {
      // CORS headers
      if (this.config.cors !== false) {
        res.setHeader("Access-Control-Allow-Origin", "*");
        res.setHeader("Access-Control-Allow-Methods", "GET, POST, OPTIONS");
        res.setHeader("Access-Control-Allow-Headers", "Content-Type, Authorization");
        if (req.method === "OPTIONS") {
          res.writeHead(204);
          res.end();
          return;
        }
      }

      try {
        await this.route(req, res);
      } catch (error) {
        const message = error instanceof Error ? error.message : "Internal server error";
        this.json(res, 500, { error: { message, type: "internal_error" } });
      }
    });

    return new Promise((resolve) => {
      this.server!.listen(port, host, () => {
        console.log(`Celiums REST API listening on http://${host}:${port}`);
        resolve();
      });
    });
  }

  async stop(): Promise<void> {
    return new Promise((resolve) => {
      if (this.server) {
        this.server.close(() => resolve());
      } else {
        resolve();
      }
    });
  }

  // ──────────────────────────────────────────────────────────
  // Router
  // ──────────────────────────────────────────────────────────

  private async route(req: IncomingMessage, res: ServerResponse): Promise<void> {
    const url = new URL(req.url ?? "/", `http://${req.headers.host ?? "localhost"}`);
    const path = url.pathname;
    const method = req.method ?? "GET";

    // Health check
    if (path === "/health" && method === "GET") {
      return this.handleHealth(res);
    }

    // Module search
    if (path === "/v1/modules/search" && method === "POST") {
      const body = await this.readBody(req);
      return this.handleSearch(res, body);
    }

    // Get module by name
    if (path.startsWith("/v1/modules/") && method === "GET") {
      const name = path.slice("/v1/modules/".length);
      return this.handleGetModule(res, name);
    }

    // List modules (with optional query param search)
    if (path === "/v1/modules" && method === "GET") {
      const query = url.searchParams.get("q");
      const category = url.searchParams.get("category");
      const limit = parseInt(url.searchParams.get("limit") ?? "10", 10);
      return this.handleListModules(res, query, category, limit);
    }

    // List categories
    if (path === "/v1/categories" && method === "GET") {
      return this.handleCategories(res);
    }

    // List tools
    if (path === "/v1/tools" && method === "GET") {
      return this.handleListTools(res);
    }

    // Execute tool
    if (path.startsWith("/v1/tools/") && method === "POST") {
      const toolName = path.slice("/v1/tools/".length) as ToolName;
      const body = await this.readBody(req);
      return this.handleExecuteTool(res, toolName, body);
    }

    // OpenAI-compatible chat completions
    if (path === "/v1/chat/completions" && method === "POST") {
      const body = await this.readBody(req);
      return this.handleChatCompletions(res, body);
    }

    // 404
    this.json(res, 404, { error: { message: "Not found", type: "not_found" } });
  }

  // ──────────────────────────────────────────────────────────
  // Handlers
  // ──────────────────────────────────────────────────────────

  private async handleHealth(res: ServerResponse): Promise<void> {
    const health = await this.engine.health();
    this.json(res, health.status === "ok" ? 200 : 503, health);
  }

  private async handleSearch(res: ServerResponse, body: Record<string, unknown>): Promise<void> {
    const query = body.query as string;
    if (!query) {
      return this.json(res, 400, { error: { message: "Missing 'query' field", type: "invalid_request" } });
    }

    const results = await this.engine.search({
      query,
      maxResults: (body.max_results as number) ?? 10,
      category: body.category as string | undefined,
      method: body.method as "semantic" | "keyword" | "hybrid" | undefined,
    });

    this.json(res, 200, results);
  }

  private async handleGetModule(res: ServerResponse, name: string): Promise<void> {
    const module = await this.engine.getModule(decodeURIComponent(name));
    if (!module) {
      return this.json(res, 404, { error: { message: `Module "${name}" not found`, type: "not_found" } });
    }
    this.json(res, 200, { module });
  }

  private async handleListModules(
    res: ServerResponse,
    query: string | null,
    category: string | null,
    limit: number
  ): Promise<void> {
    if (query) {
      const results = await this.engine.search({ query, maxResults: limit, category: category ?? undefined });
      return this.json(res, 200, results);
    }

    const index = await this.engine.getIndex();
    this.json(res, 200, {
      totalModules: index.totalModules,
      categories: index.categories,
    });
  }

  private async handleCategories(res: ServerResponse): Promise<void> {
    const index = await this.engine.getIndex();
    this.json(res, 200, { categories: index.categories });
  }

  private async handleListTools(res: ServerResponse): Promise<void> {
    const tools = this.engine.getTools();
    this.json(res, 200, {
      tools: tools.map((t) => ({
        name: t.name,
        description: t.description,
        category: t.category,
        requiresInference: t.requiresInference,
      })),
    });
  }

  private async handleExecuteTool(
    res: ServerResponse,
    toolName: ToolName,
    body: Record<string, unknown>
  ): Promise<void> {
    const result = await this.engine.executeTool(toolName, body);
    this.json(res, result.isError ? 400 : 200, result);
  }

  /**
   * OpenAI-compatible /v1/chat/completions endpoint.
   *
   * Automatically searches for relevant modules based on the user's
   * message and injects them into the context before responding.
   */
  private async handleChatCompletions(
    res: ServerResponse,
    body: Record<string, unknown>
  ): Promise<void> {
    const messages = body.messages as Array<{ role: string; content: string }>;
    if (!messages || messages.length === 0) {
      return this.json(res, 400, { error: { message: "Missing 'messages' array", type: "invalid_request" } });
    }

    // Extract the last user message for knowledge search
    const lastUserMessage = [...messages].reverse().find((m) => m.role === "user");
    if (!lastUserMessage) {
      return this.json(res, 400, { error: { message: "No user message found", type: "invalid_request" } });
    }

    // Search for relevant modules
    const searchResults = await this.engine.search({
      query: lastUserMessage.content,
      maxResults: 3,
    });

    // Build knowledge context from top results
    let knowledgeContext = "";
    if (searchResults.results.length > 0) {
      const moduleNames = searchResults.results.map((r) => r.module.name);
      const modules = await Promise.all(
        moduleNames.map((name) => this.engine.getModule(name))
      );

      const validModules = modules.filter(Boolean);
      if (validModules.length > 0) {
        knowledgeContext = validModules
          .map((m) => `## ${m!.displayName}\n\n${m!.content.content.slice(0, 3000)}`)
          .join("\n\n---\n\n");
      }
    }

    // Return the knowledge context as a response
    // (The actual LLM call is handled by the client or a separate inference layer)
    this.json(res, 200, {
      id: `celiums-${Date.now()}`,
      object: "chat.completion",
      created: Math.floor(Date.now() / 1000),
      model: "celiums-knowledge",
      choices: [
        {
          index: 0,
          message: {
            role: "assistant",
            content: knowledgeContext || "No relevant modules found for your query.",
          },
          finish_reason: "stop",
        },
      ],
      usage: {
        prompt_tokens: 0,
        completion_tokens: 0,
        total_tokens: 0,
      },
      _celiums: {
        modules_used: searchResults.results.map((r) => r.module.name),
        search_time_ms: searchResults.searchTimeMs,
      },
    });
  }

  // ──────────────────────────────────────────────────────────
  // Helpers
  // ──────────────────────────────────────────────────────────

  private json(res: ServerResponse, status: number, data: unknown): void {
    res.writeHead(status, { "Content-Type": "application/json" });
    res.end(JSON.stringify(data));
  }

  private async readBody(req: IncomingMessage): Promise<Record<string, unknown>> {
    return new Promise((resolve) => {
      let body = "";
      req.on("data", (chunk) => { body += chunk; });
      req.on("end", () => {
        try {
          resolve(JSON.parse(body));
        } catch {
          resolve({});
        }
      });
    });
  }
}

/**
 * Create and start a REST API adapter.
 */
export async function startRest(
  engine: CeliumsEngine,
  config?: RestAdapterConfig
): Promise<RestAdapter> {
  const adapter = new RestAdapter(engine, config);
  await adapter.start();
  return adapter;
}
