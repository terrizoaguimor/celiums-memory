// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Celiums Solutions LLC

/**
 * Research library — typed facades over the 8 research_* tools.
 *
 * Bridged via registry. Refactor to dedicated lib/* when needed.
 */

import { bridgeHandler } from './from-handler.js';
import { RESEARCH_TOOLS } from '../mcp/research-tools.js';

const byName = Object.fromEntries(RESEARCH_TOOLS.map((t) => [t.definition.name, t.handler] as const));

// ─── research_project_create ──────────────────────────────────────────
export interface ResearchProjectCreateInput {
  topic: string;
  scope?: string;
  questions?: string[];
}
export interface ResearchProjectCreateOutput {
  id: string;
  topic: string;
  created_at: string;
}
export const researchProjectCreate = bridgeHandler<ResearchProjectCreateInput, ResearchProjectCreateOutput>(byName['research_project_create']);

// ─── research_project_list ────────────────────────────────────────────
export type ResearchProjectListInput = Record<string, never>;
export interface ResearchProjectListOutput {
  projects: Array<{ id: string; topic: string; status: string; created_at: string }>;
}
export const researchProjectList = bridgeHandler<ResearchProjectListInput, ResearchProjectListOutput>(byName['research_project_list']);

// ─── research_project_continue ────────────────────────────────────────
export interface ResearchProjectContinueInput {
  project_id: string;
}
export interface ResearchProjectContinueOutput {
  id: string;
  topic: string;
  findings: Array<{ id: string; content: string }>;
  gaps: Array<{ id: string; description: string }>;
}
export const researchProjectContinue = bridgeHandler<ResearchProjectContinueInput, ResearchProjectContinueOutput>(byName['research_project_continue']);

// ─── research_search ──────────────────────────────────────────────────
export interface ResearchSearchInput {
  query: string;
  project_id?: string;
  limit?: number;
}
export interface ResearchSearchOutput {
  query: string;
  results: Array<{ name: string; description?: string; category?: string; score?: number }>;
}
export const researchSearch = bridgeHandler<ResearchSearchInput, ResearchSearchOutput>(byName['research_search']);

// ─── research_synthesize ──────────────────────────────────────────────
export interface ResearchSynthesizeInput {
  query: string;
  project_id?: string;
}
export interface ResearchSynthesizeOutput {
  synthesis: string;
  sources: string[];
}
export const researchSynthesize = bridgeHandler<ResearchSynthesizeInput, ResearchSynthesizeOutput>(byName['research_synthesize']);

// ─── research_finding_add ─────────────────────────────────────────────
export interface ResearchFindingAddInput {
  project_id: string;
  content: string;
  source?: string;
  confidence?: number;
}
export interface ResearchFindingAddOutput {
  id: string;
  project_id: string;
}
export const researchFindingAdd = bridgeHandler<ResearchFindingAddInput, ResearchFindingAddOutput>(byName['research_finding_add']);

// ─── research_gap_add ─────────────────────────────────────────────────
export interface ResearchGapAddInput {
  project_id: string;
  description: string;
  priority?: 'low' | 'medium' | 'high';
}
export interface ResearchGapAddOutput {
  id: string;
  project_id: string;
}
export const researchGapAdd = bridgeHandler<ResearchGapAddInput, ResearchGapAddOutput>(byName['research_gap_add']);

// ─── research_export ──────────────────────────────────────────────────
export interface ResearchExportInput {
  project_id: string;
  format?: 'markdown' | 'json';
}
export interface ResearchExportOutput {
  format: string;
  content: string;
}
export const researchExport = bridgeHandler<ResearchExportInput, ResearchExportOutput>(byName['research_export']);
