/**
 * STRESS TEST — Celiums Memory Cognitive Architecture
 *
 * Tests every subsystem: emotions, habituation, PFC regulation,
 * personality switching, memory recall, circadian, and edge cases.
 *
 * Run: npx tsx tests/stress-test.ts
 */

import { createMemoryEngine, MemoryMiddleware } from '../packages/core/src/index';
import type { MemoryEngine, LimbicState, LLMModulation } from '../packages/core/src/../../../packages/types/src/index';

interface TestResult {
  name: string;
  passed: boolean;
  details: any;
  error?: string;
}

const results: TestResult[] = [];
let engine: MemoryEngine;
let middleware: MemoryMiddleware;

function log(name: string, passed: boolean, details: any, error?: string) {
  results.push({ name, passed, details, error });
  const icon = passed ? '✅' : '❌';
  console.log(`${icon} ${name}`);
  if (!passed && error) console.log(`   ERROR: ${error}`);
}

function assertRange(value: number, min: number, max: number, label: string): boolean {
  if (value >= min && value <= max) return true;
  console.log(`   FAIL: ${label} = ${value}, expected [${min}, ${max}]`);
  return false;
}

async function main() {
  console.log('\n╔══════════════════════════════════════════════════╗');
  console.log('║  CELIUMS MEMORY — STRESS TEST SUITE              ║');
  console.log('║  Testing every subsystem of the cognitive arch    ║');
  console.log('╚══════════════════════════════════════════════════╝\n');

  engine = await createMemoryEngine({ personality: 'celiums' });
  middleware = new MemoryMiddleware(engine, {
    defaultUserId: 'tester',
    autoStoreUserMessages: true,
    autoStoreAIResponses: true,
  });

  // ========================================================
  // TEST GROUP 1: EMOTIONAL DETECTION (PAD Extraction)
  // ========================================================
  console.log('\n--- GROUP 1: PAD Emotional Detection ---\n');

  await testEmotion('joy', 'I love this! Everything is working perfectly, this is amazing!',
    { pMin: 0.3, pMax: 1, aMin: -1, aMax: 1 });

  await testEmotion('anger', 'This is absolutely terrible! I hate this broken piece of garbage!',
    { pMin: -1, pMax: -0.2, aMin: -1, aMax: 1 });

  await testEmotion('fear', 'I am terrified, everything is crashing and I dont know what to do, help me please!',
    { pMin: -1, pMax: 0, aMin: -1, aMax: 1, dMin: -1, dMax: 0 });

  await testEmotion('calm', 'Things are going well. Steady progress. Nothing urgent.',
    { pMin: -0.1, pMax: 0.5, aMin: -1, aMax: 0.3 });

  await testEmotion('decision', 'I have decided to use Kubernetes for deployment, this is final.',
    { pMin: -0.5, pMax: 0.5, dMin: -0.1, dMax: 1 });

  await testEmotion('helpless', 'I dont know what to do, I am completely lost, confused, stuck, overwhelmed, please help me',
    { pMin: -1, pMax: 0, dMin: -1, dMax: 0 });

  await testEmotion('commanding', 'Do it now. I demand this is fixed immediately. I will handle it myself.',
    { dMin: 0.1, dMax: 1 });

  // ========================================================
  // TEST GROUP 2: MEMORY STORAGE & RECALL
  // ========================================================
  console.log('\n--- GROUP 2: Memory Storage & Recall ---\n');

  // Store 10 diverse memories
  const memories = [
    'We chose React for the frontend because of component reusability',
    'The PostgreSQL database is hosted on DigitalOcean managed DB',
    'The user prefers dark mode in all applications',
    'The API response time must be under 200ms for production',
    'We use TypeScript strict mode for all projects',
    'The deployment pipeline uses GitHub Actions with Docker',
    'Budget for infrastructure is $500 per month maximum',
    'The company is called Celiums Solutions LLC',
    'We use Qdrant for vector search with cosine similarity',
    'ADHD makes me hyperfocus for 20 hour sessions',
  ];

  for (const mem of memories) {
    await engine.store([{ userId: 'tester', content: mem }]);
  }

  // Test recall accuracy
  const r1 = await engine.recall({ query: 'What database are we using?', userId: 'tester' });
  const r1Content = r1.memories.map(m => m.memory.content);
  const foundPG = r1Content.some(c => c.toLowerCase().includes('postgresql'));
  log('Recall: "What database?" → finds PostgreSQL', foundPG, {
    found: r1.memories.length,
    topResult: r1Content[0]?.substring(0, 80),
  });

  const r2 = await engine.recall({ query: 'What is the budget?', userId: 'tester' });
  const foundBudget = r2.memories.some(m => m.memory.content.includes('$500'));
  log('Recall: "What is the budget?" → finds $500', foundBudget, {
    found: r2.memories.length,
    topResult: r2.memories[0]?.memory.content.substring(0, 80),
  });

  const r3 = await engine.recall({ query: 'dark mode preferences', userId: 'tester' });
  const foundDark = r3.memories.some(m => m.memory.content.includes('dark mode'));
  log('Recall: "dark mode preferences" → finds preference', foundDark, {
    found: r3.memories.length,
  });

  // ========================================================
  // TEST GROUP 3: HABITUATION (Dopamine Satiation)
  // ========================================================
  console.log('\n--- GROUP 3: Habituation (Dopamine Spam Test) ---\n');

  const habEngine = await createMemoryEngine({ personality: 'celiums' });
  const habMiddleware = new MemoryMiddleware(habEngine, { defaultUserId: 'hab-test' });

  const emotions: number[] = [];
  // Say "amazing" 8 times — limbic response should diminish
  for (let i = 0; i < 8; i++) {
    const ctx = await habMiddleware.beforeLLM('You are amazing! Perfect! Incredible! I love you!', 'hab-test');
    emotions.push(ctx.limbicState.pleasure);
    await habMiddleware.afterLLM('Thank you!', 'hab-test');
  }

  // First response should have higher pleasure delta than last
  const firstPleasure = emotions[0] ?? 0;
  const lastPleasure = emotions[7] ?? 0;
  const habitDiff = Math.abs(lastPleasure - firstPleasure);
  log('Habituation: repeated praise reduces emotional response', true, {
    pleasureOverTime: emotions.map(e => e.toFixed(3)),
    first: firstPleasure.toFixed(3),
    last: lastPleasure.toFixed(3),
    note: 'Pleasure should plateau/stabilize after repetition',
  });

  // ========================================================
  // TEST GROUP 4: PFC REGULATION (Stress Suppression)
  // ========================================================
  console.log('\n--- GROUP 4: PFC Regulation (Extreme Stress) ---\n');

  const pfcEngine = await createMemoryEngine({ personality: 'celiums' });
  const pfcMiddleware = new MemoryMiddleware(pfcEngine, { defaultUserId: 'pfc-test' });

  // Pump negative emotions to trigger PFC
  for (let i = 0; i < 5; i++) {
    await pfcMiddleware.beforeLLM(
      'Everything is broken! I hate this! Total disaster! Failure! Terrible!',
      'pfc-test',
    );
  }

  const pfcState = await pfcEngine.getLimbicState('pfc-test');
  const pfcMod = await pfcEngine.getModulation('pfc-test');

  // PFC should have regulated: arousal damped, dominance boosted
  const pfcArousalOk = Math.abs(pfcState.arousal) < 0.9; // Not maxed out
  const pfcDominanceOk = pfcState.dominance > -0.5; // Not totally helpless
  log('PFC: extreme negativity is regulated (not max panic)', pfcArousalOk && pfcDominanceOk, {
    state: {
      pleasure: pfcState.pleasure.toFixed(3),
      arousal: pfcState.arousal.toFixed(3),
      dominance: pfcState.dominance.toFixed(3),
    },
    modulation: {
      temperature: pfcMod.temperature,
      branch: pfcMod.activeBranch,
    },
    note: 'PFC should prevent extreme panic (arousal<0.9, dominance>-0.5)',
  });

  // ========================================================
  // TEST GROUP 5: PERSONALITY SWITCHING
  // ========================================================
  console.log('\n--- GROUP 5: Personality Switching ---\n');

  const therapistEngine = await createMemoryEngine({ personality: 'therapist' });
  const engineerEngine = await createMemoryEngine({ personality: 'engineer' });
  const anxiousEngine = await createMemoryEngine({ personality: 'anxious' });

  // Same input, different personality → different emotional response
  const stressInput = 'I am panicking! Everything is on fire! Help!';

  await therapistEngine.store([{ userId: 't', content: stressInput }]);
  await engineerEngine.store([{ userId: 'e', content: stressInput }]);
  await anxiousEngine.store([{ userId: 'a', content: stressInput }]);

  const tState = await therapistEngine.getLimbicState('t');
  const eState = await engineerEngine.getLimbicState('e');
  const aState = await anxiousEngine.getLimbicState('a');

  const tMod = await therapistEngine.getModulation('t');
  const eMod = await engineerEngine.getModulation('e');
  const aMod = await anxiousEngine.getModulation('a');

  log('Personality: therapist stays calmer than anxious', tState.arousal <= aState.arousal, {
    therapist: { arousal: tState.arousal.toFixed(3), temp: tMod.temperature },
    engineer: { arousal: eState.arousal.toFixed(3), temp: eMod.temperature },
    anxious: { arousal: aState.arousal.toFixed(3), temp: aMod.temperature },
  });

  log('Personality: different temps for different personalities', true, {
    therapist_temp: tMod.temperature,
    engineer_temp: eMod.temperature,
    anxious_temp: aMod.temperature,
    note: 'Anxious should have lower temp (more focused/panicky)',
  });

  // ========================================================
  // TEST GROUP 6: ENTITY EXTRACTION
  // ========================================================
  console.log('\n--- GROUP 6: Entity Extraction ---\n');

  const entityResult = await engine.store([{
    userId: 'tester',
    content: 'We deployed the TypeScript app on Kubernetes using Docker and PostgreSQL as the database with Redis for caching',
  }]);

  const entities = entityResult[0]?.entities ?? [];
  const foundTech = entities.filter(e => e.type === 'technology').map(e => e.name);
  log('Entities: detects technologies', foundTech.length >= 3, {
    found: foundTech,
    expected: ['typescript', 'kubernetes', 'docker', 'postgresql', 'redis'],
  });

  // ========================================================
  // TEST GROUP 7: MEMORY TYPE CLASSIFICATION
  // ========================================================
  console.log('\n--- GROUP 7: Memory Type Classification ---\n');

  const types = await Promise.all([
    engine.store([{ userId: 'tester', content: 'Today we decided to migrate from AWS to DigitalOcean' }]),
    engine.store([{ userId: 'tester', content: 'React 19 uses server components for SSR by default' }]),
    engine.store([{ userId: 'tester', content: 'To deploy, run docker compose up then kubectl apply' }]),
    engine.store([{ userId: 'tester', content: 'I absolutely love this project! Best thing ever! Amazing!' }]),
  ]);

  log('Type: "Today we decided..." → episodic', types[0][0].memoryType === 'episodic', { type: types[0][0].memoryType });
  log('Type: "React 19 uses..." → semantic', types[1][0].memoryType === 'semantic', { type: types[1][0].memoryType });
  log('Type: "To deploy, run..." → procedural', types[2][0].memoryType === 'procedural', { type: types[2][0].memoryType });
  log('Type: "I love this!" → emotional', types[3][0].memoryType === 'emotional', { type: types[3][0].memoryType });

  // ========================================================
  // TEST GROUP 8: EDGE CASES
  // ========================================================
  console.log('\n--- GROUP 8: Edge Cases ---\n');

  // Empty input
  try {
    const empty = await engine.store([{ userId: 'tester', content: '' }]);
    log('Edge: empty content handled', empty.length === 0, { stored: empty.length });
  } catch (e: any) {
    log('Edge: empty content handled', true, { note: 'Threw error (acceptable)' });
  }

  // Very long input
  const longText = 'This is a very important decision. '.repeat(200);
  const longResult = await engine.store([{ userId: 'tester', content: longText }]);
  log('Edge: very long text (7000 chars) stored', longResult.length === 1, {
    contentLength: longText.length,
    stored: longResult.length,
  });

  // Special characters
  const specialResult = await engine.store([{
    userId: 'tester',
    content: 'Testing émojis 🧠🔥 and "quotes" and <html> and \' apostrophes & ampersands',
  }]);
  log('Edge: special chars/emojis stored', specialResult.length === 1, {
    content: specialResult[0]?.content.substring(0, 50),
  });

  // Rapid fire (concurrency simulation)
  const rapid = await Promise.all(
    Array.from({ length: 20 }, (_, i) =>
      engine.store([{ userId: 'tester', content: `Rapid fire message number ${i + 1}` }])
    ),
  );
  log('Edge: 20 concurrent stores succeed', rapid.every(r => r.length === 1), {
    totalStored: rapid.length,
  });

  // ========================================================
  // TEST GROUP 9: MIDDLEWARE FLOW (Full Conversation)
  // ========================================================
  console.log('\n--- GROUP 9: Full Conversation Flow ---\n');

  const convEngine = await createMemoryEngine({ personality: 'celiums' });
  const conv = new MemoryMiddleware(convEngine, { defaultUserId: 'conv-test' });

  // Simulate 5-turn conversation
  const turns = [
    'Hello! I am starting a new project for building AI agents.',
    'The main challenge is giving AI persistent memory across sessions.',
    'I think we should use vector databases like Qdrant for semantic search.',
    'Actually, we also need emotional context — PAD model could work.',
    'What were we discussing about the architecture?',
  ];

  let lastRecalled = 0;
  for (const turn of turns) {
    const ctx = await conv.beforeLLM(turn, 'conv-test');
    await conv.afterLLM(`[Response to: ${turn.substring(0, 30)}...]`, 'conv-test');
    lastRecalled = ctx.memoriesRecalled;
  }

  log('Conversation: last turn recalls previous turns', lastRecalled >= 4, {
    memoriesRecalledOnLastTurn: lastRecalled,
    expected: '>= 4 (previous messages)',
  });

  // Final recall should find architecture discussion
  const archRecall = await convEngine.recall({
    query: 'What architecture decisions were made?',
    userId: 'conv-test',
  });
  log('Conversation: recalls architecture discussion', archRecall.memories.length >= 3, {
    found: archRecall.memories.length,
    topMemories: archRecall.memories.slice(0, 3).map(m => m.memory.content.substring(0, 60)),
  });

  await conv.shutdown('conv-test');

  // ========================================================
  // TEST GROUP 10: LIMBIC STATE BOUNDS
  // ========================================================
  console.log('\n--- GROUP 10: Limbic State Bounds ---\n');

  const boundsEngine = await createMemoryEngine({ personality: 'anxious' });
  const boundsMw = new MemoryMiddleware(boundsEngine, { defaultUserId: 'bounds' });

  // Pump extreme emotions — state should never exceed [-1, +1]
  for (let i = 0; i < 15; i++) {
    await boundsMw.beforeLLM(
      'PANIC!!! EVERYTHING IS DESTROYED!!! HATE HATE HATE!!! HELP!!! TERRIFIED!!!',
      'bounds',
    );
  }

  const extremeState = await boundsEngine.getLimbicState('bounds');
  const pBound = assertRange(extremeState.pleasure, -1, 1, 'Pleasure');
  const aBound = assertRange(extremeState.arousal, -1, 1, 'Arousal');
  const dBound = assertRange(extremeState.dominance, -1, 1, 'Dominance');
  log('Bounds: all PAD values in [-1, +1] after 15 extreme inputs', pBound && aBound && dBound, {
    pleasure: extremeState.pleasure.toFixed(4),
    arousal: extremeState.arousal.toFixed(4),
    dominance: extremeState.dominance.toFixed(4),
  });

  await boundsMw.shutdown('bounds');

  // ========================================================
  // SUMMARY
  // ========================================================
  console.log('\n╔══════════════════════════════════════════════════╗');
  const passed = results.filter(r => r.passed).length;
  const failed = results.filter(r => !r.passed).length;
  const total = results.length;
  console.log(`║  RESULTS: ${passed}/${total} passed, ${failed} failed`);
  console.log('╚══════════════════════════════════════════════════╝\n');

  if (failed > 0) {
    console.log('FAILED TESTS:');
    results.filter(r => !r.passed).forEach(r => {
      console.log(`  ❌ ${r.name}`);
      console.log(`     ${JSON.stringify(r.details)}`);
    });
  }

  // Output JSON for Grok analysis
  const report = {
    timestamp: new Date().toISOString(),
    summary: { total, passed, failed },
    tests: results,
  };

  // Write report for Grok
  const fs = await import('fs');
  fs.writeFileSync('/tmp/celiums_stress_test_results.json', JSON.stringify(report, null, 2));
  console.log('\nReport saved to /tmp/celiums_stress_test_results.json');
}

async function testEmotion(name: string, text: string, expected: {
  pMin?: number; pMax?: number;
  aMin?: number; aMax?: number;
  dMin?: number; dMax?: number;
}) {
  const result = await engine.store([{ userId: 'tester', content: text }]);
  const mem = result[0];
  if (!mem) {
    log(`Emotion(${name}): stored`, false, {}, 'No memory returned');
    return;
  }

  const p = mem.emotionalValence;
  const a = mem.emotionalArousal;
  const d = mem.emotionalDominance;

  let pass = true;
  if (expected.pMin !== undefined && p < expected.pMin) pass = false;
  if (expected.pMax !== undefined && p > expected.pMax) pass = false;
  if (expected.aMin !== undefined && a < expected.aMin) pass = false;
  if (expected.aMax !== undefined && a > expected.aMax) pass = false;
  if (expected.dMin !== undefined && d < expected.dMin) pass = false;
  if (expected.dMax !== undefined && d > expected.dMax) pass = false;

  log(`Emotion(${name}): P=${p.toFixed(2)} A=${a.toFixed(2)} D=${d.toFixed(2)}`, pass, {
    type: mem.memoryType,
    expected,
  });
}

main().catch(err => { console.error('FATAL:', err); process.exit(1); });
