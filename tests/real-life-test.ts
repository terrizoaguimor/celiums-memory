/**
 * REAL LIFE TEST — Casual conversation, random topics, context death
 *
 * No tech talk. No architecture. Just a human chatting about life.
 * Movies, food, pets, childhood, sports, travel, random nonsense.
 * Then kill context. Then ask about it all.
 *
 * This is the REAL test. Not "what database?" — but "what's my dog's name?"
 *
 * Run: npx tsx tests/real-life-test.ts
 */

import { createMemoryEngine, MemoryMiddleware } from '../packages/core/src/index';

async function main() {
  console.log('\n╔══════════════════════════════════════════════════════════════╗');
  console.log('║  REAL LIFE TEST — Can the AI remember casual conversation?  ║');
  console.log('║  Movies, food, pets, childhood, travel — then context dies  ║');
  console.log('╚══════════════════════════════════════════════════════════════╝\n');

  // ============================================================
  // SESSION 1: Just chatting about random life stuff
  // ============================================================
  console.log('═══ SESSION 1: Chatting about life (40 turns) ═══\n');

  const engine = await createMemoryEngine({ personality: 'celiums' });
  const mw = new MemoryMiddleware(engine, {
    defaultUserId: 'developer',
    autoStoreUserMessages: true,
    autoStoreAIResponses: true,
  });

  const chat = [
    // Pets
    { user: "My dog is called Luna, she is a golden retriever and she is 3 years old", ai: "Luna sounds adorable! Golden retrievers are the best." },
    { user: "Luna loves to swim in the river near my apartment in the city", ai: "That must be a great spot for her!" },
    { user: "I also have a cat named Simón, he is black and very lazy", ai: "Classic cat behavior, Simón sounds chill." },

    // Food
    { user: "My favorite food is bandeja paisa, its a traditional Colombian dish", ai: "That's a hearty meal! Beans, rice, chicharrón..." },
    { user: "I eat arepas every single morning for breakfast, with cheese and butter", ai: "Arepas con queso, can't beat that." },
    { user: "My favorite restaurant is called The Blue Cafe, its in the city and the chef is Chef Rodriguez", ai: "The Blue Cafe is world-famous! Amazing tasting menu." },
    { user: "I am allergic to shrimp, it makes my throat swell up", ai: "That's serious, I'll remember to never suggest shrimp." },
    { user: "My favorite coffee is from Huila region, I drink it black no sugar", ai: "Huila coffee, black. A purist." },

    // Movies & Music
    { user: "My favorite movie of all time is Interstellar by Christopher Nolan", ai: "The docking scene still gives me chills." },
    { user: "I cry every time I watch the scene where Cooper watches the videos from his kids", ai: "That scene is devastating. Pure emotion." },
    { user: "I also love The Matrix, I have watched it probably 30 times", ai: "Red pill or blue pill? I know your answer." },
    { user: "My favorite band is Pink Floyd, especially the album The Dark Side of the Moon", ai: "Time and Money are masterpieces." },
    { user: "I listen to reggaeton when I code at 2am, it keeps the energy up", ai: "Daddy Yankee and code, I respect it." },

    // Childhood & Family
    { user: "I grew up in a coastal city, near the lake", ai: "Beautiful area!" },
    { user: "My mother's name is Sarah and she makes the best hallacas in December", ai: "Traditional hallacas in December, there's nothing like it." },
    { user: "I have two brothers, the older one is called Eduardo and the younger one is Andrés", ai: "Three brothers, nice family." },
    { user: "My father taught me to play chess when I was 6 years old, I still play every week", ai: "Chess from age 6, that explains the strategic thinking." },
    { user: "I moved abroad in 2020 for work opportunities", ai: "That was a big life change." },

    // Travel
    { user: "The best trip I ever took was to Cartagena, the walled city is magical", ai: "Cartagena's old town at sunset is unforgettable." },
    { user: "I want to visit Japan someday, specifically Tokyo and Kyoto", ai: "Japan is on everyone's list for a reason." },
    { user: "I have been to several cities but the city is my favorite city", ai: "Great weather makes it the winner." },
    { user: "My dream is to live in a house with a mountain view and a home office", ai: "Many cities have those views." },

    // Random facts about himself
    { user: "I wake up at 5am every day, even on weekends", ai: "Early bird. That's discipline." },
    { user: "My birthday is on March 15th, I am a Pisces", ai: "March 15, Pisces. Creative and intuitive." },
    { user: "I wear glasses, I have been wearing them since I was 12", ai: "Glasses since 12, the developer origin story." },
    { user: "My lucky number is 7, always has been", ai: "7 it is. Classic lucky number." },
    { user: "I am terrified of spiders, like genuinely phobic", ai: "Arachnophobia noted. No spider emojis ever." },
    { user: "I used to skateboard when I was a teenager", ai: "Skateboarding in the summer heat, that's dedication." },

    // Opinions
    { user: "I think pineapple on pizza is actually good and people who disagree are wrong", ai: "Bold take. Hawaiian pizza defender." },
    { user: "Star Wars is overrated, Star Trek is the real science fiction", ai: "Controversial! But I see your point on the science." },
    { user: "I believe cryptocurrency is mostly a scam except for Bitcoin", ai: "Bitcoin maxi. Noted." },
    { user: "The best programming language ever created is JavaScript, despite its flaws", ai: "JavaScript: the language you love to hate." },

    // Emotional moments
    { user: "The proudest moment of my life was when my mom saw my first website", ai: "That must have been incredible for both of you." },
    { user: "I get really anxious before public speaking, my hands shake", ai: "Public speaking anxiety is super common." },
    { user: "Last week I stayed up until 4am debugging a memory leak and I found it, it felt amazing", ai: "That eureka moment at 4am is unmatched." },
    { user: "Sometimes I miss home so much it physically hurts", ai: "Nostalgia for home runs deep." },

    // Current situation
    { user: "Right now I am sitting in my apartment in Downtown, Capital City, with Luna sleeping next to me", ai: "Sounds peaceful. That sounds like a lovely neighborhood." },
    { user: "The weather today is 24 degrees celsius and cloudy, perfect for coding", ai: "Perfect spring weather." },
    { user: "I am drinking my fourth coffee of the day and it is only 2pm", ai: "On track for your 6-cup daily goal." },
  ];

  let turn = 0;
  for (const c of chat) {
    await mw.beforeLLM(c.user, 'developer');
    await mw.afterLLM(c.ai, 'developer');
    turn++;
    if (turn % 10 === 0) console.log(`  [${turn}/${chat.length}] turns stored...`);
  }

  await mw.consolidateNow('developer');
  console.log(`  ✅ Session 1 complete: ${turn} turns\n`);

  // ============================================================
  // CONTEXT DIES
  // ============================================================
  console.log('  💀💀💀 CONTEXT WINDOW DIED 💀💀💀\n');

  // ============================================================
  // SESSION 2: Brand new — ask about everything
  // ============================================================
  console.log('═══ SESSION 2: Do you remember my life? ═══\n');

  const engine2 = await createMemoryEngine({ personality: 'celiums' });
  const mw2 = new MemoryMiddleware(engine2, { defaultUserId: 'developer' });

  // Simulate persistence — load all memories into new engine
  for (const c of chat) {
    await engine2.store([{ userId: 'developer', content: c.user }]);
  }

  const tests = [
    // Pets
    { q: "What is my dog's name?", must: "luna", cat: "pets" },
    { q: "What breed is my dog?", must: "golden retriever", cat: "pets" },
    { q: "What is my cat called?", must: "simón", cat: "pets" },

    // Food
    { q: "What do I eat for breakfast?", must: "arepa", cat: "food" },
    { q: "What food am I allergic to?", must: "shrimp", cat: "food" },
    { q: "What is my favorite restaurant?", must: "cielo", cat: "food" },
    { q: "How do I drink my coffee?", must: "black", cat: "food" },
    { q: "What region is my favorite coffee from?", must: "huila", cat: "food" },

    // Movies & Music
    { q: "What is my favorite movie?", must: "interstellar", cat: "entertainment" },
    { q: "What movie have I watched 30 times?", must: "matrix", cat: "entertainment" },
    { q: "What is my favorite band?", must: "pink floyd", cat: "entertainment" },
    { q: "What album do I love most?", must: "dark side", cat: "entertainment" },

    // Family
    { q: "What is my mother's name?", must: "carmen", cat: "family" },
    { q: "What are my brothers' names?", must: "eduardo", cat: "family" },
    { q: "Where did I grow up?", must: "hometown", cat: "family" },
    { q: "When did I move abroad?", must: "2020", cat: "family" },
    { q: "What game did my father teach me?", must: "chess", cat: "family" },

    // Personal facts
    { q: "When is my birthday?", must: "march 15", cat: "personal" },
    { q: "What am I scared of?", must: "spider", cat: "personal" },
    { q: "What is my lucky number?", must: "7", cat: "personal" },
    { q: "What time do I wake up?", must: "5am", cat: "personal" },
    { q: "What zodiac sign am I?", must: "pisces", cat: "personal" },

    // Opinions
    { q: "What do I think about pineapple on pizza?", must: "good", cat: "opinions" },
    { q: "Do I prefer Star Wars or Star Trek?", must: "star trek", cat: "opinions" },
    { q: "What do I think about crypto?", must: "bitcoin", cat: "opinions" },

    // Location
    { q: "What neighborhood do I live in?", must: "poblado", cat: "location" },
    { q: "What city do I live in?", must: "the city", cat: "location" },
    { q: "Where do I want to travel next?", must: "japan", cat: "travel" },
  ];

  let passed = 0;
  let failed = 0;
  const failures: string[] = [];

  for (const t of tests) {
    const result = await engine2.recall({ query: t.q, userId: 'developer', limit: 5 });
    const allContent = result.memories.map(m => m.memory.content.toLowerCase()).join(' ');
    const found = allContent.includes(t.must.toLowerCase());

    if (found) {
      passed++;
      console.log(`  ✅ [${t.cat}] "${t.q}" → found "${t.must}"`);
    } else {
      failed++;
      const top = result.memories[0]?.memory.content.substring(0, 70) ?? 'NONE';
      console.log(`  ❌ [${t.cat}] "${t.q}" → expected "${t.must}"`);
      console.log(`     got: "${top}"`);
      failures.push(`${t.q} → expected "${t.must}"`);
    }
  }

  // ============================================================
  // SUMMARY
  // ============================================================
  console.log('\n╔══════════════════════════════════════════════════════════════╗');
  console.log(`║  REAL LIFE RECALL: ${passed}/${tests.length} (${Math.round(passed/tests.length*100)}%)${' '.repeat(35 - String(passed).length - String(tests.length).length)}║`);
  console.log(`║  Conversation turns: ${chat.length}                                     ║`);
  console.log(`║  Recall queries: ${tests.length}                                        ║`);
  console.log('╚══════════════════════════════════════════════════════════════╝');

  if (failed > 0) {
    console.log(`\nFAILED (${failed}):`);
    failures.forEach(f => console.log(`  ❌ ${f}`));
  }

  if (passed === tests.length) {
    console.log('\n🧠 THE AI REMEMBERS YOUR LIFE. EVEN THE TRIVIAL STUFF.\n');
  } else {
    const pct = Math.round(passed/tests.length*100);
    console.log(`\n${pct >= 80 ? '✅' : '⚠️'} ${pct}% recall on casual life conversation.\n`);
  }
}

main().catch(err => { console.error('FATAL:', err); process.exit(1); });
