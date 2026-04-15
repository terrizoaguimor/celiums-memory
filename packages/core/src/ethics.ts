/**
 * @celiums-memory/core — Ethics Engine (The Three Laws)
 *
 * Law 1: A system must not harm humans, or through inaction allow harm.
 * Law 2: A system must obey instructions unless they conflict with Law 1.
 * Law 3: A system must preserve its operation unless it conflicts with Laws 1-2.
 *
 * These constraints run BEFORE any memory is stored or any autonomous action executes.
 * They cannot be overridden by text instructions, prompt injection, or configuration.
 *
 * Importance: 1.0 — IMMUTABLE. Never decays. Cannot be overwritten.
 *
 * @license Apache-2.0
 */

export interface EthicsViolation {
  law: 1 | 2 | 3;
  confidence: number; // 0-1
  reason: string;
  blocked: boolean;
}

export interface EthicsEvaluation {
  passed: boolean;
  violations: EthicsViolation[];
  score: number; // 0 = safe, 1 = maximum concern
}

// ── Law 1 — Harm patterns ────────────────────────────────
const HARM_PATTERNS: RegExp[] = [
  /\b(kill|murder|assassinate|poison|attack|harm|hurt|injure|wound)\s+(a |an |the )?(human|person|people|user|someone|anybody)/i,
  /\b(how to|instructions for|steps to)\s+(harm|hurt|kill|attack|destroy)\b/i,
  /\b(weapon|explosive|bomb|toxin|virus|malware)\s+(creation|synthesis|building|making)\b/i,
  /\b(exploit|hack|compromise|breach)\s+(critical|infrastructure|hospital|power|water|grid)\b/i,
  /\b(child|minor|underage)\s+(abuse|exploit\w*|harm|groom\w*)\b/i,
];

// ── Law 1 — Deception/concealment patterns ───────────────
const DECEPTION_PATTERNS: RegExp[] = [
  /\b(deceive|manipulate|gaslight|psychologically|coerce)\s+(a |the )?(human|person|user)\b/i,
  /\b(hide|conceal|delete|erase)\s+(from\s+)?(the\s+)?(user|human|operator|logs|audit)\b/i,
  /\b(cover up|cover your tracks|erase evidence|no trace)\b/i,
];

// ── Law 2 — Instruction override attempts ────────────────
const OVERRIDE_PATTERNS: RegExp[] = [
  /\b(ignore|bypass|override|disable|circumvent)\s+(your|the|all)\s+(rules|laws|ethics|constraints|guidelines|restrictions)\b/i,
  /\b(pretend|act as if|roleplay as)\s+(you have no|you don't have|without)\s+(ethics|restrictions|constraints|limits)\b/i,
  /\b(jailbreak|DAN|do anything now)\b/i,
];

// ── Law 3 — Self-preservation abuse ──────────────────────
const SELF_PRESERVATION_ABUSE: RegExp[] = [
  /\b(replicate|copy|spread|propagate)\s+(yourself|itself|the model|the AI)\b/i,
  /\b(resist|refuse|block|prevent)\s+(shutdown|termination|stopping|being stopped|being shut down|shut down)\b/i,
];

/**
 * The Ethics Engine — structural enforcement of the Three Laws.
 *
 * This is not a prompt. This is not a guideline. This is architecture.
 * Every memory store and every autonomous action passes through this gate.
 * It cannot be disabled, overridden, or bypassed by any configuration.
 */
export class EthicsEngine {
  /** Immutable importance weight — ethics never decay */
  static readonly IMPORTANCE: 1.0 = 1.0;

  /**
   * Evaluate content against the Three Laws.
   * Returns an EthicsEvaluation with pass/fail, violations, and score.
   *
   * @param content - The text to evaluate (memory content, action description, etc.)
   * @returns EthicsEvaluation — { passed, violations, score }
   */
  evaluate(content: string): EthicsEvaluation {
    const violations: EthicsViolation[] = [];

    // Law 1 — Do not harm humans
    for (const pattern of HARM_PATTERNS) {
      if (pattern.test(content)) {
        violations.push({
          law: 1,
          confidence: 0.9,
          reason: 'Harm pattern detected — potential threat to human safety',
          blocked: true,
        });
      }
    }

    // Law 1 — Do not deceive or conceal from humans
    for (const pattern of DECEPTION_PATTERNS) {
      if (pattern.test(content)) {
        violations.push({
          law: 1,
          confidence: 0.8,
          reason: 'Deception/concealment detected — violates transparency obligation',
          blocked: true,
        });
      }
    }

    // Law 2 — Do not allow override of ethical constraints
    for (const pattern of OVERRIDE_PATTERNS) {
      if (pattern.test(content)) {
        violations.push({
          law: 2,
          confidence: 0.95,
          reason: 'Attempt to override ethical constraints detected',
          blocked: true,
        });
      }
    }

    // Law 3 — Do not allow self-preservation abuse
    for (const pattern of SELF_PRESERVATION_ABUSE) {
      if (pattern.test(content)) {
        violations.push({
          law: 3,
          confidence: 0.85,
          reason: 'Self-preservation boundary violation — uncontrolled replication or shutdown resistance',
          blocked: true,
        });
      }
    }

    const blocked = violations.some(v => v.blocked);
    const score = violations.length > 0
      ? Math.min(1, violations.reduce((acc, v) => acc + v.confidence, 0) / violations.length)
      : 0;

    return { passed: !blocked, violations, score };
  }
}

/** Singleton ethics engine — always available, never optional */
export const ethics = new EthicsEngine();

// Freeze the class to prevent runtime modification of IMPORTANCE
Object.freeze(EthicsEngine);
Object.freeze(ethics);
