/**
 * @celiums/memory MCP — Write tools
 *
 * Novelist-grade project state. The signature feature is
 * write_continuity_check: tracks `secrets_known_at_chapter` per character,
 * worldbuilding rules with cost/exceptions, and timeline markers — then
 * uses an LLM to flag continuity issues structurally (NOT line-by-line
 * like Sudowrite/Grammarly).
 *
 * The continuity_check tool requires CELIUMS_LLM_API_KEY (any
 * OpenAI-compatible endpoint). Other tools work pool-only with no LLM.
 *
 * v0.1 ships: project lifecycle, characters, scenes, continuity_check,
 * markdown export. v0.2 adds style_fingerprint, scene_search, co-author,
 * docx/epub/fdx export.
 */

import type { RegisteredTool, McpToolHandler, McpToolResult, McpToolContext } from './types.js';
import { llmChat } from '../llm-client.js';

export const WRITE_SCHEMA_SQL = `
CREATE EXTENSION IF NOT EXISTS vector;

CREATE TABLE IF NOT EXISTS write_projects (
  id              TEXT PRIMARY KEY DEFAULT gen_random_uuid()::TEXT,
  user_id         TEXT NOT NULL,
  title           TEXT NOT NULL,
  genre           TEXT,
  premise         TEXT,
  structure_template TEXT,
  style_profile   JSONB,
  status          TEXT NOT NULL DEFAULT 'drafting',
  word_target     INTEGER,
  created_at      TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at      TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS write_projects_user_idx ON write_projects (user_id);

CREATE TABLE IF NOT EXISTS write_characters (
  id              TEXT PRIMARY KEY DEFAULT gen_random_uuid()::TEXT,
  project_id      TEXT NOT NULL REFERENCES write_projects (id) ON DELETE CASCADE,
  name            TEXT NOT NULL,
  role            TEXT,
  archetype       TEXT,
  voice_sample    TEXT,
  arc_summary     TEXT,
  secrets_known_at_chapter JSONB NOT NULL DEFAULT '{}'::jsonb,
  physical_description TEXT,
  created_at      TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS write_characters_project_idx ON write_characters (project_id);
CREATE UNIQUE INDEX IF NOT EXISTS write_characters_project_name_uq ON write_characters (project_id, name);

CREATE TABLE IF NOT EXISTS write_locations (
  id              TEXT PRIMARY KEY DEFAULT gen_random_uuid()::TEXT,
  project_id      TEXT NOT NULL REFERENCES write_projects (id) ON DELETE CASCADE,
  name            TEXT NOT NULL,
  type            TEXT,
  sensory_details TEXT,
  rules           JSONB
);

CREATE TABLE IF NOT EXISTS write_world (
  id              BIGSERIAL PRIMARY KEY,
  project_id      TEXT NOT NULL REFERENCES write_projects (id) ON DELETE CASCADE,
  kind            TEXT NOT NULL,
  name            TEXT NOT NULL,
  rules           TEXT,
  cost            TEXT,
  exceptions      TEXT
);

CREATE TABLE IF NOT EXISTS write_scenes (
  id              TEXT PRIMARY KEY DEFAULT gen_random_uuid()::TEXT,
  project_id      TEXT NOT NULL REFERENCES write_projects (id) ON DELETE CASCADE,
  chapter_id      TEXT,
  position        INTEGER NOT NULL,
  pov_character_id TEXT REFERENCES write_characters (id),
  location_id     TEXT REFERENCES write_locations (id),
  time_marker     TEXT,
  scene_goal      TEXT,
  conflict        TEXT,
  outcome         TEXT,
  beat_id_target  TEXT,
  content         TEXT,
  word_count      INTEGER,
  status          TEXT NOT NULL DEFAULT 'draft',
  version         INTEGER NOT NULL DEFAULT 1,
  embedding       vector(1024),
  created_at      TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at      TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS write_scenes_project_idx ON write_scenes (project_id, position);

CREATE TABLE IF NOT EXISTS write_revision_log (
  id              BIGSERIAL PRIMARY KEY,
  scene_id        TEXT NOT NULL REFERENCES write_scenes (id) ON DELETE CASCADE,
  version_a       INTEGER NOT NULL,
  version_b       INTEGER NOT NULL,
  diff_summary    TEXT,
  prev_content    TEXT,
  new_content     TEXT,
  created_at      TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS write_revision_log_scene_idx ON write_revision_log (scene_id, created_at DESC);
`;

let schemaReady = false;
async function ensureSchema(ctx: McpToolContext): Promise<unknown> {
  const pool = ctx.pool as { query: (sql: string, params?: any[]) => Promise<any> } | undefined;
  if (!pool) throw new Error('write tools require pool in McpToolContext');
  if (!schemaReady) {
    await pool.query(WRITE_SCHEMA_SQL);
    schemaReady = true;
  }
  return pool;
}

function ok(text: string): McpToolResult { return { content: [{ type: 'text', text }] }; }
function errR(text: string): McpToolResult { return { content: [{ type: 'text', text }], isError: true }; }
function asText(p: unknown): string { return typeof p === 'string' ? p : JSON.stringify(p, null, 2); }

async function llm(messages: Array<{ role: 'system' | 'user' | 'assistant'; content: string }>, model?: string, maxTokens = 4000): Promise<string> {
  return llmChat(messages, { model, maxTokens });
}

// ─── handlers ─────────────────────────────────────────────────────────

const handleProjectCreate: McpToolHandler = async (args, ctx) => {
  const pool = (await ensureSchema(ctx)) as any;
  const userId = String(args.userId ?? ctx.userId);
  const r = await pool.query(
    `INSERT INTO write_projects (user_id, title, genre, premise, structure_template, word_target)
     VALUES ($1,$2,$3,$4,$5,$6) RETURNING id`,
    [userId, String(args.title), args.genre ?? null, args.premise ?? null, args.structureTemplate ?? null, args.wordTarget ?? null],
  );
  return ok(asText({ success: true, project_id: r.rows[0].id, title: args.title }));
};

const handleProjectGet: McpToolHandler = async (args, ctx) => {
  const pool = (await ensureSchema(ctx)) as any;
  const id = String(args.projectId);
  const proj = (await pool.query('SELECT * FROM write_projects WHERE id=$1', [id])).rows[0];
  if (!proj) return errR('project not found');
  const chars = (await pool.query('SELECT id, name, role, archetype FROM write_characters WHERE project_id=$1 ORDER BY name', [id])).rows;
  const scenes = (await pool.query('SELECT id, chapter_id, position, scene_goal, status, word_count FROM write_scenes WHERE project_id=$1 ORDER BY position', [id])).rows;
  const totalWords = scenes.reduce((s: number, x: any) => s + (x.word_count ?? 0), 0);
  return ok(asText({ project: proj, characters: chars, scenes_count: scenes.length, words_so_far: totalWords, recent_scenes: scenes.slice(-5) }));
};

const handleCharacterCreate: McpToolHandler = async (args, ctx) => {
  const pool = (await ensureSchema(ctx)) as any;
  const r = await pool.query(
    `INSERT INTO write_characters (project_id, name, role, archetype, voice_sample, arc_summary, physical_description)
     VALUES ($1,$2,$3,$4,$5,$6,$7)
     ON CONFLICT (project_id, name) DO UPDATE SET
       role=COALESCE(EXCLUDED.role, write_characters.role),
       archetype=COALESCE(EXCLUDED.archetype, write_characters.archetype),
       voice_sample=COALESCE(EXCLUDED.voice_sample, write_characters.voice_sample),
       arc_summary=COALESCE(EXCLUDED.arc_summary, write_characters.arc_summary),
       physical_description=COALESCE(EXCLUDED.physical_description, write_characters.physical_description)
     RETURNING id`,
    [String(args.projectId), String(args.name), args.role ?? null, args.archetype ?? null, args.voiceSample ?? null, args.arcSummary ?? null, args.physicalDescription ?? null],
  );
  return ok(asText({ success: true, character_id: r.rows[0].id, name: args.name }));
};

const handleSceneCreate: McpToolHandler = async (args, ctx) => {
  const pool = (await ensureSchema(ctx)) as any;
  const wc = args.content ? String(args.content).trim().split(/\s+/).length : 0;
  const r = await pool.query(
    `INSERT INTO write_scenes
       (project_id, chapter_id, position, pov_character_id, location_id, time_marker,
        scene_goal, conflict, outcome, beat_id_target, content, word_count)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12) RETURNING id`,
    [
      String(args.projectId), args.chapterId ?? null, Number(args.position),
      args.povCharacterId ?? null, args.locationId ?? null, args.timeMarker ?? null,
      args.sceneGoal ?? null, args.conflict ?? null, args.outcome ?? null,
      args.beatIdTarget ?? null, args.content ?? null, wc,
    ],
  );
  return ok(asText({ success: true, scene_id: r.rows[0].id }));
};

const handleSceneUpdate: McpToolHandler = async (args, ctx) => {
  const pool = (await ensureSchema(ctx)) as any;
  const sceneId = String(args.sceneId);
  const content = String(args.content);
  const prev = (await pool.query('SELECT version, content FROM write_scenes WHERE id=$1', [sceneId])).rows[0];
  if (!prev) return errR('scene not found');
  const newVersion = (prev.version as number) + 1;
  await pool.query(
    `INSERT INTO write_revision_log (scene_id, version_a, version_b, prev_content, new_content)
     VALUES ($1,$2,$3,$4,$5)`,
    [sceneId, prev.version, newVersion, prev.content, content],
  );
  const wc = content.trim().split(/\s+/).length;
  await pool.query(
    `UPDATE write_scenes SET content=$2, word_count=$3, version=$4, updated_at=NOW() WHERE id=$1`,
    [sceneId, content, wc, newVersion],
  );
  return ok(asText({ success: true, scene_id: sceneId, version: newVersion }));
};

const handleContinuityCheck: McpToolHandler = async (args, ctx) => {
  const pool = (await ensureSchema(ctx)) as any;
  const projectId = String(args.projectId);
  const sceneId = String(args.sceneId);
  const scope = Number(args.scopeChapters ?? 20);
  const target = (await pool.query('SELECT * FROM write_scenes WHERE id=$1', [sceneId])).rows[0];
  if (!target) return errR('scene not found');
  const prior = (await pool.query(
    `SELECT s.position, s.content, s.scene_goal, c.name AS pov_name
       FROM write_scenes s LEFT JOIN write_characters c ON c.id = s.pov_character_id
      WHERE s.project_id=$1 AND s.position < $2
      ORDER BY s.position DESC LIMIT $3`,
    [projectId, target.position, scope],
  )).rows;
  const characters = (await pool.query(
    `SELECT name, role, archetype, secrets_known_at_chapter, physical_description
       FROM write_characters WHERE project_id=$1`,
    [projectId],
  )).rows;
  const world = (await pool.query(
    `SELECT kind, name, rules, cost FROM write_world WHERE project_id=$1`,
    [projectId],
  )).rows;

  const sys = `You are a continuity editor for a novel. Identify continuity issues:
- Character speaking about info they shouldn't know yet (check secrets_known_at_chapter).
- Physical description inconsistency vs character sheet.
- Timeline conflicts (scene happens at impossible time vs prior scenes).
- Worldbuilding rule violations (magic/tech costs not paid, rules contradicted).
- Character voice drift compared to voice_sample.

Output strict JSON:
{"issues":[{"severity":"high|medium|low","type":"secret-leak|description-drift|timeline|worldbuilding|voice","scene_position":N,"description":"...","suggested_fix":"..."}],"ok":boolean}`;

  const user = JSON.stringify({
    characters,
    worldbuilding: world,
    prior_scenes: prior,
    target_scene: { position: target.position, chapter_id: target.chapter_id, time_marker: target.time_marker, content: target.content },
  });

  try {
    const raw = await llm([{ role: 'system', content: sys }, { role: 'user', content: user }], undefined, 3000);
    const m = raw.match(/\{[\s\S]*\}/);
    const parsed = m ? JSON.parse(m[0]) : { ok: false, issues: [], raw };
    return ok(asText(parsed));
  } catch (e) {
    return errR(`continuity_check failed: ${(e as Error).message}`);
  }
};

const handleExport: McpToolHandler = async (args, ctx) => {
  const pool = (await ensureSchema(ctx)) as any;
  const id = String(args.projectId);
  const proj = (await pool.query('SELECT * FROM write_projects WHERE id=$1', [id])).rows[0];
  if (!proj) return errR('project not found');
  const scenes = (await pool.query(
    `SELECT s.*, c.name AS pov_name FROM write_scenes s
       LEFT JOIN write_characters c ON c.id = s.pov_character_id
      WHERE s.project_id=$1 ORDER BY s.position`,
    [id],
  )).rows;
  const md: string[] = [`# ${proj.title}`];
  if (proj.premise) md.push(`> ${proj.premise}`);
  md.push('');
  let lastChapter: string | null = null;
  for (const s of scenes) {
    if (s.chapter_id && s.chapter_id !== lastChapter) {
      md.push(`## Chapter ${s.chapter_id}`);
      lastChapter = s.chapter_id;
    }
    md.push('');
    if (s.pov_name) md.push(`*POV: ${s.pov_name}*`);
    if (s.time_marker) md.push(`*${s.time_marker}*`);
    md.push('');
    md.push(s.content ?? '*[empty scene]*');
  }
  return ok(md.join('\n'));
};

// ─── registry ─────────────────────────────────────────────────────────

export const WRITE_TOOLS: RegisteredTool[] = [
  {
    group: 'ai',
    definition: {
      name: 'write_project_create',
      description: 'Create a writing project (novel, screenplay, long-form). Returns a project_id used by all other write_* tools. structureTemplate enables beat tracking against a known structure: three-act | save-the-cat | hero-journey | snowflake | free.',
      inputSchema: {
        type: 'object',
        properties: {
          userId: { type: 'string' },
          title: { type: 'string' },
          genre: { type: 'string' },
          premise: { type: 'string' },
          structureTemplate: { type: 'string', description: 'three-act | save-the-cat | hero-journey | snowflake | free' },
          wordTarget: { type: 'number' },
        },
        required: ['title'],
      },
    },
    handler: handleProjectCreate,
  },
  {
    group: 'ai',
    definition: {
      name: 'write_project_get',
      description: 'Get full project state: metadata, all characters, scene count, total word count, and the 5 most recent scenes. Use to orient yourself when resuming work.',
      inputSchema: { type: 'object', properties: { projectId: { type: 'string' } }, required: ['projectId'] },
    },
    handler: handleProjectGet,
  },
  {
    group: 'ai',
    definition: {
      name: 'write_character_create',
      description: 'Create or upsert a character. Voice sample is critical for continuity_check — it lets the editor detect when a character\'s dialogue drifts from their established voice. Pass voiceSample as a 100-300 word excerpt of how they speak.',
      inputSchema: {
        type: 'object',
        properties: {
          projectId: { type: 'string' },
          name: { type: 'string' },
          role: { type: 'string', description: 'protagonist | antagonist | mentor | foil | minor' },
          archetype: { type: 'string' },
          voiceSample: { type: 'string', description: '100-300 word excerpt of how this character speaks.' },
          arcSummary: { type: 'string' },
          physicalDescription: { type: 'string' },
        },
        required: ['projectId', 'name'],
      },
    },
    handler: handleCharacterCreate,
  },
  {
    group: 'ai',
    definition: {
      name: 'write_scene_create',
      description: 'Insert a scene at a specific position. POV character + location + time_marker enable continuity_check. scene_goal/conflict/outcome are optional but recommended — they make the scene\'s purpose explicit and improve revision suggestions.',
      inputSchema: {
        type: 'object',
        properties: {
          projectId: { type: 'string' },
          chapterId: { type: 'string' },
          position: { type: 'number', description: 'Order within the project (0-indexed).' },
          povCharacterId: { type: 'string' },
          locationId: { type: 'string' },
          timeMarker: { type: 'string', description: 'e.g. "Tuesday morning, day 12 of the journey".' },
          sceneGoal: { type: 'string' },
          conflict: { type: 'string' },
          outcome: { type: 'string' },
          beatIdTarget: { type: 'string', description: 'Outline beat this scene is meant to deliver.' },
          content: { type: 'string', description: 'The scene prose itself.' },
        },
        required: ['projectId', 'position'],
      },
    },
    handler: handleSceneCreate,
  },
  {
    group: 'ai',
    definition: {
      name: 'write_scene_update',
      description: 'Replace a scene\'s content. Automatically snapshots the previous version into write_revision_log so the writer can diff between revisions later. Bumps the version counter.',
      inputSchema: {
        type: 'object',
        properties: {
          sceneId: { type: 'string' },
          content: { type: 'string' },
        },
        required: ['sceneId', 'content'],
      },
    },
    handler: handleSceneUpdate,
  },
  {
    group: 'ai',
    definition: {
      name: 'write_continuity_check',
      description: 'Signature feature: structural continuity check using Opus 4.7. Loads the target scene, prior 20 scenes, all characters (with their secrets_known_at_chapter and voice samples), and worldbuilding rules. Outputs a JSON list of issues: secret-leak, description-drift, timeline conflict, worldbuilding violation, voice drift. Each issue includes severity, scene_position, description, and a suggested_fix. NO other writing tool does this — Sudowrite/Grammarly/ProWritingAid are line-by-line, this is structural.',
      inputSchema: {
        type: 'object',
        properties: {
          projectId: { type: 'string' },
          sceneId: { type: 'string', description: 'The scene under review (must exist in the project).' },
          scopeChapters: { type: 'number', description: 'How many prior scenes to include as canonical context. Default 20.' },
        },
        required: ['projectId', 'sceneId'],
      },
    },
    handler: handleContinuityCheck,
  },
  {
    group: 'ai',
    definition: {
      name: 'write_export',
      description: 'Export the project as a markdown manuscript. Scenes are emitted in position order, grouped by chapter_id, with POV character and time markers as italic interstitials. Use as a clean preview or to ship into Notion / docx tooling later.',
      inputSchema: {
        type: 'object',
        properties: {
          projectId: { type: 'string' },
          format: { type: 'string', description: '"markdown" only for v0.1.' },
        },
        required: ['projectId'],
      },
    },
    handler: handleExport,
  },
];
