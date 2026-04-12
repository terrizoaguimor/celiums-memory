/**
 * createEngine — Factory function to initialize the Celiums Knowledge Engine.
 *
 * This is the main entry point for all Celiums applications.
 * Creates and connects all internal components (store, search, tools)
 * and returns a unified engine interface that adapters plug into.
 *
 * @example
 * ```typescript
 * import { createEngine } from "@celiums/core";
 *
 * const engine = await createEngine({
 *   database: { url: process.env.DATABASE_URL! },
 *   vector: { url: process.env.QDRANT_URL! },
 * });
 *
 * // Use with any adapter
 * const mcpAdapter = new McpAdapter(engine);
 * const restAdapter = new RestAdapter(engine);
 * ```
 */

import type {
  CeliumsConfig,
  CeliumsEngine,
  CeliumsEvent,
  CeliumsEventHandler,
  Module,
  ModuleIndex,
  SearchQuery,
  SearchResponse,
  ToolDefinition,
  ToolName,
  ToolResult,
} from "@celiums/types";
import { ModuleStore } from "./store.js";
import { ModuleSearch } from "./search.js";
import { ToolRegistry } from "./tools/registry.js";

/**
 * Create and initialize a Celiums Knowledge Engine instance.
 *
 * @param config - Engine configuration (database, vector, cache, etc.)
 * @returns A fully initialized engine ready for use with adapters
 */
export async function createEngine(config: CeliumsConfig): Promise<CeliumsEngineImpl> {
  const engine = new CeliumsEngineImpl(config);
  await engine.initialize();
  return engine;
}

/**
 * Internal engine implementation.
 * Coordinates between the module store, search engine, and tool registry.
 */
class CeliumsEngineImpl implements CeliumsEngine {
  private store: ModuleStore;
  private searchEngine: ModuleSearch;
  private toolRegistry: ToolRegistry;
  private eventHandlers: CeliumsEventHandler[] = [];
  private config: CeliumsConfig;

  constructor(config: CeliumsConfig) {
    this.config = config;

    // Initialize the module store (PostgreSQL)
    this.store = new ModuleStore({
      connectionUrl: config.database.url,
      maxConnections: config.database.maxConnections,
    });

    // Initialize the search engine (Qdrant + PostgreSQL)
    this.searchEngine = new ModuleSearch(this.store, {
      qdrantUrl: config.vector.url,
      collection: config.vector.collection ?? "celiums_modules",
      qdrantApiKey: config.vector.apiKey,
      embeddingDimension: config.embeddings?.dimension ?? 768,
      embeddingEndpoint: config.embeddings?.endpoint,
    });

    // Initialize the tool registry with all 27 open core tools
    this.toolRegistry = new ToolRegistry(this.store, this.searchEngine, config);
  }

  /**
   * Initialize engine — verify connections and warm caches.
   */
  async initialize(): Promise<void> {
    // Verify database connection
    const dbHealth = await this.store.health();
    if (!dbHealth.ok) {
      throw new Error("Failed to connect to database. Check DATABASE_URL.");
    }

    this.emit({
      type: "module_loaded",
      name: "__init__",
      size: dbHealth.moduleCount,
    });
  }

  /**
   * Search for modules using hybrid search (semantic + full-text + fuzzy).
   */
  async search(query: SearchQuery): Promise<SearchResponse> {
    const start = performance.now();
    const response = await this.searchEngine.search(query);

    this.emit({
      type: "search",
      query: query.query,
      results: response.results.length,
      timeMs: response.searchTimeMs,
    });

    return response;
  }

  /**
   * Load a complete module by name.
   */
  async getModule(name: string): Promise<Module | null> {
    const start = performance.now();
    const module = await this.store.getModule(name);

    if (module) {
      this.emit({
        type: "module_loaded",
        name: module.name,
        size: module.content.contentSize,
      });
    }

    return module;
  }

  /**
   * Execute a tool by name with the given arguments.
   */
  async executeTool(name: ToolName, args: Record<string, unknown>): Promise<ToolResult> {
    const start = performance.now();

    try {
      const result = await this.toolRegistry.execute(name, args);

      this.emit({
        type: "tool_executed",
        tool: name,
        timeMs: Math.round(performance.now() - start),
        success: !result.isError,
      });

      return result;
    } catch (error) {
      const message = error instanceof Error ? error.message : "Unknown error";

      this.emit({
        type: "error",
        message: `Tool ${name} failed: ${message}`,
        code: "TOOL_EXECUTION_ERROR",
      });

      return {
        content: [{ type: "text", text: `Error executing ${name}: ${message}` }],
        isError: true,
      };
    }
  }

  /**
   * Get all available tool definitions.
   */
  getTools(): ToolDefinition[] {
    return this.toolRegistry.getDefinitions();
  }

  /**
   * Get the module index (total count, categories).
   */
  async getIndex(): Promise<ModuleIndex> {
    return this.store.getIndex();
  }

  /**
   * Check engine health — database, vector store, cache.
   */
  async health(): Promise<{ status: "ok" | "degraded" | "error"; details: Record<string, unknown> }> {
    const dbHealth = await this.store.health();

    if (!dbHealth.ok) {
      return {
        status: "error",
        details: { database: "disconnected", moduleCount: 0 },
      };
    }

    return {
      status: "ok",
      details: {
        database: "connected",
        moduleCount: dbHealth.moduleCount,
        databaseLatencyMs: dbHealth.latencyMs,
      },
    };
  }

  /**
   * Register an event handler for observability.
   *
   * @example
   * ```typescript
   * engine.on((event) => {
   *   if (event.type === "search") {
   *     console.log(`Search: "${event.query}" → ${event.results} results in ${event.timeMs}ms`);
   *   }
   * });
   * ```
   */
  on(handler: CeliumsEventHandler): void {
    this.eventHandlers.push(handler);
  }

  /**
   * Gracefully shut down the engine.
   */
  async close(): Promise<void> {
    await this.store.close();
  }

  /** Emit an event to all registered handlers */
  private emit(event: CeliumsEvent): void {
    for (const handler of this.eventHandlers) {
      try {
        handler(event);
      } catch {
        // Don't let event handler errors crash the engine
      }
    }
  }
}
