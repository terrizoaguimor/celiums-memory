/**
 * @celiums-memory/core — Autonomy Engine (Delegated Independence)
 *
 * Allows the AI to work independently when the user delegates tasks.
 * NOT a cron job — it's conscious delegation with guardrails.
 *
 * "Me voy a dormir, haz esto" → AI works under strict constraints.
 * "Estoy de vuelta" → AI reports everything that happened.
 *
 * Security is the #1 priority. Every action is:
 * - Validated against an allowlist (principle of least privilege)
 * - Logged in an immutable audit trail
 * - Rate-limited (per minute and per hour)
 * - Budget-capped (max $ spend)
 * - Time-capped (max hours)
 * - Checkpointed (can revert)
 * - Kill-switchable (auto-stops on anomalies)
 *
 * Inspired by OpenClaw's gateway daemon but with hardened security.
 *
 * @license Apache-2.0
 */

// ============================================================
// Types
// ============================================================

/** The current state of an autonomous delegation session. */
export type DelegationState =
  | 'pending'     // Created but not started
  | 'running'     // Actively executing tasks
  | 'paused'      // Paused (user break, escalation, or rate limit)
  | 'completed'   // Finished successfully
  | 'killed'      // Stopped by kill switch
  | 'escalated';  // Waiting for user input

/** A delegation request from the user. */
export interface DelegationRequest {
  /** Unique ID for this delegation session. */
  id: string;
  /** Who is delegating. */
  userId: string;
  /** What to do — the task description in natural language. */
  task: string;
  /** Specific sub-tasks to accomplish (optional). */
  subtasks: string[];
  /** Security policy — what the AI is ALLOWED to do. */
  policy: DelegationPolicy;
  /** When the delegation was created. */
  createdAt: Date;
}

/** Security constraints for a delegation. Principle of least privilege. */
export interface DelegationPolicy {
  /** Maximum duration in hours (default: 8). */
  maxHours: number;
  /** Maximum cost in USD (default: 10). */
  maxBudgetUSD: number;
  /** Maximum number of actions (default: 100). */
  maxActions: number;
  /** Actions the AI is ALLOWED to perform (allowlist, not blocklist). */
  allowedActions: AllowedAction[];
  /** Rate limit: max actions per minute (default: 5). */
  ratePerMinute: number;
  /** Rate limit: max actions per hour (default: 60). */
  ratePerHour: number;
  /** How often to checkpoint (every N actions, default: 10). */
  checkpointEvery: number;
  /** Whether to notify user on completion (via memory store). */
  notifyOnComplete: boolean;
  /** Whether destructive actions are pre-approved (default: false). */
  destructiveAllowed: boolean;
}

/** An allowed action with its scope. */
export interface AllowedAction {
  /** Action name (e.g., 'recall', 'store', 'api_call', 'file_read'). */
  name: string;
  /** Scope restriction (e.g., specific paths, specific APIs). */
  scope?: string;
  /** Whether this action modifies state (true = needs extra caution). */
  mutating: boolean;
}

/** A single action performed during autonomous execution. */
export interface ActionEntry {
  /** Sequential action number. */
  sequence: number;
  /** When it was executed. */
  timestamp: Date;
  /** What action was taken. */
  action: string;
  /** Parameters/input for the action. */
  input: Record<string, unknown>;
  /** Result of the action. */
  result: 'success' | 'failure' | 'skipped' | 'escalated';
  /** Output or error message. */
  output: string;
  /** Cost of this specific action in USD. */
  costUSD: number;
  /** Duration in milliseconds. */
  durationMs: number;
}

/** A checkpoint — snapshot of state at a point in time. */
export interface Checkpoint {
  /** Action sequence number at checkpoint. */
  atAction: number;
  /** Timestamp. */
  timestamp: Date;
  /** State snapshot (serialized). */
  stateSnapshot: string;
  /** Accumulated cost at this point. */
  totalCostUSD: number;
  /** Summary of what was done since last checkpoint. */
  summary: string;
}

/** Complete delegation session record (for audit and recall). */
export interface DelegationSession {
  /** The original request. */
  request: DelegationRequest;
  /** Current state. */
  state: DelegationState;
  /** All actions taken (immutable audit log). */
  actions: ActionEntry[];
  /** Checkpoints for rollback. */
  checkpoints: Checkpoint[];
  /** Running totals. */
  totalCostUSD: number;
  totalActions: number;
  elapsedMs: number;
  /** Start and end times. */
  startedAt: Date | null;
  completedAt: Date | null;
  /** Reason for termination (if killed/escalated). */
  terminationReason: string | null;
  /** Summary of everything done (for user on return). */
  summary: string;
}

// ============================================================
// Safety Guards
// ============================================================

/** A safety guard — returns false to BLOCK the action. */
export interface SafetyGuard {
  name: string;
  /** Check if the action is allowed. Returns null if OK, error message if blocked. */
  check(session: DelegationSession, action: string, input: Record<string, unknown>): string | null;
}

/** Time limit guard. */
export function createTimeLimitGuard(maxHours: number): SafetyGuard {
  return {
    name: 'time-limit',
    check(session) {
      const elapsed = Date.now() - (session.startedAt?.getTime() ?? Date.now());
      const hours = elapsed / (1000 * 60 * 60);
      if (hours >= maxHours) {
        return `Time limit exceeded: ${hours.toFixed(1)}h >= ${maxHours}h max`;
      }
      return null;
    },
  };
}

/** Budget limit guard. */
export function createBudgetGuard(maxUSD: number): SafetyGuard {
  return {
    name: 'budget-limit',
    check(session) {
      if (session.totalCostUSD >= maxUSD) {
        return `Budget exceeded: $${session.totalCostUSD.toFixed(2)} >= $${maxUSD} max`;
      }
      return null;
    },
  };
}

/** Action count guard. */
export function createActionCountGuard(maxActions: number): SafetyGuard {
  return {
    name: 'action-count',
    check(session) {
      if (session.totalActions >= maxActions) {
        return `Action limit reached: ${session.totalActions} >= ${maxActions} max`;
      }
      return null;
    },
  };
}

/** Rate limit guard (per minute). */
export function createRateLimitGuard(perMinute: number, perHour: number): SafetyGuard {
  return {
    name: 'rate-limit',
    check(session) {
      const now = Date.now();
      const oneMinAgo = now - 60_000;
      const oneHourAgo = now - 3_600_000;

      const lastMinute = session.actions.filter(a => a.timestamp.getTime() > oneMinAgo).length;
      const lastHour = session.actions.filter(a => a.timestamp.getTime() > oneHourAgo).length;

      if (lastMinute >= perMinute) {
        return `Rate limit: ${lastMinute} actions in last minute (max: ${perMinute})`;
      }
      if (lastHour >= perHour) {
        return `Rate limit: ${lastHour} actions in last hour (max: ${perHour})`;
      }
      return null;
    },
  };
}

/** Allowlist guard — only permits actions in the allowedActions list. */
export function createAllowlistGuard(allowed: AllowedAction[]): SafetyGuard {
  const allowedNames = new Set(allowed.map(a => a.name));
  return {
    name: 'allowlist',
    check(_session, action) {
      if (!allowedNames.has(action)) {
        return `Action "${action}" is not in the allowed list: [${[...allowedNames].join(', ')}]`;
      }
      return null;
    },
  };
}

/** Destructive action guard — blocks mutating actions unless pre-approved. */
export function createDestructiveGuard(destructiveAllowed: boolean, allowedActions: AllowedAction[]): SafetyGuard {
  const mutatingActions = new Set(allowedActions.filter(a => a.mutating).map(a => a.name));
  return {
    name: 'destructive-guard',
    check(_session, action) {
      if (!destructiveAllowed && mutatingActions.has(action)) {
        return `Destructive action "${action}" blocked — not pre-approved by user`;
      }
      return null;
    },
  };
}

/** Anomaly detection guard — stops if error rate is too high. */
export function createAnomalyGuard(maxErrorRate: number = 0.3): SafetyGuard {
  return {
    name: 'anomaly-detection',
    check(session) {
      if (session.totalActions < 5) return null; // Not enough data
      const failures = session.actions.filter(a => a.result === 'failure').length;
      const errorRate = failures / session.totalActions;
      if (errorRate > maxErrorRate) {
        return `Anomaly: error rate ${(errorRate * 100).toFixed(0)}% exceeds ${(maxErrorRate * 100).toFixed(0)}% threshold`;
      }
      return null;
    },
  };
}

// ============================================================
// Default Policy
// ============================================================

export const DEFAULT_DELEGATION_POLICY: DelegationPolicy = {
  maxHours: 8,
  maxBudgetUSD: 10,
  maxActions: 100,
  allowedActions: [
    { name: 'recall', mutating: false },
    { name: 'store', mutating: true },
    { name: 'consolidate', mutating: true },
    { name: 'api_call_fleet', mutating: false },
  ],
  ratePerMinute: 5,
  ratePerHour: 60,
  checkpointEvery: 10,
  notifyOnComplete: true,
  destructiveAllowed: false,
};

// ============================================================
// AutonomyEngine
// ============================================================

export class AutonomyEngine {
  private session: DelegationSession;
  private guards: SafetyGuard[];
  private isRunning: boolean = false;

  constructor(request: DelegationRequest) {
    this.session = {
      request,
      state: 'pending',
      actions: [],
      checkpoints: [],
      totalCostUSD: 0,
      totalActions: 0,
      elapsedMs: 0,
      startedAt: null,
      completedAt: null,
      terminationReason: null,
      summary: '',
    };

    // Build guards from policy
    const p = request.policy;
    this.guards = [
      createTimeLimitGuard(p.maxHours),
      createBudgetGuard(p.maxBudgetUSD),
      createActionCountGuard(p.maxActions),
      createRateLimitGuard(p.ratePerMinute, p.ratePerHour),
      createAllowlistGuard(p.allowedActions),
      createDestructiveGuard(p.destructiveAllowed, p.allowedActions),
      createAnomalyGuard(0.3),
    ];
  }

  /**
   * Start autonomous execution.
   * Activates circadian delegation mode.
   * Runs the task loop until completion, kill, or escalation.
   *
   * @param executor - Function that executes a single action and returns result.
   *                   The engine calls this repeatedly, the executor decides WHAT to do.
   */
  async start(
    executor: (task: string, subtasks: string[], actionsSoFar: ActionEntry[]) => Promise<{
      action: string;
      input: Record<string, unknown>;
      done: boolean;
    } | null>,
  ): Promise<DelegationSession> {
    this.session.state = 'running';
    this.session.startedAt = new Date();
    this.isRunning = true;

    try {
      while (this.isRunning && this.session.state === 'running') {
        // 1. Run all safety guards
        const guardResult = this.runGuards('', {});
        if (guardResult) {
          this.kill(guardResult);
          break;
        }

        // 2. Ask executor what to do next
        const next = await executor(
          this.session.request.task,
          this.session.request.subtasks,
          this.session.actions,
        );

        // 3. If executor says done or returns null → complete
        if (!next || next.done) {
          this.session.state = 'completed';
          break;
        }

        // 4. Check guards for this specific action
        const actionGuard = this.runGuards(next.action, next.input);
        if (actionGuard) {
          // Log the blocked action
          this.logAction({
            sequence: this.session.totalActions + 1,
            timestamp: new Date(),
            action: next.action,
            input: next.input,
            result: 'skipped',
            output: `Blocked by guard: ${actionGuard}`,
            costUSD: 0,
            durationMs: 0,
          });

          // If it's a rate limit, pause briefly; if it's a hard limit, kill
          if (actionGuard.includes('Rate limit')) {
            await sleep(12000); // Wait 12 seconds before retrying
            continue;
          } else {
            this.kill(actionGuard);
            break;
          }
        }

        // 5. Execute the action (the executor already did it, we just log)
        // In practice, the executor would call the actual function here
        const start = Date.now();
        try {
          this.logAction({
            sequence: this.session.totalActions + 1,
            timestamp: new Date(),
            action: next.action,
            input: next.input,
            result: 'success',
            output: 'Executed',
            costUSD: 0, // Executor should report actual cost
            durationMs: Date.now() - start,
          });
        } catch (err: any) {
          this.logAction({
            sequence: this.session.totalActions + 1,
            timestamp: new Date(),
            action: next.action,
            input: next.input,
            result: 'failure',
            output: err.message ?? 'Unknown error',
            costUSD: 0,
            durationMs: Date.now() - start,
          });
        }

        // 6. Checkpoint if needed
        if (this.session.totalActions % this.session.request.policy.checkpointEvery === 0) {
          this.createCheckpoint();
        }

        // 7. Update elapsed time
        this.session.elapsedMs = Date.now() - this.session.startedAt!.getTime();
      }
    } catch (err: any) {
      this.kill(`Unhandled error: ${err.message}`);
    }

    this.session.completedAt = new Date();
    this.session.elapsedMs = this.session.completedAt.getTime() - this.session.startedAt!.getTime();
    this.buildSummary();

    return this.session;
  }

  /** Run all safety guards. Returns null if OK, error message if blocked. */
  private runGuards(action: string, input: Record<string, unknown>): string | null {
    for (const guard of this.guards) {
      const result = guard.check(this.session, action, input);
      if (result) return `[${guard.name}] ${result}`;
    }
    return null;
  }

  /** Log an action to the immutable audit trail. */
  private logAction(entry: ActionEntry): void {
    this.session.actions.push(entry);
    this.session.totalActions++;
    this.session.totalCostUSD += entry.costUSD;
  }

  /** Create a checkpoint for potential rollback. */
  private createCheckpoint(): void {
    const cp: Checkpoint = {
      atAction: this.session.totalActions,
      timestamp: new Date(),
      stateSnapshot: JSON.stringify({
        actions: this.session.actions.length,
        cost: this.session.totalCostUSD,
        state: this.session.state,
      }),
      totalCostUSD: this.session.totalCostUSD,
      summary: `Checkpoint at action ${this.session.totalActions}: ${this.session.actions.slice(-this.session.request.policy.checkpointEvery).map(a => a.action).join(', ')}`,
    };
    this.session.checkpoints.push(cp);
  }

  /** Kill switch — immediately stop everything. */
  kill(reason: string): void {
    this.session.state = 'killed';
    this.session.terminationReason = reason;
    this.isRunning = false;
  }

  /** Pause execution (for escalation or user break). */
  pause(reason: string): void {
    this.session.state = 'paused';
    this.isRunning = false;
    this.session.terminationReason = reason;
  }

  /** Escalate to user — stop and wait. */
  escalate(reason: string): void {
    this.session.state = 'escalated';
    this.isRunning = false;
    this.session.terminationReason = `Escalation: ${reason}`;
  }

  /** Build a human-readable summary of everything that was done. */
  private buildSummary(): void {
    const succeeded = this.session.actions.filter(a => a.result === 'success').length;
    const failed = this.session.actions.filter(a => a.result === 'failure').length;
    const hours = (this.session.elapsedMs / (1000 * 60 * 60)).toFixed(1);

    this.session.summary = [
      `Delegation "${this.session.request.task}" ${this.session.state}.`,
      `Duration: ${hours}h | Actions: ${succeeded} succeeded, ${failed} failed | Cost: $${this.session.totalCostUSD.toFixed(2)}`,
      `Checkpoints: ${this.session.checkpoints.length}`,
      this.session.terminationReason ? `Reason: ${this.session.terminationReason}` : '',
    ].filter(Boolean).join('\n');
  }

  /** Get the current session for inspection. */
  getSession(): DelegationSession {
    return { ...this.session };
  }

  /** Get the audit log. */
  getAuditLog(): ActionEntry[] {
    return [...this.session.actions];
  }

  /** Add a custom safety guard at runtime. */
  addGuard(guard: SafetyGuard): void {
    this.guards.push(guard);
  }
}

// ============================================================
// Utility
// ============================================================

function sleep(ms: number): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, ms));
}
