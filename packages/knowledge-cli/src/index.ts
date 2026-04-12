#!/usr/bin/env node
/**
 * @celiums/cli — Command-line interface for the Celiums Knowledge Engine
 *
 * Usage:
 *   celiums start              Start the engine with REST + MCP adapters
 *   celiums start --mcp        Start MCP server only (stdio mode)
 *   celiums start --rest       Start REST API only
 *   celiums start --a2a        Start A2A agent only
 *   celiums start --all        Start all adapters
 *   celiums search <query>     Search for modules
 *   celiums get <name>         Get a specific module
 *   celiums health             Check engine health
 *   celiums stats              Show module statistics
 *
 * Environment:
 *   DATABASE_URL       PostgreSQL connection string
 *   QDRANT_URL         Qdrant vector search URL
 *   REDIS_URL          Redis/Valkey cache URL (optional)
 *   INFERENCE_URL      AI inference endpoint (optional)
 *   INFERENCE_API_KEY  AI inference API key (optional)
 *   PORT               REST API port (default: 3000)
 *
 * @package @celiums/cli
 * @license Apache-2.0
 */

import { createEngine } from "@celiums/core";
import { McpAdapter } from "@celiums/adapter-mcp";
import { RestAdapter } from "@celiums/adapter-rest";
import { A2AAdapter } from "@celiums/adapter-a2a";
import type { CeliumsConfig } from "@celiums/types";
import pg from "pg";

// ──────────────────────────────────────────────────────────
// Configuration from environment
// ──────────────────────────────────────────────────────────

function loadConfig(): CeliumsConfig {
  const databaseUrl = process.env.DATABASE_URL;
  if (!databaseUrl) {
    console.error("Error: DATABASE_URL environment variable is required.");
    console.error("Example: DATABASE_URL=postgresql://USER:PASSWORD@localhost:5432/celiums");
    process.exit(1);
  }

  return {
    database: {
      url: databaseUrl,
      maxConnections: parseInt(process.env.DB_MAX_CONNECTIONS ?? "20", 10),
    },
    vector: {
      url: process.env.QDRANT_URL ?? "http://localhost:6333",
      collection: process.env.QDRANT_COLLECTION ?? "celiums_modules",
      apiKey: process.env.QDRANT_API_KEY,
    },
    cache: process.env.REDIS_URL
      ? { url: process.env.REDIS_URL }
      : undefined,
    embeddings: {
      model: process.env.EMBEDDING_MODEL ?? "nomic-ai/nomic-embed-text-v1.5",
      dimension: parseInt(process.env.EMBEDDING_DIM ?? "768", 10),
      endpoint: process.env.EMBEDDING_URL,
    },
    inference: process.env.INFERENCE_URL
      ? {
          endpoint: process.env.INFERENCE_URL,
          apiKey: process.env.INFERENCE_API_KEY,
          defaultModel: process.env.INFERENCE_MODEL ?? process.env.INFERENCE_MODEL || "default",
        }
      : undefined,
    server: {
      port: parseInt(process.env.PORT ?? "3000", 10),
      host: process.env.HOST ?? "0.0.0.0",
      cors: process.env.CORS !== "false",
    },
  };
}

// ──────────────────────────────────────────────────────────
// Commands
// ──────────────────────────────────────────────────────────

async function startCommand(args: string[]): Promise<void> {
  const config = loadConfig();
  const engine = await createEngine(config);

  const health = await engine.health();
  console.log(`\n  celiums v0.1.0`);
  console.log(`  ${health.details.moduleCount?.toLocaleString()} modules loaded\n`);

  const mode = args[0] ?? "--all";

  if (mode === "--mcp") {
    console.log("  Starting MCP server (stdio)...");
    const mcp = new McpAdapter(engine);
    await mcp.start();
  } else if (mode === "--rest") {
    console.log(`  Starting REST API on port ${config.server?.port ?? 3000}...`);
    const rest = new RestAdapter(engine, config.server);
    await rest.start();
  } else if (mode === "--a2a") {
    const a2aPort = parseInt(process.env.A2A_PORT ?? "3001", 10);
    console.log(`  Starting A2A agent on port ${a2aPort}...`);
    const a2a = new A2AAdapter(engine, { port: a2aPort });
    await a2a.start();
  } else {
    // --all: Start REST + A2A (MCP is stdio, started separately)
    const port = config.server?.port ?? 3000;
    const a2aPort = parseInt(process.env.A2A_PORT ?? "3001", 10);

    console.log(`  Starting REST API on port ${port}...`);
    const rest = new RestAdapter(engine, config.server);
    await rest.start();

    console.log(`  Starting A2A agent on port ${a2aPort}...`);
    const a2a = new A2AAdapter(engine, { port: a2aPort });
    await a2a.start();

    console.log(`\n  Ready.`);
    console.log(`  REST API:    http://localhost:${port}`);
    console.log(`  A2A Agent:   http://localhost:${a2aPort}/.well-known/agent.json`);
    console.log(`  MCP Server:  npx @celiums/cli start --mcp\n`);
  }
}

async function searchCommand(args: string[]): Promise<void> {
  const query = args.join(" ");
  if (!query) {
    console.error("Usage: celiums search <query>");
    process.exit(1);
  }

  const config = loadConfig();
  const engine = await createEngine(config);
  const results = await engine.search({ query, maxResults: 10 });

  console.log(`\n  Found ${results.totalMatches} modules in ${results.searchTimeMs}ms:\n`);
  for (const r of results.results) {
    console.log(`  ${r.score.toFixed(1)}%  ${r.module.name}  (${r.module.category})`);
  }
  console.log();

  await engine.close();
}

async function getCommand(args: string[]): Promise<void> {
  const name = args[0];
  if (!name) {
    console.error("Usage: celiums get <module-name>");
    process.exit(1);
  }

  const config = loadConfig();
  const engine = await createEngine(config);
  const module = await engine.getModule(name);

  if (!module) {
    console.error(`Module "${name}" not found.`);
    process.exit(1);
  }

  console.log(module.content.content);
  await engine.close();
}

async function healthCommand(): Promise<void> {
  const config = loadConfig();
  const engine = await createEngine(config);
  const health = await engine.health();

  console.log(`\n  Status: ${health.status}`);
  for (const [key, value] of Object.entries(health.details)) {
    console.log(`  ${key}: ${value}`);
  }
  console.log();

  await engine.close();
}

async function statsCommand(): Promise<void> {
  const config = loadConfig();
  const engine = await createEngine(config);
  const index = await engine.getIndex();

  console.log(`\n  Celiums Knowledge Engine`);
  console.log(`  Total modules: ${index.totalModules.toLocaleString()}\n`);
  console.log(`  Categories:`);

  const sorted = Object.entries(index.categories).sort(([, a], [, b]) => b - a);
  for (const [cat, count] of sorted.slice(0, 20)) {
    const bar = "\u2588".repeat(Math.ceil(count / Math.max(...sorted.map(([, c]) => c)) * 30));
    console.log(`  ${cat.padEnd(25)} ${count.toString().padStart(6)}  ${bar}`);
  }
  if (sorted.length > 20) {
    console.log(`  ... and ${sorted.length - 20} more categories`);
  }
  console.log();

  await engine.close();
}

// ──────────────────────────────────────────────────────────
// init command — first-run onboarding
// ──────────────────────────────────────────────────────────

async function initCommand(args: string[]): Promise<void> {
  // Dynamic import to avoid pulling in @celiums/memory deps when not needed
  const { runInit, printConnectionInstructions } = await import(
    /* webpackIgnore: true */ '@celiums/memory/init' // resolve via workspace
  ).catch(() => {
    // Fallback: inline minimal init if @celiums/memory isn't installed
    return {
      runInit: async (opts: any) => {
        const readline = await import('node:readline');
        const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
        const ask = (q: string, def: string) => new Promise<string>(r => {
          rl.question(`  ${q} [${def}]: `, a => r(a.trim() || def));
        });
        console.log('\n🧠 Welcome to Celiums — memory that remembers how it felt.');
        console.log('  Let\'s set up your profile.\n');
        const name = await ask('Your name?', process.env.USER || 'developer');
        const tz = Intl.DateTimeFormat().resolvedOptions().timeZone;
        const offset = -new Date().getTimezoneOffset() / 60;
        console.log(`  Timezone: ${tz} (UTC${offset >= 0 ? '+' : ''}${offset})`);
        const chronoChoice = await ask('Morning/neutral/night?', 'neutral');
        const chrono = (['morning', 'neutral', 'night'].includes(chronoChoice) ? chronoChoice : 'neutral') as 'morning' | 'neutral' | 'night';
        const peakHour = chrono === 'morning' ? 10 : chrono === 'night' ? 15 : 12;
        rl.close();
        return { locale: 'en' as const, name, timezoneIana: tz, timezoneOffset: offset, peakHour, chronotype: chrono };
      },
      printConnectionInstructions: (locale: string, url: string) => {
        console.log(`\n  Connect to Claude Code:\n    claude mcp add celiums ${url}/mcp\n`);
      },
    };
  });

  const isDefaults = args.includes('--defaults');
  const result = await runInit({ defaults: isDefaults });

  // Hydrate modules
  const databaseUrl = process.env.DATABASE_URL;
  if (databaseUrl) {
    try {
      const { hydrate } = await import('@celiums/modules-starter');
      const url = new URL(databaseUrl);
      const pool = new pg.Pool({
        host: url.hostname,
        port: parseInt(url.port || '5432', 10),
        database: url.pathname.replace(/^\//, ''),
        user: decodeURIComponent(url.username),
        password: decodeURIComponent(url.password),
      });
      console.log('  Loading 5,100 expert modules...');
      const h = await hydrate({ pg: pool });
      console.log(`  ✓ ${h.inserted} modules loaded in ${h.totalMs}ms`);

      // Create user profile
      await pool.query(
        `CREATE TABLE IF NOT EXISTS user_profiles (
          user_id TEXT PRIMARY KEY,
          timezone_iana TEXT NOT NULL DEFAULT 'UTC',
          timezone_offset NUMERIC(5,2) NOT NULL DEFAULT 0,
          peak_hour NUMERIC(4,2) NOT NULL DEFAULT 12,
          pad_pleasure NUMERIC(5,4) NOT NULL DEFAULT 0,
          pad_arousal NUMERIC(5,4) NOT NULL DEFAULT 0,
          pad_dominance NUMERIC(5,4) NOT NULL DEFAULT 0,
          communication_style TEXT NOT NULL DEFAULT 'en',
          last_interaction TIMESTAMPTZ NOT NULL DEFAULT NOW(),
          interaction_count BIGINT NOT NULL DEFAULT 0,
          created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
          updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
        )`,
      );
      await pool.query(
        `INSERT INTO user_profiles (user_id, timezone_iana, timezone_offset, peak_hour, communication_style)
         VALUES ($1, $2, $3, $4, $5)
         ON CONFLICT (user_id) DO UPDATE SET
           timezone_iana = EXCLUDED.timezone_iana,
           timezone_offset = EXCLUDED.timezone_offset,
           peak_hour = EXCLUDED.peak_hour,
           communication_style = EXCLUDED.communication_style`,
        [result.name, result.timezoneIana, result.timezoneOffset, result.peakHour, result.locale],
      );
      console.log(`  ✓ Profile created: ${result.name}`);
      await pool.end();
    } catch (err: any) {
      console.warn(`  ⚠ Module loading skipped: ${err.message}`);
      console.warn('  Install @celiums/modules-starter: npm i @celiums/modules-starter');
    }
  } else {
    console.log('  ℹ Set DATABASE_URL to enable module loading and persistence.');
  }

  // Auto-wire detected IDEs
  let wiredIdes: string[] = [];
  try {
    const { autoWireIdes } = await import('@celiums/memory/init').catch(() => ({ autoWireIdes: null }));
    if (autoWireIdes) {
      console.log('  Detecting IDEs...');
      wiredIdes = autoWireIdes(result.locale);
    }
  } catch { /* skip auto-wire if init module not available */ }

  const port = process.env.PORT ?? '3210';
  console.log(`\n  ✓ Celiums initialized!`);
  printConnectionInstructions(result.locale, `http://localhost:${port}`, wiredIdes);
}

// ──────────────────────────────────────────────────────────
// Main
// ──────────────────────────────────────────────────────────

async function main(): Promise<void> {
  const [command, ...args] = process.argv.slice(2);

  switch (command) {
    case "init":
      await initCommand(args);
      break;
    case "start":
      await startCommand(args);
      break;
    case "search":
      await searchCommand(args);
      break;
    case "get":
      await getCommand(args);
      break;
    case "health":
      await healthCommand();
      break;
    case "stats":
      await statsCommand();
      break;
    default:
      console.log(`
  celiums — The Expert Knowledge Engine for AI

  Usage:
    celiums init                                First-run setup (profile + modules)
    celiums start [--all|--mcp|--rest|--a2a]   Start the engine
    celiums search <query>                      Search for modules
    celiums get <module-name>                   Get a specific module
    celiums health                              Check engine health
    celiums stats                               Show module statistics

  Environment:
    DATABASE_URL     PostgreSQL connection (required)
    QDRANT_URL       Qdrant server (default: http://localhost:6333)
    PORT             REST API port (default: 3000)

  Documentation: https://celiums.ai/docs
      `);
      break;
  }
}

main().catch((error) => {
  console.error("Fatal:", error.message);
  process.exit(1);
});
