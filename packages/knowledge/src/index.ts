/**
 * @celiums/core — The Knowledge Engine
 *
 * Core engine that powers all Celiums adapters and tools.
 * Provides semantic search, full-text search, module retrieval,
 * and tool execution over a curated knowledge base.
 *
 * @example
 * ```typescript
 * import { createEngine } from "@celiums/core";
 *
 * const engine = await createEngine({
 *   database: { url: "postgresql://localhost:5432/celiums" },
 *   vector: { url: "http://localhost:6333" },
 * });
 *
 * const results = await engine.search({ query: "react hooks" });
 * const module = await engine.getModule("react-server-components");
 * ```
 *
 * @package @celiums/core
 * @license Apache-2.0
 */

export { createEngine } from "./engine.js";
export { ModuleStore } from "./store.js";
export { ModuleSearch } from "./search.js";
export { ToolRegistry } from "./tools/registry.js";

// Re-export types for convenience
export type {
  CeliumsEngine,
  CeliumsConfig,
  Module,
  ModuleMeta,
  ModuleContent,
  ModuleIndex,
  SearchQuery,
  SearchResponse,
  SearchResult,
  ToolDefinition,
  ToolName,
  ToolResult,
  CeliumsEvent,
  CeliumsEventHandler,
} from "@celiums/types";
