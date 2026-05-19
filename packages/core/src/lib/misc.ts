// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Celiums Solutions LLC

/**
 * Misc library — ethics_lookup, ethics_audit, web_search.
 *
 * These tools live in separate *-tools.ts files but together fit in one
 * library module since they share neither domain nor dependencies with the
 * larger groups. Bridged via registry — same pattern as journal-extra/atlas/
 * write/research/proactive.
 */

import { bridgeHandler } from './from-handler.js';
import { ETHICS_TOOLS } from '../mcp/ethics-tools.js';
import { WEB_SEARCH_TOOLS } from '../mcp/web-search-tools.js';

const ethicsByName = Object.fromEntries(ETHICS_TOOLS.map((t) => [t.definition.name, t.handler] as const));
const webByName = Object.fromEntries(WEB_SEARCH_TOOLS.map((t) => [t.definition.name, t.handler] as const));

// ─── ethics_lookup ────────────────────────────────────────────────────
export interface EthicsLookupInput {
  query: string;
  topK?: number;
}
export interface EthicsLookupOutput {
  matches: Array<{
    title?: string;
    excerpt: string;
    framework?: string;
    score?: number;
  }>;
}
export const ethicsLookup = bridgeHandler<EthicsLookupInput, EthicsLookupOutput>(ethicsByName['ethics_lookup']);

// ─── ethics_audit ─────────────────────────────────────────────────────
export interface EthicsAuditInput {
  content: string;
  framework?: 'utilitarian' | 'deontological' | 'virtue' | 'all';
}
export interface EthicsAuditOutput {
  passed: boolean;
  violations: Array<{
    category: string;
    confidence: number;
    reason: string;
    blocked: boolean;
  }>;
  score?: number;
  layerA?: unknown;
  layerB?: unknown;
  layerC?: unknown;
}
export const ethicsAudit = bridgeHandler<EthicsAuditInput, EthicsAuditOutput>(ethicsByName['ethics_audit']);

// ─── web_search ───────────────────────────────────────────────────────
export interface WebSearchInput {
  query: string;
  topK?: number;
  engines?: string[];
}
export interface WebSearchOutput {
  query: string;
  results: Array<{
    title: string;
    url: string;
    content?: string;
    engine?: string;
    publishedDate?: string;
  }>;
}
export const webSearch = bridgeHandler<WebSearchInput, WebSearchOutput>(webByName['web_search']);

// universal_knowledge RETIRED 2026-05-16 — see dispatcher.ts / #166.
// Replaced by curated `skills` corpus + Knowledge Federation Layer.
