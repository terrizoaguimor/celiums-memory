/**
 * @celiums/adapter-openai — OpenAI Function Calling adapter
 *
 * Converts Celiums tools into OpenAI function definitions that can be
 * used with any OpenAI-compatible API (OpenAI, Azure OpenAI, Groq, Together, etc.).
 *
 * This adapter doesn't run a server — it generates function definitions
 * and processes function call results. Use it to integrate Celiums
 * knowledge into any OpenAI-powered application.
 *
 * @example
 * ```typescript
 * import { OpenAI } from "openai";
 * import { createEngine } from "@celiums/core";
 * import { OpenAIAdapter } from "@celiums/adapter-openai";
 *
 * const engine = await createEngine(config);
 * const adapter = new OpenAIAdapter(engine);
 *
 * const client = new OpenAI();
 * const response = await client.chat.completions.create({
 *   model: "gpt-4o",
 *   messages: [{ role: "user", content: "How do I set up Kubernetes HPA?" }],
 *   tools: adapter.getToolDefinitions(),
 * });
 *
 * // Process tool calls
 * for (const call of response.choices[0].message.tool_calls ?? []) {
 *   const result = await adapter.handleToolCall(call);
 *   // Feed result back into the conversation
 * }
 * ```
 *
 * @package @celiums/adapter-openai
 * @license Apache-2.0
 */

import type { CeliumsEngine, CeliumsAdapter, ToolName, ToolDefinition } from "@celiums/types";

/** OpenAI function definition format */
export interface OpenAIFunction {
  type: "function";
  function: {
    name: string;
    description: string;
    parameters: Record<string, unknown>;
  };
}

/** OpenAI tool call from a chat completion response */
export interface OpenAIToolCall {
  id: string;
  type: "function";
  function: {
    name: string;
    arguments: string; // JSON string
  };
}

/** Result to feed back into the conversation */
export interface OpenAIToolResult {
  role: "tool";
  tool_call_id: string;
  content: string;
}

export class OpenAIAdapter implements CeliumsAdapter {
  name = "openai";
  private engine: CeliumsEngine;

  constructor(engine: CeliumsEngine) {
    this.engine = engine;
  }

  async initialize(engine: CeliumsEngine): Promise<void> {
    this.engine = engine;
  }

  async start(): Promise<void> {
    // No server to start — this adapter generates function definitions
  }

  async stop(): Promise<void> {}

  /**
   * Get all Celiums tools as OpenAI function definitions.
   * Pass these directly to the `tools` parameter in chat completions.
   *
   * @param filter - Optional filter to include only specific tool categories
   * @returns Array of OpenAI tool definitions
   */
  getToolDefinitions(filter?: {
    categories?: string[];
    excludeInference?: boolean;
  }): OpenAIFunction[] {
    let tools = this.engine.getTools();

    if (filter?.categories) {
      tools = tools.filter((t) => filter.categories!.includes(t.category));
    }

    if (filter?.excludeInference) {
      tools = tools.filter((t) => !t.requiresInference);
    }

    return tools.map((tool) => this.toOpenAIFunction(tool));
  }

  /**
   * Handle a tool call from an OpenAI chat completion response.
   * Parses the function arguments, executes the Celiums tool,
   * and returns the result in OpenAI's expected format.
   *
   * @param toolCall - The tool call from the API response
   * @returns A message to feed back into the conversation
   */
  async handleToolCall(toolCall: OpenAIToolCall): Promise<OpenAIToolResult> {
    const { name, arguments: argsJson } = toolCall.function;

    let args: Record<string, unknown>;
    try {
      args = JSON.parse(argsJson);
    } catch {
      return {
        role: "tool",
        tool_call_id: toolCall.id,
        content: `Error: Invalid JSON arguments for tool "${name}"`,
      };
    }

    const result = await this.engine.executeTool(name as ToolName, args);

    return {
      role: "tool",
      tool_call_id: toolCall.id,
      content: result.content.map((c) => c.text ?? "").join("\n"),
    };
  }

  /**
   * Process all tool calls from a chat completion response.
   * Convenience method for handling multiple tool calls at once.
   *
   * @param toolCalls - Array of tool calls from the response
   * @returns Array of tool results to append to the conversation
   */
  async handleAllToolCalls(toolCalls: OpenAIToolCall[]): Promise<OpenAIToolResult[]> {
    return Promise.all(toolCalls.map((call) => this.handleToolCall(call)));
  }

  /** Convert a Celiums tool definition to OpenAI function format */
  private toOpenAIFunction(tool: ToolDefinition): OpenAIFunction {
    return {
      type: "function",
      function: {
        name: tool.name,
        description: tool.description,
        parameters: {
          type: "object",
          properties: tool.inputSchema.properties ?? {},
          required: tool.inputSchema.required ?? [],
        },
      },
    };
  }
}
