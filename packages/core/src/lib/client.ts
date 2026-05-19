// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Celiums Solutions LLC

/**
 * MemoryClient — single library surface, two backends.
 *
 * The same typed interface (`recall`, `remember`, `journalWrite`, etc.)
 * works against either:
 *
 *   - `local`  — in-process call to the core library functions. Requires
 *                the caller to provide a MemoryEngine + pg.Pool. This is
 *                the Lite + Standard self-hosted shape (REDISING tiers).
 *
 *   - `remote` — HTTP fetch against memory.celiums.ai (or any deployment
 *                exposing the same REST surface). This is the Managed
 *                Cloud shape — user has nothing local except an API key.
 *
 * Switching modes is config-only: same call sites, change one field in
 * createMemoryClient(opts) and the app moves between self-hosted and
 * managed without a single line of feature code touching it.
 *
 * Why this matters: REDISING §2 "infrastructure for the agent layer" +
 * Mario's directive 2026-05-12 — "los usuarios pueden pasar de opencore
 * a managed solo con un par de clicks". The client API is that promise's
 * implementation surface.
 */

import type { ToolCtx } from './types.js';
import type { RecallInput, RecallOutput } from './recall.js';
import type { JournalWriteInput, JournalWriteOutput } from './journal-write.js';
import type {
  ForageInput, ForageOutput,
  AbsorbInput, AbsorbOutput,
  SenseInput, SenseOutput,
  MapNetworkInput, MapNetworkOutput,
  RememberInput, RememberOutput,
} from './opencore.js';
import type {
  JournalRecallInput, JournalRecallOutput,
  JournalArcInput, JournalArcOutput,
  JournalIntrospectInput, JournalIntrospectOutput,
  JournalDialogueInput, JournalDialogueOutput,
  JournalVerifyChainInput, JournalVerifyChainOutput,
} from './journal-extra.js';
import type {
  AtlasAskInput, AtlasAskOutput,
  AtlasChatInput,
  AtlasClassifyInput, AtlasClassifyOutput,
  AtlasRecommendInput, AtlasRecommendOutput,
  AtlasListModelsInput, AtlasListModelsOutput,
  CognitiveInput, CognitiveOutput,
} from './atlas.js';
import type {
  EthicsLookupInput, EthicsLookupOutput,
  EthicsAuditInput, EthicsAuditOutput,
  WebSearchInput, WebSearchOutput,
} from './misc.js';
import type {
  TurnContextInput, TurnContextOutput,
  TurnAfterInput, TurnAfterOutput,
  CompactCheckpointInput, CompactCheckpointOutput,
} from './proactive.js';
import type {
  ResearchProjectCreateInput, ResearchProjectCreateOutput,
  ResearchProjectListOutput,
  ResearchProjectContinueInput, ResearchProjectContinueOutput,
  ResearchSearchInput, ResearchSearchOutput,
  ResearchSynthesizeInput, ResearchSynthesizeOutput,
  ResearchFindingAddInput, ResearchFindingAddOutput,
  ResearchGapAddInput, ResearchGapAddOutput,
  ResearchExportInput, ResearchExportOutput,
} from './research.js';
import type {
  WriteProjectCreateInput, WriteProjectCreateOutput,
  WriteProjectGetInput, WriteProjectGetOutput,
  WriteCharacterCreateInput, WriteCharacterCreateOutput,
  WriteSceneCreateInput, WriteSceneCreateOutput,
  WriteSceneUpdateInput, WriteSceneUpdateOutput,
  WriteContinuityCheckInput, WriteContinuityCheckOutput,
  WriteExportInput, WriteExportOutput,
} from './write.js';
import type { EthicsTraceInput, EthicsTraceOutput } from './ethics-trace.js';

// ─── Public client interface ──────────────────────────────────────────

export interface MemoryClient {
  // OpenCore
  recall:           (input: RecallInput) => Promise<RecallOutput>;
  remember:         (input: RememberInput) => Promise<RememberOutput>;
  forage:           (input: ForageInput) => Promise<ForageOutput>;
  absorb:           (input: AbsorbInput) => Promise<AbsorbOutput>;
  sense:            (input: SenseInput) => Promise<SenseOutput>;
  mapNetwork:       (input?: MapNetworkInput) => Promise<MapNetworkOutput>;
  ethicsTrace:      (input: EthicsTraceInput) => Promise<EthicsTraceOutput>;

  // Journal
  journalWrite:     (input: JournalWriteInput) => Promise<JournalWriteOutput>;
  journalRecall:    (input: JournalRecallInput) => Promise<JournalRecallOutput>;
  journalArc:       (input: JournalArcInput) => Promise<JournalArcOutput>;
  journalIntrospect:(input: JournalIntrospectInput) => Promise<JournalIntrospectOutput>;
  journalDialogue:  (input: JournalDialogueInput) => Promise<JournalDialogueOutput>;
  journalVerifyChain: (input: JournalVerifyChainInput) => Promise<JournalVerifyChainOutput>;

  // Atlas
  atlasAsk:         (input: AtlasAskInput) => Promise<AtlasAskOutput>;
  atlasChat:        (input: AtlasChatInput) => Promise<AtlasAskOutput>;
  atlasClassify:    (input: AtlasClassifyInput) => Promise<AtlasClassifyOutput>;
  atlasRecommend:   (input: AtlasRecommendInput) => Promise<AtlasRecommendOutput>;
  atlasListModels:  (input?: AtlasListModelsInput) => Promise<AtlasListModelsOutput>;
  bloom:            (input: CognitiveInput) => Promise<CognitiveOutput>;
  cultivate:        (input: CognitiveInput) => Promise<CognitiveOutput>;
  synthesize:       (input: CognitiveInput) => Promise<CognitiveOutput>;
  decompose:        (input: CognitiveInput) => Promise<CognitiveOutput>;
  construct:        (input: CognitiveInput) => Promise<CognitiveOutput>;
  pollinate:        (input: CognitiveInput) => Promise<CognitiveOutput>;

  // Write
  writeProjectCreate:    (input: WriteProjectCreateInput) => Promise<WriteProjectCreateOutput>;
  writeProjectGet:       (input: WriteProjectGetInput) => Promise<WriteProjectGetOutput>;
  writeCharacterCreate:  (input: WriteCharacterCreateInput) => Promise<WriteCharacterCreateOutput>;
  writeSceneCreate:      (input: WriteSceneCreateInput) => Promise<WriteSceneCreateOutput>;
  writeSceneUpdate:      (input: WriteSceneUpdateInput) => Promise<WriteSceneUpdateOutput>;
  writeContinuityCheck:  (input: WriteContinuityCheckInput) => Promise<WriteContinuityCheckOutput>;
  writeExport:           (input: WriteExportInput) => Promise<WriteExportOutput>;

  // Research
  researchProjectCreate:   (input: ResearchProjectCreateInput) => Promise<ResearchProjectCreateOutput>;
  researchProjectList:     () => Promise<ResearchProjectListOutput>;
  researchProjectContinue: (input: ResearchProjectContinueInput) => Promise<ResearchProjectContinueOutput>;
  researchSearch:          (input: ResearchSearchInput) => Promise<ResearchSearchOutput>;
  researchSynthesize:      (input: ResearchSynthesizeInput) => Promise<ResearchSynthesizeOutput>;
  researchFindingAdd:      (input: ResearchFindingAddInput) => Promise<ResearchFindingAddOutput>;
  researchGapAdd:          (input: ResearchGapAddInput) => Promise<ResearchGapAddOutput>;
  researchExport:          (input: ResearchExportInput) => Promise<ResearchExportOutput>;

  // Proactive
  turnContext:       (input: TurnContextInput) => Promise<TurnContextOutput>;
  turnAfter:         (input: TurnAfterInput) => Promise<TurnAfterOutput>;
  compactCheckpoint: (input: CompactCheckpointInput) => Promise<CompactCheckpointOutput>;

  // Misc
  ethicsLookup:       (input: EthicsLookupInput) => Promise<EthicsLookupOutput>;
  ethicsAudit:        (input: EthicsAuditInput) => Promise<EthicsAuditOutput>;
  webSearch:          (input: WebSearchInput) => Promise<WebSearchOutput>;

  /** Currently-configured mode. Useful for the UI to surface a "managed/self-hosted" badge. */
  readonly mode: 'local' | 'remote';
}

// ─── Factory options ──────────────────────────────────────────────────

export interface BaseClientOpts {
  userId: string;
  projectId?: string | null;
  agentId?: string;
  sessionId?: string;
}

export interface LocalClientOpts extends BaseClientOpts {
  mode: 'local';
  /** Required for any tool that touches memory storage. */
  memoryEngine: unknown;
  /** Required for journal_* and audit log writes. */
  pool: unknown;
  /** Required for forage/absorb/sense/map_network. */
  moduleStore?: unknown;
  /** Optional capabilities flags — defaults inferred from process.env. */
  capabilities?: Partial<{ opencore: boolean; fleet: boolean; atlas: boolean; ai: boolean }>;
}

export interface RemoteClientOpts extends BaseClientOpts {
  mode: 'remote';
  /** Base URL of the Celiums Memory deployment. Default: https://memory.celiums.ai */
  baseUrl?: string;
  /** Bearer token (cmk_* user key, or fleet key). */
  apiKey: string;
  /** Custom fetch implementation — useful for Cloudflare Workers / tests. */
  fetch?: typeof fetch;
}

export type CreateMemoryClientOpts = LocalClientOpts | RemoteClientOpts;

// ─── Factory ──────────────────────────────────────────────────────────

export function createMemoryClient(opts: CreateMemoryClientOpts): MemoryClient {
  if (opts.mode === 'local') {
    return createLocalClient(opts);
  }
  return createRemoteClient(opts);
}

// ─── Local backend — wires the core functions with a fixed ToolCtx ────

function createLocalClient(opts: LocalClientOpts): MemoryClient {
  const baseCtx: ToolCtx = {
    userId: opts.userId,
    projectId: opts.projectId ?? undefined,
    agentId: opts.agentId,
    sessionId: opts.sessionId,
    capabilities: {
      opencore: true,
      fleet: opts.capabilities?.fleet ?? !!process.env['CELIUMS_FLEET_API_KEY'],
      atlas:  opts.capabilities?.atlas  ?? !!process.env['CELIUMS_ATLAS_API_KEY'],
      ai:     opts.capabilities?.ai     ?? !!process.env['CELIUMS_LLM_API_KEY'],
    },
    moduleStore: opts.moduleStore,
    memoryEngine: opts.memoryEngine,
    pool: opts.pool,
  };

  // Dynamic imports to avoid circular deps at module-load and to keep the
  // factory cheap when only a subset of tools is exercised.
  return {
    mode: 'local',
    recall: async (input) => (await import('./recall.js')).recall(input, baseCtx),
    remember: async (input) => (await import('./opencore.js')).remember(input, baseCtx),
    forage: async (input) => (await import('./opencore.js')).forage(input, baseCtx),
    absorb: async (input) => (await import('./opencore.js')).absorb(input, baseCtx),
    sense: async (input) => (await import('./opencore.js')).sense(input, baseCtx),
    mapNetwork: async (input) => (await import('./opencore.js')).mapNetwork(input ?? {}, baseCtx),
    ethicsTrace: async (input) => (await import('./ethics-trace.js')).ethicsTrace(input, baseCtx),

    journalWrite: async (input) => (await import('./journal-write.js')).journalWrite(input, baseCtx),
    journalRecall: async (input) => (await import('./journal-extra.js')).journalRecall(input, baseCtx),
    journalArc: async (input) => (await import('./journal-extra.js')).journalArc(input, baseCtx),
    journalIntrospect: async (input) => (await import('./journal-extra.js')).journalIntrospect(input, baseCtx),
    journalDialogue: async (input) => (await import('./journal-extra.js')).journalDialogue(input, baseCtx),
    journalVerifyChain: async (input) => (await import('./journal-extra.js')).journalVerifyChain(input, baseCtx),

    atlasAsk: async (input) => (await import('./atlas.js')).atlasAsk(input, baseCtx),
    atlasChat: async (input) => (await import('./atlas.js')).atlasChat(input, baseCtx),
    atlasClassify: async (input) => (await import('./atlas.js')).atlasClassify(input, baseCtx),
    atlasRecommend: async (input) => (await import('./atlas.js')).atlasRecommend(input, baseCtx),
    atlasListModels: async (input) => (await import('./atlas.js')).atlasListModels(input ?? {}, baseCtx),
    bloom: async (input) => (await import('./atlas.js')).bloom(input, baseCtx),
    cultivate: async (input) => (await import('./atlas.js')).cultivate(input, baseCtx),
    synthesize: async (input) => (await import('./atlas.js')).synthesize(input, baseCtx),
    decompose: async (input) => (await import('./atlas.js')).decompose(input, baseCtx),
    construct: async (input) => (await import('./atlas.js')).construct(input, baseCtx),
    pollinate: async (input) => (await import('./atlas.js')).pollinate(input, baseCtx),

    writeProjectCreate: async (input) => (await import('./write.js')).writeProjectCreate(input, baseCtx),
    writeProjectGet: async (input) => (await import('./write.js')).writeProjectGet(input, baseCtx),
    writeCharacterCreate: async (input) => (await import('./write.js')).writeCharacterCreate(input, baseCtx),
    writeSceneCreate: async (input) => (await import('./write.js')).writeSceneCreate(input, baseCtx),
    writeSceneUpdate: async (input) => (await import('./write.js')).writeSceneUpdate(input, baseCtx),
    writeContinuityCheck: async (input) => (await import('./write.js')).writeContinuityCheck(input, baseCtx),
    writeExport: async (input) => (await import('./write.js')).writeExport(input, baseCtx),

    researchProjectCreate: async (input) => (await import('./research.js')).researchProjectCreate(input, baseCtx),
    researchProjectList: async () => (await import('./research.js')).researchProjectList({}, baseCtx),
    researchProjectContinue: async (input) => (await import('./research.js')).researchProjectContinue(input, baseCtx),
    researchSearch: async (input) => (await import('./research.js')).researchSearch(input, baseCtx),
    researchSynthesize: async (input) => (await import('./research.js')).researchSynthesize(input, baseCtx),
    researchFindingAdd: async (input) => (await import('./research.js')).researchFindingAdd(input, baseCtx),
    researchGapAdd: async (input) => (await import('./research.js')).researchGapAdd(input, baseCtx),
    researchExport: async (input) => (await import('./research.js')).researchExport(input, baseCtx),

    turnContext: async (input) => (await import('./proactive.js')).turnContext(input, baseCtx),
    turnAfter: async (input) => (await import('./proactive.js')).turnAfter(input, baseCtx),
    compactCheckpoint: async (input) => (await import('./proactive.js')).compactCheckpoint(input, baseCtx),

    ethicsLookup: async (input) => (await import('./misc.js')).ethicsLookup(input, baseCtx),
    ethicsAudit: async (input) => (await import('./misc.js')).ethicsAudit(input, baseCtx),
    webSearch: async (input) => (await import('./misc.js')).webSearch(input, baseCtx),
  };
}

// ─── Remote backend — HTTP over the same typed contract ───────────────

function createRemoteClient(opts: RemoteClientOpts): MemoryClient {
  const baseUrl = (opts.baseUrl ?? 'https://memory.celiums.ai').replace(/\/+$/, '');
  const fetchImpl = opts.fetch ?? globalThis.fetch;
  if (!fetchImpl) {
    throw new Error('createMemoryClient(remote): no fetch implementation available');
  }

  /** Generic POST `/v1/lib/<tool>` — server-side dispatches to the same
   *  core function. Server endpoint contract: receive { input, ctx_overrides }
   *  in body, return JSON output or `{ error: { message, code } }`. */
  async function call<I, O>(tool: string, input: I): Promise<O> {
    const url = `${baseUrl}/v1/lib/${tool}`;
    const ctxOverrides: Record<string, unknown> = { userId: opts.userId };
    if (opts.projectId !== undefined) ctxOverrides['projectId'] = opts.projectId;
    if (opts.agentId)   ctxOverrides['agentId']   = opts.agentId;
    if (opts.sessionId) ctxOverrides['sessionId'] = opts.sessionId;

    const res = await fetchImpl(url, {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${opts.apiKey}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({ input, ctx: ctxOverrides }),
    });
    if (!res.ok) {
      const text = await res.text().catch(() => '');
      throw new Error(`createMemoryClient(remote): ${tool} ${res.status}: ${text.slice(0, 200)}`);
    }
    return res.json() as Promise<O>;
  }

  return {
    mode: 'remote',
    recall:           (i) => call('recall', i),
    remember:         (i) => call('remember', i),
    forage:           (i) => call('forage', i),
    absorb:           (i) => call('absorb', i),
    sense:            (i) => call('sense', i),
    mapNetwork:       (i) => call('map_network', i ?? {}),
    ethicsTrace:      (i) => call('ethics_trace', i),

    journalWrite:     (i) => call('journal_write', i),
    journalRecall:    (i) => call('journal_recall', i),
    journalArc:       (i) => call('journal_arc', i),
    journalIntrospect:(i) => call('journal_introspect', i),
    journalDialogue:  (i) => call('journal_dialogue', i),
    journalVerifyChain: (i) => call('journal_verify_chain', i),

    atlasAsk:         (i) => call('atlas_ask', i),
    atlasChat:        (i) => call('atlas_chat', i),
    atlasClassify:    (i) => call('atlas_classify', i),
    atlasRecommend:   (i) => call('atlas_recommend', i),
    atlasListModels:  (i) => call('atlas_list_models', i ?? {}),
    bloom:            (i) => call('bloom', i),
    cultivate:        (i) => call('cultivate', i),
    synthesize:       (i) => call('synthesize', i),
    decompose:        (i) => call('decompose', i),
    construct:        (i) => call('construct', i),
    pollinate:        (i) => call('pollinate', i),

    writeProjectCreate:    (i) => call('write_project_create', i),
    writeProjectGet:       (i) => call('write_project_get', i),
    writeCharacterCreate:  (i) => call('write_character_create', i),
    writeSceneCreate:      (i) => call('write_scene_create', i),
    writeSceneUpdate:      (i) => call('write_scene_update', i),
    writeContinuityCheck:  (i) => call('write_continuity_check', i),
    writeExport:           (i) => call('write_export', i),

    researchProjectCreate:   (i) => call('research_project_create', i),
    researchProjectList:     () => call('research_project_list', {}),
    researchProjectContinue: (i) => call('research_project_continue', i),
    researchSearch:          (i) => call('research_search', i),
    researchSynthesize:      (i) => call('research_synthesize', i),
    researchFindingAdd:      (i) => call('research_finding_add', i),
    researchGapAdd:          (i) => call('research_gap_add', i),
    researchExport:          (i) => call('research_export', i),

    turnContext:       (i) => call('turn_context', i),
    turnAfter:         (i) => call('turn_after', i),
    compactCheckpoint: (i) => call('compact_checkpoint', i),

    ethicsLookup:       (i) => call('ethics_lookup', i),
    ethicsAudit:        (i) => call('ethics_audit', i),
    webSearch:          (i) => call('web_search', i),
  };
}

/** Convenience: build options from env vars. Lets callers do:
 *
 *     const memory = createMemoryClient(memoryClientOptsFromEnv({ userId }));
 *
 *  Reads:
 *    CELIUMS_MEMORY_MODE  — 'local' or 'remote' (default: remote when API key is set, local otherwise)
 *    CELIUMS_MEMORY_URL   — remote base URL (default: https://memory.celiums.ai)
 *    CELIUMS_API_KEY      — remote auth
 */
export function memoryClientOptsFromEnv(extra: { userId: string; agentId?: string; projectId?: string | null }): RemoteClientOpts {
  const apiKey = process.env['CELIUMS_API_KEY'] ?? process.env['CELIUMS_MEMORY_KEY'] ?? '';
  if (!apiKey) {
    throw new Error('memoryClientOptsFromEnv: CELIUMS_API_KEY required for remote mode. Use createMemoryClient({mode:"local",...}) for self-hosted.');
  }
  return {
    mode: 'remote',
    userId: extra.userId,
    agentId: extra.agentId,
    projectId: extra.projectId ?? null,
    baseUrl: process.env['CELIUMS_MEMORY_URL'],
    apiKey,
  };
}
