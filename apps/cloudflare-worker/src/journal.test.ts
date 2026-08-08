import { describe, expect, it } from 'vitest';
import { OperationConflictError, TenantJournal, type JournalCommand, type JournalStorage, type JournalTransaction } from './journal';

class MemoryStorage implements JournalStorage {
  private readonly values = new Map<string, unknown>();

  get<T>(key: string): Promise<T | undefined> {
    return Promise.resolve(this.values.get(key) as T | undefined);
  }

  list<T>(prefix: string): Promise<T[]> {
    return Promise.resolve([...this.values.entries()]
      .filter(([key]) => key.startsWith(prefix))
      .map(([, value]) => value as T));
  }

  async transaction<T>(closure: (transaction: JournalTransaction) => Promise<T>): Promise<T> {
    return closure({
      get: <Value>(key: string) => this.get<Value>(key),
      put: async <Value>(key: string, value: Value) => {
        this.values.set(key, value);
      },
    });
  }
}

const receipt = {
  status: 200,
  statusText: 'OK',
  headers: { 'content-type': 'application/json' },
  body: '{"ok":true}',
};

function command(operationId: string, body: string, tenantId = 'tenant-a') {
  return {
    operationId,
    tenantId,
    method: 'POST',
    path: '/mcp',
    body,
    bodyHash: `hash:${body}`,
    createdAtMs: 1,
  };
}

describe('TenantJournal', () => {
  it('assigns one sequence to an idempotent retry', async () => {
    const journal = new TenantJournal(new MemoryStorage(), 'tenant-a');
    const first = await journal.prepare(command('op-1', 'first'));
    const retry = await journal.prepare(command('op-1', 'first'));

    expect(retry.command).toEqual(first.command);
    expect(retry.command.sequence).toBe(1);
    expect(retry.reused).toBe(true);
  });

  it('rejects an operation id reused with different content', async () => {
    const journal = new TenantJournal(new MemoryStorage(), 'tenant-a');
    await journal.prepare(command('op-1', 'first'));

    await expect(journal.prepare(command('op-1', 'changed'))).rejects.toBeInstanceOf(
      OperationConflictError,
    );
  });

  it('advances the high-water mark only across contiguous terminal commands', async () => {
    const journal = new TenantJournal(new MemoryStorage(), 'tenant-a');
    await journal.prepare(command('op-1', 'first'));
    await journal.prepare(command('op-2', 'second'));

    const second = await journal.finalize('op-2', 'applied', receipt);
    expect(second.highWaterMark).toBe(0);

    const first = await journal.finalize('op-1', 'applied', receipt);
    expect(first.highWaterMark).toBe(2);
    expect(await journal.highWaterMark()).toBe(2);
  });

  it('keeps the physical tenant boundary in the journal contract', async () => {
    const journal = new TenantJournal(new MemoryStorage(), 'tenant-a');

    await expect(journal.prepare(command('op-1', 'first', 'tenant-b'))).rejects.toThrow(
      'journal tenant mismatch',
    );
  });

  it('stores the terminal receipt for replay', async () => {
    const journal = new TenantJournal(new MemoryStorage(), 'tenant-a');
    await journal.prepare(command('op-1', 'first'));
    await journal.finalize('op-1', 'rejected', receipt);

    const stored = await journal.get('op-1') as JournalCommand;
    expect(stored.status).toBe('rejected');
    expect(stored.receipt).toEqual(receipt);
  });

  it('does not overwrite a terminal receipt on a duplicate finalize', async () => {
    const journal = new TenantJournal(new MemoryStorage(), 'tenant-a');
    await journal.prepare(command('op-1', 'first'));
    await journal.finalize('op-1', 'applied', receipt);
    await journal.finalize('op-1', 'rejected', { ...receipt, status: 500 });

    const stored = await journal.get('op-1') as JournalCommand;
    expect(stored.status).toBe('applied');
    expect(stored.receipt).toEqual(receipt);
  });
});
