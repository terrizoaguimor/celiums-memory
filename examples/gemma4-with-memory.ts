/**
 * Example: Celiums AI (Gemma 4) with automatic persistent memory
 *
 * This shows how celiums-memory makes memory AUTOMATIC.
 * The LLM doesn't need to "decide" to remember — the middleware does it.
 *
 * Run: npx tsx examples/gemma4-with-memory.ts
 */

import { createMemoryEngine, MemoryMiddleware } from '../packages/core/src/index';

async function main() {

// ============================================================
// Configuration — connects to H200 services
// ============================================================
const engine = await createMemoryEngine({
  // Production: connect to real databases on H200
  databaseUrl: process.env.DATABASE_URL ?? undefined,
  qdrantUrl: process.env.QDRANT_URL ?? undefined,
  valkeyUrl: process.env.VALKEY_URL ?? undefined,
  // If no DBs → runs in-memory (for this demo)
  personality: 'celiums',
});

// ============================================================
// Create middleware — this is what makes memory automatic
// ============================================================
const memory = new MemoryMiddleware(engine, {
  defaultUserId: 'developer',
  autoStoreUserMessages: true,
  autoStoreAIResponses: true,
  autoConsolidate: true,
  consolidateIntervalMinutes: 30,
});

// ============================================================
// Simulated LLM call (replace with real Gemma 4 / OpenAI / etc)
// ============================================================
async function callLLM(systemPrompt: string, userMessage: string, params: {
  temperature: number;
  maxTokens: number;
  topK: number;
}): Promise<string> {
  // In production, this would be:
  //   const response = await fetch('http://localhost:8000/v1/chat/completions', {
  //     method: 'POST',
  //     body: JSON.stringify({
  //       model: 'celiums-mini-e4b',
  //       temperature: params.temperature,
  //       max_tokens: params.maxTokens,
  //       messages: [
  //         { role: 'system', content: systemPrompt },
  //         { role: 'user', content: userMessage },
  //       ],
  //     }),
  //   });
  return `[Simulated response to: "${userMessage}" with temp=${params.temperature}]`;
}

// ============================================================
// The magic: wrapLLMCall makes everything automatic
// ============================================================

console.log('\n=== Turn 1: User shares excitement ===');
const turn1 = await memory.wrapLLMCall(
  "I just finished building the emotional engine! It works!",
  async (ctx) => {
    console.log(`  Memories recalled: ${ctx.memoriesRecalled}`);
    console.log(`  Emotion: P=${ctx.limbicState.pleasure.toFixed(2)} A=${ctx.limbicState.arousal.toFixed(2)} D=${ctx.limbicState.dominance.toFixed(2)}`);
    console.log(`  LLM params: temp=${ctx.modulation.temperature} topK=${ctx.modulation.topK}`);
    console.log(`  System modifier: "${ctx.emotionalModifier}"`);

    return callLLM(
      ctx.memoryContext + '\n' + ctx.emotionalModifier,
      "I just finished building the emotional engine! It works!",
      ctx.modulation,
    );
  },
  'developer',
);
console.log(`  AI response: ${turn1.response}`);

console.log('\n=== Turn 2: User reports a bug (frustration) ===');
const turn2 = await memory.wrapLLMCall(
  "Damn, the recall function is broken again and I cant figure out why!",
  async (ctx) => {
    console.log(`  Memories recalled: ${ctx.memoriesRecalled}`);
    console.log(`  Emotion: P=${ctx.limbicState.pleasure.toFixed(2)} A=${ctx.limbicState.arousal.toFixed(2)} D=${ctx.limbicState.dominance.toFixed(2)}`);
    console.log(`  LLM params: temp=${ctx.modulation.temperature} topK=${ctx.modulation.topK}`);
    console.log(`  Branch: ${ctx.modulation.activeBranch}`);

    return callLLM(
      ctx.memoryContext + '\n' + ctx.emotionalModifier,
      "Damn, the recall function is broken again!",
      ctx.modulation,
    );
  },
  'developer',
);
console.log(`  AI response: ${turn2.response}`);

console.log('\n=== Turn 3: Ask about past (memory recall) ===');
const turn3 = await memory.wrapLLMCall(
  "What were we working on before?",
  async (ctx) => {
    console.log(`  Memories recalled: ${ctx.memoriesRecalled}`);
    console.log(`  Memory context preview: "${ctx.memoryContext.substring(0, 200)}..."`);
    console.log(`  Emotion: P=${ctx.limbicState.pleasure.toFixed(2)} A=${ctx.limbicState.arousal.toFixed(2)} D=${ctx.limbicState.dominance.toFixed(2)}`);

    return callLLM(
      ctx.memoryContext + '\n' + ctx.emotionalModifier,
      "What were we working on before?",
      ctx.modulation,
    );
  },
  'developer',
);
console.log(`  AI response: ${turn3.response}`);

// Check final emotional state
const finalState = await memory.getEmotionalState('developer');
console.log(`\n=== Final Emotional State ===`);
console.log(`  Pleasure:  ${finalState.state.pleasure.toFixed(3)}`);
console.log(`  Arousal:   ${finalState.state.arousal.toFixed(3)}`);
console.log(`  Dominance: ${finalState.state.dominance.toFixed(3)}`);
console.log(`  Temperature: ${finalState.modulation.temperature}`);
console.log(`  Branch: ${finalState.modulation.activeBranch}`);

// Shutdown — final consolidation
await memory.shutdown('developer');
console.log('\n=== Memory consolidated. Session ended. ===');
console.log('Next session will recall everything automatically.\n');

} // end main

main().catch(err => { console.error(err); process.exit(1); });
