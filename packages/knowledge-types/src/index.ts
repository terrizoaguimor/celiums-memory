/**
 * @celiums/types — Shared type definitions for the Celiums Knowledge Engine
 *
 * This package defines all core types used across the Celiums ecosystem.
 * Every adapter, SDK, and tool references these types for consistency.
 *
 * @package @celiums/types
 * @license Apache-2.0
 */

// ──────────────────────────────────────────────────────────────
// Module Types — The fundamental unit of knowledge in Celiums
// ──────────────────────────────────────────────────────────────

/**
 * Metadata for a single knowledge module.
 * This is the lightweight representation used for search results
 * and index operations. Content is loaded separately.
 */
export interface ModuleMeta {
  /** Unique identifier slug (lowercase, hyphens, max 80 chars) */
  name: string;

  /** Human-readable display name (Title Case) */
  displayName: string;

  /** Brief description of what this module covers (max 300 chars) */
  description: string;

  /** Primary category for classification */
  category: string;

  /** Searchable keywords extracted from name + description + content */
  keywords: string[];

  /** Number of lines in the module content */
  lineCount: number;

  /** Whether this module has supplementary reference documents */
  hasReferences: boolean;

  /** Number of reference documents attached */
  referenceCount: number;

  /** Quality evaluation score (0-10, null if not evaluated) */
  evalScore: number | null;

  /** Module content version */
  version: string;
}

/**
 * Full module content including the main document and references.
 * Returned by the `absorb` tool when loading a complete module.
 */
export interface ModuleContent {
  /** The main MODULE.md content (markdown) */
  content: string;

  /** Supplementary reference documents keyed by filename */
  references: Record<string, string>;

  /** Content size in bytes */
  contentSize: number;

  /** SHA-256 hash of the content for change detection */
  contentHash: string;
}

/**
 * Complete module including metadata and content.
 */
export interface Module extends ModuleMeta {
  /** Full module content and references */
  content: ModuleContent;
}

/**
 * The complete module index — a searchable catalog of all modules.
 */
export interface ModuleIndex {
  /** Total number of modules in the index */
  totalModules: number;

  /** All module categories with their counts */
  categories: Record<string, number>;

  /** Array of all module metadata for search */
  modules: ModuleMeta[];

  /** ISO timestamp of when this index was last built */
  lastUpdated: string;

  /** Index format version for backward compatibility */
  indexVersion: string;
}

// ──────────────────────────────────────────────────────────────
// Search Types — Query and result structures
// ──────────────────────────────────────────────────────────────

/**
 * A search query for finding modules.
 */
export interface SearchQuery {
  /** The search text (natural language or keywords) */
  query: string;

  /** Maximum number of results to return (default: 10) */
  maxResults?: number;

  /** Filter by category */
  category?: string;

  /** Minimum relevance score (0-100) */
  minScore?: number;

  /** Search method preference */
  method?: "semantic" | "keyword" | "hybrid";
}

/**
 * A single search result with relevance scoring.
 */
export interface SearchResult {
  /** Module metadata */
  module: ModuleMeta;

  /** Relevance score (0-100, higher is better) */
  score: number;

  /** Which search method produced this result */
  matchedBy: "semantic" | "keyword" | "exact";

  /** Brief snippet showing why this result matched */
  snippet?: string;
}

/**
 * Response from a search operation.
 */
export interface SearchResponse {
  /** Matching results sorted by relevance */
  results: SearchResult[];

  /** Total number of matches (before pagination) */
  totalMatches: number;

  /** Time taken to search in milliseconds */
  searchTimeMs: number;

  /** Which search methods were used */
  methods: ("semantic" | "keyword" | "exact")[];
}

// ──────────────────────────────────────────────────────────────
// Tool Types — MCP and adapter tool definitions
// ──────────────────────────────────────────────────────────────

/** All available tool names in the Celiums engine */
export type ToolName =
  // Discovery
  | "forage"
  | "absorb"
  | "map_network"
  | "sense"
  // Generation
  | "synthesize"
  | "bloom"
  | "cultivate"
  | "pollinate"
  | "decompose"
  // Context
  | "germinate"
  | "photosynthesize"
  | "transpire"
  // Setup
  | "establish"
  // Build
  | "construct"
  | "construct_status"
  // Collaboration
  | "room_create"
  | "room_join"
  | "room_invite"
  | "room_status"
  | "room_sync"
  | "room_push"
  // Snapshots
  | "snapshot_save"
  | "snapshot_load"
  | "snapshot_list"
  // Context Cloud
  | "context_save"
  | "context_load"
  | "context_list";

/**
 * Tool definition exposed to adapters and clients.
 */
export interface ToolDefinition {
  /** Unique tool name */
  name: ToolName;

  /** Human-readable description */
  description: string;

  /** JSON Schema for the tool's input parameters */
  inputSchema: {
    type: "object";
    properties?: Record<string, unknown>;
    required?: string[];
  };

  /** Whether this tool requires AI inference (Fleet) */
  requiresInference: boolean;

  /** Tool category for grouping */
  category: "discovery" | "generation" | "context" | "setup" | "build" | "collaboration" | "snapshots" | "cloud";
}

/**
 * Result from executing a tool.
 */
export interface ToolResult {
  /** Array of content blocks (text, images, etc.) */
  content: ToolResultContent[];

  /** Whether the tool execution was successful */
  isError?: boolean;
}

export interface ToolResultContent {
  type: "text" | "image" | "resource";
  text?: string;
  data?: string;
  mimeType?: string;
}

// ──────────────────────────────────────────────────────────────
// Configuration Types
// ──────────────────────────────────────────────────────────────

/**
 * Celiums engine configuration.
 * Can be provided via environment variables, config file, or programmatically.
 */
export interface CeliumsConfig {
  /** Database connection */
  database: {
    /** PostgreSQL connection URL */
    url: string;
    /** Maximum connection pool size (default: 20) */
    maxConnections?: number;
  };

  /** Vector search engine */
  vector: {
    /** Qdrant server URL */
    url: string;
    /** Collection name (default: "celiums_modules") */
    collection?: string;
    /** API key for Qdrant (optional) */
    apiKey?: string;
  };

  /** Cache configuration */
  cache?: {
    /** Redis/Valkey connection URL */
    url?: string;
    /** Default TTL in seconds (default: 3600) */
    defaultTtl?: number;
  };

  /** Embedding model configuration */
  embeddings: {
    /** Model name (default: "nomic-ai/nomic-embed-text-v1.5") */
    model?: string;
    /** Embedding dimension (default: 768) */
    dimension?: number;
    /** API endpoint for remote embedding */
    endpoint?: string;
  };

  /** AI inference configuration (optional — for generation tools) */
  inference?: {
    /** Default model for generation */
    defaultModel?: string;
    /** API endpoint (OpenAI-compatible inference endpoint) */
    endpoint?: string;
    /** API key */
    apiKey?: string;
  };

  /** Server configuration */
  server?: {
    /** Port to listen on (default: 3000) */
    port?: number;
    /** Host to bind to (default: "0.0.0.0") */
    host?: string;
    /** Enable CORS (default: true) */
    cors?: boolean;
  };

  /** Logging configuration */
  logging?: {
    /** Log level (default: "info") */
    level?: "debug" | "info" | "warn" | "error";
    /** Log format (default: "json") */
    format?: "json" | "pretty";
  };
}

// ──────────────────────────────────────────────────────────────
// Adapter Types — For building custom protocol adapters
// ──────────────────────────────────────────────────────────────

/**
 * Interface that all protocol adapters must implement.
 * Adapters translate between external protocols (MCP, REST, A2A)
 * and the core Celiums engine.
 */
export interface CeliumsAdapter {
  /** Unique adapter name */
  name: string;

  /** Initialize the adapter with the engine instance */
  initialize(engine: CeliumsEngine): Promise<void>;

  /** Start listening for requests */
  start(): Promise<void>;

  /** Gracefully shut down the adapter */
  stop(): Promise<void>;
}

/**
 * The core engine interface that adapters interact with.
 * This is the contract between the engine and all adapters.
 */
export interface CeliumsEngine {
  /** Search for modules */
  search(query: SearchQuery): Promise<SearchResponse>;

  /** Load a complete module by name */
  getModule(name: string): Promise<Module | null>;

  /** Execute a tool by name with arguments */
  executeTool(name: ToolName, args: Record<string, unknown>): Promise<ToolResult>;

  /** Get all available tool definitions */
  getTools(): ToolDefinition[];

  /** Get the module index (categories, counts) */
  getIndex(): Promise<ModuleIndex>;

  /** Check engine health */
  health(): Promise<{ status: "ok" | "degraded" | "error"; details: Record<string, unknown> }>;
}

// ──────────────────────────────────────────────────────────────
// Event Types — For observability and plugins
// ──────────────────────────────────────────────────────────────

/** Events emitted by the engine for observability */
export type CeliumsEvent =
  | { type: "search"; query: string; results: number; timeMs: number }
  | { type: "module_loaded"; name: string; size: number }
  | { type: "tool_executed"; tool: ToolName; timeMs: number; success: boolean }
  | { type: "error"; message: string; code: string }
  | { type: "cache_hit"; key: string }
  | { type: "cache_miss"; key: string };

/** Event handler function */
export type CeliumsEventHandler = (event: CeliumsEvent) => void;
