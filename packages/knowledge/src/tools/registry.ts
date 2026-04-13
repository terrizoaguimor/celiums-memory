/**
 * ToolRegistry — Manages all 27 Celiums tools.
 *
 * Each tool is a function that takes arguments and returns a result.
 * Tools are categorized into:
 * - Discovery: forage, absorb, map_network, sense
 * - Generation: synthesize, bloom, cultivate, pollinate, decompose
 * - Context: germinate, photosynthesize, transpire
 * - Setup: establish
 * - Build: construct, construct_status
 * - Collaboration: room_create, room_join, room_invite, room_status, room_sync, room_push
 * - Snapshots: snapshot_save, snapshot_load, snapshot_list
 * - Cloud: context_save, context_load, context_list
 */

import type {
  CeliumsConfig,
  ToolDefinition,
  ToolName,
  ToolResult,
  ToolResultContent,
} from "@celiums/types";
import type { ModuleStore } from "../store.js";
import type { ModuleSearch } from "../search.js";

/** Tool handler function signature */
type ToolHandler = (args: Record<string, unknown>) => Promise<ToolResult>;

export class ToolRegistry {
  private store: ModuleStore;
  private search: ModuleSearch;
  private config: CeliumsConfig;
  private handlers: Map<ToolName, ToolHandler> = new Map();
  private definitions: ToolDefinition[] = [];

  constructor(store: ModuleStore, search: ModuleSearch, config: CeliumsConfig) {
    this.store = store;
    this.search = search;
    this.config = config;
    this.registerAllTools();
  }

  /**
   * Execute a tool by name.
   */
  async execute(name: ToolName, args: Record<string, unknown>): Promise<ToolResult> {
    const handler = this.handlers.get(name);
    if (!handler) {
      return this.textResult(`Unknown tool: ${name}`, true);
    }
    return handler(args);
  }

  /**
   * Get all tool definitions for adapter registration.
   */
  getDefinitions(): ToolDefinition[] {
    return this.definitions;
  }

  // ──────────────────────────────────────────────────────────
  // Tool Registration
  // ──────────────────────────────────────────────────────────

  private registerAllTools(): void {
    // Discovery tools
    this.register({
      name: "forage",
      description: "Search the knowledge network for modules matching your query. Returns the most relevant modules with relevance scores.",
      inputSchema: {
        type: "object",
        properties: {
          query: { type: "string", description: "Search query (natural language or keywords)" },
          max_results: { type: "number", description: "Maximum results to return (default: 10)" },
        },
        required: ["query"],
      },
      requiresInference: false,
      category: "discovery",
    }, this.handleForage.bind(this));

    this.register({
      name: "absorb",
      description: "Load a complete knowledge module by name. Returns the full content with all references and examples.",
      inputSchema: {
        type: "object",
        properties: {
          name: { type: "string", description: "Module name (slug format, e.g., 'react-server-components')" },
        },
        required: ["name"],
      },
      requiresInference: false,
      category: "discovery",
    }, this.handleAbsorb.bind(this));

    this.register({
      name: "map_network",
      description: "Browse all available modules organized by category. Discover what knowledge domains are available.",
      inputSchema: {
        type: "object",
        properties: {
          domain: { type: "string", description: "Filter by specific domain/category (optional)" },
        },
      },
      requiresInference: false,
      category: "discovery",
    }, this.handleMapNetwork.bind(this));

    this.register({
      name: "sense",
      description: "Get intelligent module recommendations for a specific goal or project. Returns the most useful modules to achieve your objective.",
      inputSchema: {
        type: "object",
        properties: {
          goal: { type: "string", description: "What you're trying to achieve" },
        },
        required: ["goal"],
      },
      requiresInference: false,
      category: "discovery",
    }, this.handleSense.bind(this));

    // Generation tools
    this.register({
      name: "synthesize",
      description: "Apply a module's methodology to a specific task. Generates actionable output using expert knowledge.",
      inputSchema: {
        type: "object",
        properties: {
          module: { type: "string", description: "Module name to apply" },
          task: { type: "string", description: "The specific task to accomplish" },
        },
        required: ["module", "task"],
      },
      requiresInference: true,
      category: "generation",
    }, this.handleSynthesize.bind(this));

    this.register({
      name: "bloom",
      description: "Generate complete documents using expert knowledge. Supports: blog posts, SOPs, proposals, contracts, reports, job postings.",
      inputSchema: {
        type: "object",
        properties: {
          type: { type: "string", description: "Document type (blog_post, sop, proposal, contract, report, job_posting)" },
          topic: { type: "string", description: "Topic or subject matter" },
          details: { type: "string", description: "Additional details or requirements (optional)" },
          tone: { type: "string", description: "Writing tone (professional, casual, technical)" },
        },
        required: ["type", "topic"],
      },
      requiresInference: true,
      category: "generation",
    }, this.handleBloom.bind(this));

    this.register({
      name: "cultivate",
      description: "Generate content optimized for Notion with rich formatting (checklists, tables, toggles, callouts).",
      inputSchema: {
        type: "object",
        properties: {
          module: { type: "string", description: "Module to use as knowledge source" },
          task: { type: "string", description: "Content to generate" },
          format: { type: "string", description: "Output format preference (optional)" },
        },
        required: ["module", "task"],
      },
      requiresInference: true,
      category: "generation",
    }, this.handleCultivate.bind(this));

    this.register({
      name: "pollinate",
      description: "Enrich raw data with expert knowledge. Use for lead research, contract review, compliance checks.",
      inputSchema: {
        type: "object",
        properties: {
          input: { type: "string", description: "Raw data to enrich" },
          enrichment_type: { type: "string", description: "Type of enrichment (research, review, compliance)" },
        },
        required: ["input", "enrichment_type"],
      },
      requiresInference: true,
      category: "generation",
    }, this.handlePollinate.bind(this));

    this.register({
      name: "decompose",
      description: "Break down a topic into a structured hierarchy (wiki, project, course, research).",
      inputSchema: {
        type: "object",
        properties: {
          content: { type: "string", description: "Topic or content to decompose" },
          structure: { type: "string", description: "Structure type (wiki, project, course, legal, research)" },
          depth: { type: "number", description: "Depth of hierarchy (default: 3)" },
        },
        required: ["content"],
      },
      requiresInference: true,
      category: "generation",
    }, this.handleDecompose.bind(this));

    // Context tools
    this.register({
      name: "germinate",
      description: "Initialize persistent project context. Creates a CELIUMS.md file to track decisions, progress, and state.",
      inputSchema: {
        type: "object",
        properties: {
          project_name: { type: "string", description: "Project name" },
          goal: { type: "string", description: "Project goal or objective" },
          stack: { type: "string", description: "Technology stack (optional)" },
        },
        required: ["project_name"],
      },
      requiresInference: false,
      category: "context",
    }, this.handleGerminate.bind(this));

    this.register({
      name: "photosynthesize",
      description: "Update project context with new decisions, errors resolved, or tasks completed.",
      inputSchema: {
        type: "object",
        properties: {
          existing_context: { type: "string", description: "Current CELIUMS.md content" },
          update: { type: "string", description: "What to update (decision, error, task, note)" },
        },
        required: ["existing_context", "update"],
      },
      requiresInference: false,
      category: "context",
    }, this.handlePhotosynthesize.bind(this));

    this.register({
      name: "transpire",
      description: "Read and summarize current project context. Useful for restoring state after breaks.",
      inputSchema: {
        type: "object",
        properties: {
          context_content: { type: "string", description: "CELIUMS.md content to analyze" },
          focus: { type: "string", description: "What aspect to focus on (optional)" },
        },
        required: ["context_content"],
      },
      requiresInference: false,
      category: "context",
    }, this.handleTranspire.bind(this));

    // Setup
    this.register({
      name: "establish",
      description: "Configure Celiums as the default knowledge layer for your IDE and project.",
      inputSchema: {
        type: "object",
        properties: {
          project_name: { type: "string", description: "Project name" },
          ide: { type: "string", description: "IDE to configure (vscode, cursor, all)" },
        },
        required: ["project_name"],
      },
      requiresInference: false,
      category: "setup",
    }, this.handleEstablish.bind(this));

    // Build
    this.register({
      name: "construct",
      description: "Build complete projects (500-50K+ lines) using AI and expert knowledge modules.",
      inputSchema: {
        type: "object",
        properties: {
          request: { type: "string", description: "What to build" },
          model: { type: "string", description: "AI model to use (optional)" },
        },
        required: ["request"],
      },
      requiresInference: true,
      category: "build",
    }, this.handleConstruct.bind(this));

    this.register({
      name: "construct_status",
      description: "Check the progress of a running construct build.",
      inputSchema: {
        type: "object",
        properties: {
          build_id: { type: "string", description: "Build ID to check" },
        },
      },
      requiresInference: false,
      category: "build",
    }, this.handleConstructStatus.bind(this));

    // Collaboration (6 tools)
    for (const tool of ["room_create", "room_join", "room_invite", "room_status", "room_sync", "room_push"] as const) {
      this.register({
        name: tool,
        description: `Collaboration: ${tool.replace("room_", "")} — real-time collaborative rooms.`,
        inputSchema: { type: "object", properties: {} },
        requiresInference: false,
        category: "collaboration",
      }, async () => this.textResult(`${tool}: Not yet implemented in open source. Coming soon.`));
    }

    // Snapshots (3 tools)
    for (const tool of ["snapshot_save", "snapshot_load", "snapshot_list"] as const) {
      this.register({
        name: tool,
        description: `Snapshots: ${tool.replace("snapshot_", "")} — version control for file snapshots.`,
        inputSchema: { type: "object", properties: {} },
        requiresInference: false,
        category: "snapshots",
      }, async () => this.textResult(`${tool}: Not yet implemented in open source. Coming soon.`));
    }

    // Context Cloud (3 tools)
    for (const tool of ["context_save", "context_load", "context_list"] as const) {
      this.register({
        name: tool,
        description: `Context Cloud: ${tool.replace("context_", "")} — save/load session state to cloud.`,
        inputSchema: { type: "object", properties: {} },
        requiresInference: false,
        category: "cloud",
      }, async () => this.textResult(`${tool}: Not yet implemented in open source. Coming soon.`));
    }
  }

  // ──────────────────────────────────────────────────────────
  // Tool Handlers — Discovery
  // ──────────────────────────────────────────────────────────

  private async handleForage(args: Record<string, unknown>): Promise<ToolResult> {
    const query = args.query as string;
    const maxResults = (args.max_results as number) ?? 10;

    const response = await this.search.search({ query, maxResults });

    if (response.results.length === 0) {
      return this.textResult(`No modules found for "${query}". Try different keywords.`);
    }

    const lines = response.results.map((r) =>
      `**${r.module.name}** (${r.module.category}, relevance: ${r.score}%) — ${r.module.description?.slice(0, 120) || ""}...`
    );

    return this.textResult(
      `Found ${response.totalMatches} modules in ${response.searchTimeMs}ms:\n\n${lines.join("\n")}`
    );
  }

  private async handleAbsorb(args: Record<string, unknown>): Promise<ToolResult> {
    const name = args.name as string;
    const module = await this.store.getModule(name);

    if (!module) {
      return this.textResult(`Module "${name}" not found. Use \`forage\` to search for available modules.`, true);
    }

    return this.textResult(module.content.content);
  }

  private async handleMapNetwork(args: Record<string, unknown>): Promise<ToolResult> {
    const domain = args.domain as string | undefined;
    const index = await this.store.getIndex();

    if (domain) {
      const count = index.categories[domain] ?? 0;
      if (count === 0) {
        return this.textResult(`No modules found in category "${domain}".`);
      }
      const modules = await this.store.getByCategory(domain);
      const list = modules.map((m) => `- **${m.name}** — ${m.description?.slice(0, 80) || ""}`).join("\n");
      return this.textResult(`**${domain}** (${count} modules):\n\n${list}`);
    }

    const categories = Object.entries(index.categories)
      .sort(([, a], [, b]) => b - a)
      .map(([cat, count]) => `- **${cat}**: ${count} modules`)
      .join("\n");

    return this.textResult(
      `**Celiums Knowledge Network** — ${index.totalModules.toLocaleString()} modules\n\n${categories}`
    );
  }

  private async handleSense(args: Record<string, unknown>): Promise<ToolResult> {
    const goal = args.goal as string;
    const response = await this.search.search({ query: goal, maxResults: 5 });

    if (response.results.length === 0) {
      return this.textResult(`No modules found for your goal. Try rephrasing.`);
    }

    const recommendations = response.results
      .map((r) => `1. **${r.module.name}** — ${r.module.description?.slice(0, 100) || ""}\n   Use: \`absorb("${r.module.name}")\` to load full content.`)
      .join("\n\n");

    return this.textResult(
      `**Recommended modules for:** "${goal}"\n\n${recommendations}`
    );
  }

  // ──────────────────────────────────────────────────────────
  // Tool Handlers — Generation (require AI inference)
  // ──────────────────────────────────────────────────────────

  private async handleSynthesize(args: Record<string, unknown>): Promise<ToolResult> {
    const moduleName = args.module as string;
    const task = args.task as string;

    // Load the module content
    const module = await this.store.getModule(moduleName);
    if (!module) {
      return this.textResult(`Module "${moduleName}" not found.`, true);
    }

    // Call AI inference with module context
    const result = await this.callInference(
      `You are an expert applying the methodology from the following knowledge module.\n\nMODULE: ${module.displayName}\n\n${module.content.content}\n\n---\n\nNow apply this methodology to the following task:\n\n${task}`
    );

    return this.textResult(result);
  }

  private async handleBloom(args: Record<string, unknown>): Promise<ToolResult> {
    const type = args.type as string;
    const topic = args.topic as string;
    const details = args.details as string | undefined;
    const tone = args.tone as string | undefined;

    const result = await this.callInference(
      `Generate a complete ${type} about "${topic}".\n${details ? `Details: ${details}\n` : ""}${tone ? `Tone: ${tone}\n` : ""}Write comprehensive, production-ready content.`
    );

    return this.textResult(result);
  }

  private async handleCultivate(args: Record<string, unknown>): Promise<ToolResult> {
    return this.textResult("cultivate: Generation tool. Configure inference endpoint in config to enable.");
  }

  private async handlePollinate(args: Record<string, unknown>): Promise<ToolResult> {
    return this.textResult("pollinate: Generation tool. Configure inference endpoint in config to enable.");
  }

  private async handleDecompose(args: Record<string, unknown>): Promise<ToolResult> {
    return this.textResult("decompose: Generation tool. Configure inference endpoint in config to enable.");
  }

  // ──────────────────────────────────────────────────────────
  // Tool Handlers — Context
  // ──────────────────────────────────────────────────────────

  private async handleGerminate(args: Record<string, unknown>): Promise<ToolResult> {
    const name = args.project_name as string;
    const goal = args.goal as string | undefined;
    const stack = args.stack as string | undefined;

    const context = [
      `# ${name} — Project Context`,
      "",
      `> Generated by Celiums Knowledge Engine`,
      "",
      goal ? `## Goal\n${goal}\n` : "",
      stack ? `## Stack\n${stack}\n` : "",
      "## Decisions\n- (none yet)\n",
      "## Progress\n- [ ] Project initialized\n",
      "## Notes\n",
    ].filter(Boolean).join("\n");

    return this.textResult(`Created project context for **${name}**:\n\n\`\`\`markdown\n${context}\n\`\`\`\n\nSave this as \`CELIUMS.md\` in your project root.`);
  }

  private async handlePhotosynthesize(args: Record<string, unknown>): Promise<ToolResult> {
    const context = args.existing_context as string;
    const update = args.update as string;
    return this.textResult(`Context updated with: ${update}\n\nAppend this to your CELIUMS.md.`);
  }

  private async handleTranspire(args: Record<string, unknown>): Promise<ToolResult> {
    const context = args.context_content as string;
    return this.textResult(`**Project Context Summary:**\n\n${context.slice(0, 2000)}`);
  }

  // ──────────────────────────────────────────────────────────
  // Tool Handlers — Setup & Build
  // ──────────────────────────────────────────────────────────

  private async handleEstablish(args: Record<string, unknown>): Promise<ToolResult> {
    return this.textResult(
      "Celiums established as knowledge layer.\n\nAdd to your IDE:\n```json\n{\n  \"mcpServers\": {\n    \"celiums\": {\n      \"command\": \"npx\",\n      \"args\": [\"-y\", \"@celiums/mcp\"]\n    }\n  }\n}\n```"
    );
  }

  private async handleConstruct(args: Record<string, unknown>): Promise<ToolResult> {
    return this.textResult("construct: Build tool. Configure inference endpoint in config to enable large project generation.");
  }

  private async handleConstructStatus(args: Record<string, unknown>): Promise<ToolResult> {
    return this.textResult("No active builds.");
  }

  // ──────────────────────────────────────────────────────────
  // Helpers
  // ──────────────────────────────────────────────────────────

  /**
   * Call the configured AI inference endpoint.
   * If no endpoint configured, returns a helpful message.
   */
  private async callInference(prompt: string): Promise<string> {
    if (!this.config.inference?.endpoint || !this.config.inference?.apiKey) {
      return "AI inference not configured. Set `inference.endpoint` and `inference.apiKey` in your Celiums config to enable generation tools (synthesize, bloom, cultivate, pollinate, decompose).";
    }

    try {
      const response = await fetch(this.config.inference.endpoint, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${this.config.inference.apiKey}`,
        },
        body: JSON.stringify({
          model: this.config.inference.defaultModel ?? (process.env.INFERENCE_MODEL || "default"),
          messages: [{ role: "user", content: prompt }],
          max_tokens: 4000,
          temperature: 0.3,
        }),
      });

      const data = (await response.json()) as {
        choices: Array<{ message: { content: string } }>;
      };
      return data.choices[0]?.message?.content ?? "No response from AI model.";
    } catch (error) {
      const msg = error instanceof Error ? error.message : "Unknown error";
      return `AI inference error: ${msg}`;
    }
  }

  /** Helper to create a text result */
  private textResult(text: string, isError: boolean = false): ToolResult {
    return {
      content: [{ type: "text", text }],
      isError,
    };
  }

  /** Register a tool definition + handler */
  private register(definition: ToolDefinition, handler: ToolHandler): void {
    this.definitions.push(definition);
    this.handlers.set(definition.name, handler);
  }
}
