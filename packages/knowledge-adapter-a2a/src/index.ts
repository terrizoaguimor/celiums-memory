/**
 * @celiums/adapter-a2a — Google Agent-to-Agent (A2A) protocol adapter
 *
 * Implements the A2A protocol for agent-to-agent communication.
 * While MCP connects agents to tools (vertical), A2A enables
 * agents to collaborate with each other (horizontal).
 *
 * With this adapter, Celiums acts as a specialized knowledge agent
 * that other AI agents can query for expert technical knowledge.
 *
 * A2A Protocol overview:
 * - Agents discover each other via Agent Cards (/.well-known/agent.json)
 * - Communication is task-based (natural language tasks)
 * - Agents internally decide how to interpret and execute tasks
 * - Results are returned as artifacts (text, files, structured data)
 *
 * @see https://github.com/google/A2A
 *
 * @example
 * ```typescript
 * import { createEngine } from "@celiums/core";
 * import { A2AAdapter } from "@celiums/adapter-a2a";
 *
 * const engine = await createEngine(config);
 * const a2a = new A2AAdapter(engine, { port: 3001 });
 * await a2a.start();
 * // Agent Card at http://localhost:3001/.well-known/agent.json
 * ```
 *
 * @package @celiums/adapter-a2a
 * @license Apache-2.0
 */

import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import type { CeliumsEngine, CeliumsAdapter, ToolName } from "@celiums/types";

// ──────────────────────────────────────────────────────────
// A2A Protocol Types
// ──────────────────────────────────────────────────────────

/** Agent Card — describes this agent's capabilities */
interface AgentCard {
  name: string;
  description: string;
  version: string;
  capabilities: string[];
  endpoint: string;
  protocol: "a2a";
  inputModes: string[];
  outputModes: string[];
}

/** A2A Task — the unit of work between agents */
interface A2ATask {
  id: string;
  description: string;
  input: {
    type: "text";
    content: string;
  };
  metadata?: Record<string, unknown>;
}

/** A2A Task Result */
interface A2ATaskResult {
  id: string;
  status: "completed" | "failed" | "pending";
  artifacts: Array<{
    type: "text" | "data";
    content: string;
    mimeType?: string;
  }>;
  metadata?: Record<string, unknown>;
}

export interface A2AAdapterConfig {
  port?: number;
  host?: string;
  agentName?: string;
  agentDescription?: string;
  publicUrl?: string;
}

export class A2AAdapter implements CeliumsAdapter {
  name = "a2a";
  private engine: CeliumsEngine;
  private config: A2AAdapterConfig;
  private server: ReturnType<typeof createServer> | null = null;

  constructor(engine: CeliumsEngine, config: A2AAdapterConfig = {}) {
    this.engine = engine;
    this.config = config;
  }

  async initialize(engine: CeliumsEngine): Promise<void> {
    this.engine = engine;
  }

  async start(): Promise<void> {
    const port = this.config.port ?? 3001;
    const host = this.config.host ?? "0.0.0.0";

    this.server = createServer(async (req, res) => {
      res.setHeader("Access-Control-Allow-Origin", "*");
      res.setHeader("Access-Control-Allow-Methods", "GET, POST, OPTIONS");
      res.setHeader("Access-Control-Allow-Headers", "Content-Type");

      if (req.method === "OPTIONS") {
        res.writeHead(204);
        res.end();
        return;
      }

      try {
        await this.route(req, res);
      } catch (error) {
        const msg = error instanceof Error ? error.message : "Internal error";
        this.json(res, 500, { error: msg });
      }
    });

    return new Promise((resolve) => {
      this.server!.listen(port, host, () => {
        console.log(`Celiums A2A agent listening on http://${host}:${port}`);
        console.log(`Agent Card: http://${host}:${port}/.well-known/agent.json`);
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
    const url = new URL(req.url ?? "/", `http://${req.headers.host}`);
    const path = url.pathname;

    // Agent Card discovery
    if (path === "/.well-known/agent.json" && req.method === "GET") {
      return this.handleAgentCard(res);
    }

    // Submit a task
    if (path === "/tasks" && req.method === "POST") {
      const body = await this.readBody(req);
      return this.handleTask(res, body as unknown as A2ATask);
    }

    // Health
    if (path === "/health" && req.method === "GET") {
      const health = await this.engine.health();
      return this.json(res, 200, health);
    }

    this.json(res, 404, { error: "Not found" });
  }

  // ──────────────────────────────────────────────────────────
  // Handlers
  // ──────────────────────────────────────────────────────────

  /**
   * Agent Card — tells other agents what Celiums can do.
   * Served at /.well-known/agent.json per the A2A spec.
   */
  private handleAgentCard(res: ServerResponse): void {
    const port = this.config.port ?? 3001;
    const publicUrl = this.config.publicUrl ?? `http://localhost:${port}`;

    const card: AgentCard = {
      name: this.config.agentName ?? "Celiums Knowledge Agent",
      description:
        this.config.agentDescription ??
        "Expert knowledge agent with 470,000+ curated technical modules. " +
        "Query me for programming, DevOps, AI/ML, security, databases, " +
        "cloud infrastructure, and 20+ other technical domains. " +
        "I provide production-grade knowledge, not generic tutorials.",
      version: "0.1.0",
      capabilities: [
        "technical-knowledge-search",
        "module-retrieval",
        "code-pattern-lookup",
        "architecture-guidance",
        "devops-best-practices",
        "security-recommendations",
        "database-optimization",
        "ai-ml-engineering",
      ],
      endpoint: `${publicUrl}/tasks`,
      protocol: "a2a",
      inputModes: ["text"],
      outputModes: ["text", "data"],
    };

    this.json(res, 200, card);
  }

  /**
   * Handle an incoming A2A task.
   *
   * Celiums interprets the task as a knowledge query:
   * 1. Search for relevant modules
   * 2. Load the top matches
   * 3. Return as artifacts
   */
  private async handleTask(res: ServerResponse, task: A2ATask): Promise<void> {
    if (!task.input?.content) {
      return this.json(res, 400, {
        id: task.id ?? "unknown",
        status: "failed",
        artifacts: [{ type: "text", content: "Missing task input content" }],
      });
    }

    const query = task.input.content;

    // Search for relevant modules
    const searchResults = await this.engine.search({
      query,
      maxResults: 5,
    });

    // Load full content for top results
    const artifacts: A2ATaskResult["artifacts"] = [];

    for (const result of searchResults.results.slice(0, 3)) {
      const module = await this.engine.getModule(result.module.name);
      if (module) {
        artifacts.push({
          type: "text",
          content: `# ${module.displayName}\n\n${module.content.content}`,
          mimeType: "text/markdown",
        });
      }
    }

    if (artifacts.length === 0) {
      artifacts.push({
        type: "text",
        content: `No relevant knowledge modules found for: "${query}"`,
      });
    }

    const result: A2ATaskResult = {
      id: task.id ?? `celiums-${Date.now()}`,
      status: "completed",
      artifacts,
      metadata: {
        modulesSearched: searchResults.totalMatches,
        searchTimeMs: searchResults.searchTimeMs,
        modulesReturned: artifacts.length,
      },
    };

    this.json(res, 200, result);
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
        try { resolve(JSON.parse(body)); }
        catch { resolve({}); }
      });
    });
  }
}
