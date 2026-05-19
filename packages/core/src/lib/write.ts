// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Celiums Solutions LLC

/**
 * Write library — typed facades over the 7 write_* tools (narrative
 * project management: characters, scenes, continuity).
 *
 * Bridged via registry. Refactor to dedicated lib/* when needed.
 */

import { bridgeHandler } from './from-handler.js';
import { WRITE_TOOLS } from '../mcp/write-tools.js';

const byName = Object.fromEntries(WRITE_TOOLS.map((t) => [t.definition.name, t.handler] as const));

// ─── write_project_create ─────────────────────────────────────────────
export interface WriteProjectCreateInput {
  title: string;
  premise?: string;
  genre?: string;
  pov?: string;
  setting?: string;
}
export interface WriteProjectCreateOutput {
  id: string;
  title: string;
  created_at: string;
}
export const writeProjectCreate = bridgeHandler<WriteProjectCreateInput, WriteProjectCreateOutput>(byName['write_project_create']);

// ─── write_project_get ────────────────────────────────────────────────
export interface WriteProjectGetInput {
  project_id: string;
}
export interface WriteProjectGetOutput {
  id: string;
  title: string;
  premise?: string;
  genre?: string;
  characters: Array<{ id: string; name: string }>;
  scenes: Array<{ id: string; title: string; order: number }>;
}
export const writeProjectGet = bridgeHandler<WriteProjectGetInput, WriteProjectGetOutput>(byName['write_project_get']);

// ─── write_character_create ───────────────────────────────────────────
export interface WriteCharacterCreateInput {
  project_id: string;
  name: string;
  description?: string;
  voice?: string;
  arc?: string;
}
export interface WriteCharacterCreateOutput {
  id: string;
  project_id: string;
  name: string;
}
export const writeCharacterCreate = bridgeHandler<WriteCharacterCreateInput, WriteCharacterCreateOutput>(byName['write_character_create']);

// ─── write_scene_create ───────────────────────────────────────────────
export interface WriteSceneCreateInput {
  project_id: string;
  title: string;
  content: string;
  order?: number;
  characters_present?: string[];
}
export interface WriteSceneCreateOutput {
  id: string;
  project_id: string;
  title: string;
  order: number;
}
export const writeSceneCreate = bridgeHandler<WriteSceneCreateInput, WriteSceneCreateOutput>(byName['write_scene_create']);

// ─── write_scene_update ───────────────────────────────────────────────
export interface WriteSceneUpdateInput {
  scene_id: string;
  content?: string;
  title?: string;
}
export interface WriteSceneUpdateOutput {
  id: string;
  updated_at: string;
}
export const writeSceneUpdate = bridgeHandler<WriteSceneUpdateInput, WriteSceneUpdateOutput>(byName['write_scene_update']);

// ─── write_continuity_check ───────────────────────────────────────────
export interface WriteContinuityCheckInput {
  project_id: string;
  scene_id?: string;
}
export interface WriteContinuityCheckOutput {
  issues: Array<{ severity: string; description: string; scene_id?: string }>;
  passed: boolean;
}
export const writeContinuityCheck = bridgeHandler<WriteContinuityCheckInput, WriteContinuityCheckOutput>(byName['write_continuity_check']);

// ─── write_export ─────────────────────────────────────────────────────
export interface WriteExportInput {
  project_id: string;
  format?: 'markdown' | 'json';
}
export interface WriteExportOutput {
  format: string;
  content: string;
}
export const writeExport = bridgeHandler<WriteExportInput, WriteExportOutput>(byName['write_export']);
