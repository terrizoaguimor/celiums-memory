const COMMAND_PREFIX = 'journal:command:';
const SEQUENCE_PREFIX = 'journal:sequence:';
const NEXT_SEQUENCE_KEY = 'journal:next-sequence';
const HIGH_WATER_MARK_KEY = 'journal:high-water-mark';

export type JournalTerminalStatus = 'applied' | 'rejected';

export interface JournalReceipt {
  status: number;
  statusText: string;
  headers: Record<string, string>;
  body: string;
}

export interface JournalCommand {
  operationId: string;
  tenantId: string;
  method: string;
  path: string;
  body: string;
  bodyHash: string;
  bodyRef?: string;
  contentType?: string;
  mcpSessionId?: string;
  sequence: number;
  status: 'pending' | JournalTerminalStatus;
  createdAtMs: number;
  receipt?: JournalReceipt;
}

export interface JournalTransaction {
  get<T>(key: string): Promise<T | undefined>;
  put<T>(key: string, value: T): Promise<void>;
}

export interface JournalStorage {
  get<T>(key: string): Promise<T | undefined>;
  list<T>(prefix: string): Promise<T[]>;
  transaction<T>(closure: (transaction: JournalTransaction) => Promise<T>): Promise<T>;
}

export interface PrepareCommand {
  operationId: string;
  tenantId: string;
  method: string;
  path: string;
  body: string;
  bodyHash: string;
  bodyRef?: string;
  contentType?: string;
  mcpSessionId?: string;
  createdAtMs: number;
}

export interface PreparedCommand {
  command: JournalCommand;
  reused: boolean;
}

export class OperationConflictError extends Error {
  constructor(operationId: string) {
    super(`operation_id was reused with different content: ${operationId}`);
    this.name = 'OperationConflictError';
  }
}

export class TenantJournal {
  constructor(
    private readonly storage: JournalStorage,
    private readonly tenantId: string,
  ) {}

  async prepare(command: PrepareCommand): Promise<PreparedCommand> {
    if (command.tenantId !== this.tenantId) {
      throw new Error('journal tenant mismatch');
    }

    return this.storage.transaction(async (transaction) => {
      const key = commandKey(command.operationId);
      const existing = await transaction.get<JournalCommand>(key);
      if (existing) {
        if (
          existing.bodyHash !== command.bodyHash ||
          existing.path !== command.path ||
          existing.method !== command.method ||
          existing.tenantId !== command.tenantId ||
          existing.bodyRef !== command.bodyRef ||
          existing.mcpSessionId !== command.mcpSessionId
        ) {
          throw new OperationConflictError(command.operationId);
        }
        return { command: existing, reused: true };
      }

      const nextSequence = (await transaction.get<number>(NEXT_SEQUENCE_KEY) ?? 0) + 1;
      const record: JournalCommand = {
        ...command,
        sequence: nextSequence,
        status: 'pending',
      };
      await transaction.put(key, record);
      await transaction.put(sequenceKey(nextSequence), command.operationId);
      await transaction.put(NEXT_SEQUENCE_KEY, nextSequence);
      return { command: record, reused: false };
    });
  }

  async get(operationId: string): Promise<JournalCommand | undefined> {
    return this.storage.get<JournalCommand>(commandKey(operationId));
  }

  async pending(): Promise<JournalCommand[]> {
    const commands = await this.storage.list<JournalCommand>(COMMAND_PREFIX);
    return commands.filter((command) => command.status === 'pending')
      .sort((left, right) => left.sequence - right.sequence);
  }

  async finalize(
    operationId: string,
    status: JournalTerminalStatus,
    receipt: JournalReceipt,
  ): Promise<{ command: JournalCommand; highWaterMark: number }> {
    return this.storage.transaction(async (transaction) => {
      const key = commandKey(operationId);
      const command = await transaction.get<JournalCommand>(key);
      if (!command) throw new Error(`journal operation does not exist: ${operationId}`);

      if (command.status !== 'pending') {
        return { command, highWaterMark: await currentHighWaterMark(transaction) };
      }

      const finalized = { ...command, status, receipt };
      await transaction.put(key, finalized);
      const highWaterMark = await advanceHighWaterMark(transaction);
      return { command: finalized, highWaterMark };
    });
  }

  async highWaterMark(): Promise<number> {
    return (await this.storage.get<number>(HIGH_WATER_MARK_KEY)) ?? 0;
  }
}

async function currentHighWaterMark(transaction: JournalTransaction): Promise<number> {
  return (await transaction.get<number>(HIGH_WATER_MARK_KEY)) ?? 0;
}

async function advanceHighWaterMark(transaction: JournalTransaction): Promise<number> {
  let highWaterMark = await currentHighWaterMark(transaction);

  while (true) {
    const nextSequence = highWaterMark + 1;
    const operationId = await transaction.get<string>(sequenceKey(nextSequence));
    if (!operationId) break;

    const command = await transaction.get<JournalCommand>(commandKey(operationId));
    if (!command || command.status === 'pending') break;
    highWaterMark = nextSequence;
  }

  await transaction.put(HIGH_WATER_MARK_KEY, highWaterMark);
  return highWaterMark;
}

function commandKey(operationId: string): string {
  return `${COMMAND_PREFIX}${operationId}`;
}

function sequenceKey(sequence: number): string {
  return `${SEQUENCE_PREFIX}${sequence}`;
}
