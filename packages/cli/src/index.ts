#!/usr/bin/env node

import { createMemoryEngine } from '@celiums-memory/core';
import { MemoryConfig, MemoryEngine } from '@celiums-memory/types';
import { createCeliumsMemoryServer } from '@celiums-memory/server';

/**
 * CLI command names.
 */
type Command =
  | 'start'
  | 'recall'
  | 'stats'
  | 'forget'
  | 'export'
  | 'import'
  | 'help';

/**
 * Creates memory config from environment variables.
 */
function configFromEnv(): MemoryConfig {
  return {
    databaseUrl: process.env.DATABASE_URL,
    qdrantUrl: process.env.QDRANT_URL,
    valkeyUrl: process.env.VALKEY_URL,
  } as MemoryConfig;
}

/**
 * Simple argument parser helpers.
 */
function hasFlag(args: string[], flag: string): boolean {
  return args.includes(flag);
}

/**
 * Reads a flag value from argv.
 */
function getFlagValue(args: string[], flag: string): string | undefined {
  const index = args.indexOf(flag);
  if (index === -1) return undefined;
  return args[index + 1];
}

/**
 * Reads all stdin into a string.
 */
async function readStdin(): Promise<string> {
  const chunks: Buffer[] = [];
  for await (const chunk of process.stdin) {
    chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
  }
  return Buffer.concat(chunks).toString('utf8');
}

/**
 * Writes JSON to stdout.
 */
function printJson(value: unknown): void {
  process.stdout.write(`${JSON.stringify(value, null, 2)}\n`);
}

/**
 * Writes an error and exits.
 */
function fail(message: string, exitCode = 1): never {
  process.stderr.write(`${message}\n`);
  process.exit(exitCode);
}

/**
 * Resolves user ID from CLI flags or environment.
 */
function resolveUserId(args: string[]): string {
  const userId = getFlagValue(args, '--user') ?? process.env.CELIUMS_MEMORY_USER_ID ?? 'default';
  if (!userId.trim()) {
    fail('Missing user ID. Provide --user <id> or set CELIUMS_MEMORY_USER_ID.');
  }
  return userId;
}

/**
 * Prints CLI usage.
 */
function printHelp(): void {
  process.stdout.write(
    [
      'Celiums Memory CLI',
      '',
      'Usage:',
      '  celiums-memory start [--port 3200]',
      '  celiums-memory recall <query> [--user <id>] [--limit <n>] [--min-importance <n>]',
      '  celiums-memory stats [--user <id>]',
      '  celiums-memory forget --all [--user <id>]',
      '  celiums-memory forget --id <memoryId> [--user <id>]',
      '  celiums-memory export [--user <id>] > backup.json',
      '  celiums-memory import [--user <id>] < backup.json',
      '',
      'Environment:',
      '  DATABASE_URL',
      '  QDRANT_URL',
      '  VALKEY_URL',
      '  CELIUMS_MEMORY_USER_ID',
      '',
    ].join('\n'),
  );
}

/**
 * Executes the start command.
 */
async function startCommand(args: string[]): Promise<void> {
  const port = Number(getFlagValue(args, '--port') ?? '3200');
  if (!Number.isFinite(port) || port <= 0) {
    fail('Invalid --port value');
  }

  const app = createCeliumsMemoryServer({
    port,
    config: configFromEnv(),
  });

  await app.start();

  process.stdout.write(`Celiums Memory server started on http://0.0.0.0:${port}\n`);

  const shutdown = async () => {
    await app.stop();
    process.exit(0);
  };

  process.on('SIGINT', shutdown);
  process.on('SIGTERM', shutdown);
}

/**
 * Executes the recall command.
 */
async function recallCommand(engine: MemoryEngine, args: string[]): Promise<void> {
  const query = args[1];
  if (!query) {
    fail('Usage: celiums-memory recall <query>');
  }

  const userId = resolveUserId(args);
  const limit = Number(getFlagValue(args, '--limit') ?? '10');
  const minImportance = Number(getFlagValue(args, '--min-importance') ?? '0');

  const result = await (engine as any).recall({
    userId,
    query,
    limit,
    minImportance,
  });

  printJson(result);
}

/**
 * Executes the stats command.
 */
async function statsCommand(engine: MemoryEngine, args: string[]): Promise<void> {
  const userId = resolveUserId(args);
  const result = await (engine as any).getStats({ userId });
  printJson(result);
}

/**
 * Executes the forget command.
 */
async function forgetCommand(engine: MemoryEngine, args: string[]): Promise<void> {
  const userId = resolveUserId(args);
  const all = hasFlag(args, '--all');
  const memoryId = getFlagValue(args, '--id');

  if (!all && !memoryId) {
    fail('Usage: celiums-memory forget --all OR celiums-memory forget --id <memoryId>');
  }

  const result = all
    ? await (engine as any).deleteAllMemories({ userId })
    : await (engine as any).deleteMemory({ userId, memoryId });

  printJson(result ?? { success: true });
}

/**
 * Executes the export command.
 */
async function exportCommand(engine: MemoryEngine, args: string[]): Promise<void> {
  const userId = resolveUserId(args);
  const result = await (engine as any).exportMemories({ userId });
  printJson(result);
}

/**
 * Executes the import command.
 */
async function importCommand(engine: MemoryEngine, args: string[]): Promise<void> {
  const userId = resolveUserId(args);
  const stdin = await readStdin();

  if (!stdin.trim()) {
    fail('No input provided on stdin for import');
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(stdin);
  } catch {
    fail('Invalid JSON provided to import');
  }

  const payload =
    parsed && typeof parsed === 'object' && 'memories' in (parsed as Record<string, unknown>)
      ? (parsed as { memories: unknown[] })
      : { memories: Array.isArray(parsed) ? parsed : [] };

  if (!Array.isArray(payload.memories)) {
    fail('Import payload must be an array or an object with a "memories" array');
  }

  const result = await (engine as any).importMemories({
    userId,
    memories: payload.memories,
  });

  printJson(result);
}

/**
 * Main CLI entrypoint.
 */
export async function main(): Promise<void> {
  const args = process.argv.slice(2);
  const command = (args[0] ?? 'help') as Command;

  if (command === 'help' || command === '--help' || command === '-h') {
    printHelp();
    return;
  }

  if (command === 'start') {
    await startCommand(args.slice(1));
    return;
  }

  const engine: MemoryEngine = createMemoryEngine(configFromEnv());

  switch (command) {
    case 'recall':
      await recallCommand(engine, args);
      return;
    case 'stats':
      await statsCommand(engine, args);
      return;
    case 'forget':
      await forgetCommand(engine, args);
      return;
    case 'export':
      await exportCommand(engine, args);
      return;
    case 'import':
      await importCommand(engine, args);
      return;
    default:
      printHelp();
      process.exitCode = 1;
  }
}

if (require.main === module) {
  main().catch((error) => {
    process.stderr.write(
      `Celiums Memory CLI failed: ${
        error instanceof Error ? error.message : String(error)
      }\n`,
    );
    process.exit(1);
  });
}