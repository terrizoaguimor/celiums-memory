// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Celiums Solutions LLC

/**
 * Atlas library — typed facades over the 12 atlas-* MCP tools.
 *
 * All bridged via registry; logic stays in mcp/atlas-tools.ts. Refactor any
 * specific tool to a dedicated lib/* file when hot-path performance matters.
 */

import { bridgeHandler } from './from-handler.js';
import { ATLAS_TOOLS } from '../mcp/atlas-tools.js';

const byName = Object.fromEntries(ATLAS_TOOLS.map((t) => [t.definition.name, t.handler] as const));

// ─── atlas_ask ────────────────────────────────────────────────────────
export interface AtlasAskInput {
  prompt: string;
  conversation_id?: string;
  max_tokens?: number;
}
export interface AtlasAskOutput {
  answer: string;
  model_used?: string;
  task_type?: string;
  latency_ms?: number;
  tokens?: { input: number; output: number };
}
export const atlasAsk = bridgeHandler<AtlasAskInput, AtlasAskOutput>(byName['atlas_ask']);

// ─── atlas_chat ───────────────────────────────────────────────────────
export interface AtlasChatInput {
  messages: Array<{ role: 'system' | 'user' | 'assistant'; content: string }>;
  conversation_id?: string;
  max_tokens?: number;
  system?: string;
}
export const atlasChat = bridgeHandler<AtlasChatInput, AtlasAskOutput>(byName['atlas_chat']);

// ─── atlas_classify ───────────────────────────────────────────────────
export interface AtlasClassifyInput {
  prompt: string;
}
export interface AtlasClassifyOutput {
  task_type: string;
  confidence: number;
  reasoning?: string;
}
export const atlasClassify = bridgeHandler<AtlasClassifyInput, AtlasClassifyOutput>(byName['atlas_classify']);

// ─── atlas_recommend ──────────────────────────────────────────────────
export interface AtlasRecommendInput {
  task_type: string;
  budget?: 'cheap' | 'balanced' | 'best';
}
export interface AtlasRecommendOutput {
  recommended_model: string;
  alternatives: string[];
  reasoning: string;
}
export const atlasRecommend = bridgeHandler<AtlasRecommendInput, AtlasRecommendOutput>(byName['atlas_recommend']);

// ─── atlas_list_models ────────────────────────────────────────────────
export type AtlasListModelsInput = Record<string, never>;
export interface AtlasListModelsOutput {
  models: Array<{ id: string; family: string; tier: string }>;
}
export const atlasListModels = bridgeHandler<AtlasListModelsInput, AtlasListModelsOutput>(byName['atlas_list_models']);

// celiums_ai retired 2026-05-16 — use atlasAsk (routes through Atlas:
// OSS-only catalog + classifier + entitlement). See atlas-tools.ts header.

// ─── bloom / cultivate / synthesize / decompose / construct / pollinate ─
// Generic shape — these atlas-side cognitive primitives all take a prompt
// and return text + metadata. Library callers narrow via specific inputs.
export interface CognitiveInput {
  prompt?: string;
  query?: string;
  topic?: string;
  context?: string;
  goal?: string;
}
export interface CognitiveOutput {
  result: string;
  [k: string]: unknown;
}

export const bloom      = bridgeHandler<CognitiveInput, CognitiveOutput>(byName['bloom']);
export const cultivate  = bridgeHandler<CognitiveInput, CognitiveOutput>(byName['cultivate']);
export const synthesize = bridgeHandler<CognitiveInput, CognitiveOutput>(byName['synthesize']);
export const decompose  = bridgeHandler<CognitiveInput, CognitiveOutput>(byName['decompose']);
export const construct  = bridgeHandler<CognitiveInput, CognitiveOutput>(byName['construct']);
export const pollinate  = bridgeHandler<CognitiveInput, CognitiveOutput>(byName['pollinate']);
