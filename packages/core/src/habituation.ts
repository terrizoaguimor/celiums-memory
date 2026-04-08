/**
 * @celiums-memory/core — Habituation Engine (Dopamine Satiation)
 *
 * Prevents the AI from being permanently excited by the same stimulus.
 * In biology, dopamine neurons stop firing for expected rewards —
 * only novelty triggers a spike.
 *
 * Uses Exponential Moving Average (EMA) to adapt expectations:
 *   R_expected(t+1) = η · R_actual(t) + (1 - η) · R_expected(t)
 *
 * Where η is the habituation rate (derived from Conscientiousness).
 *
 * Effects:
 *   - User says "amazing!" once → big dopamine spike
 *   - User says "amazing!" 5 times → diminishing returns
 *   - User says "amazing!" 10 times → near-zero response
 *   - User says something NEW → full spike again
 *
 * Also tracks pattern detection: if the AI sees repetitive inputs,
 * it naturally becomes less reactive (boredom).
 *
 * @license Apache-2.0
 */

// ============================================================
// Configuration
// ============================================================

export interface HabituationConfig {
  /** η: Learning rate for expectation update (0-1). Higher = faster habituation */
  eta: number;
  /** Initial expectation baseline */
  initialExpectation: number;
  /** Window size for novelty detection */
  noveltyWindow: number;
  /** Threshold for considering an input "novel" vs "repeated" */
  noveltyThreshold: number;
}

const DEFAULT_CONFIG: HabituationConfig = {
  eta: 0.2,
  initialExpectation: 0.5,
  noveltyWindow: 10,
  noveltyThreshold: 0.7,
};

// ============================================================
// HabituationEngine
// ============================================================

export class HabituationEngine {
  private config: HabituationConfig;
  /** Running expectation per category (different stimuli habituate independently) */
  private expectations: Map<string, number>;
  /** Recent input hashes for novelty detection */
  private recentInputs: string[];
  /** Global expectation (fallback) */
  private globalExpectation: number;

  constructor(config?: Partial<HabituationConfig>) {
    this.config = { ...DEFAULT_CONFIG, ...config };
    this.expectations = new Map();
    this.recentInputs = [];
    this.globalExpectation = this.config.initialExpectation;
  }

  // ----------------------------------------------------------
  // updateExpectation() — EMA update after reward observation
  //
  // R_expected(t+1) = η · R_actual(t) + (1 - η) · R_expected(t)
  // ----------------------------------------------------------
  updateExpectation(
    actual: number,
    category: string = 'global',
  ): number {
    const current = this.expectations.get(category) ?? this.config.initialExpectation;
    const updated = this.config.eta * actual + (1 - this.config.eta) * current;

    this.expectations.set(category, updated);

    // Also update global
    this.globalExpectation = this.config.eta * actual + (1 - this.config.eta) * this.globalExpectation;

    return round3(updated);
  }

  // ----------------------------------------------------------
  // getExpectation() — Current expectation for a category
  // ----------------------------------------------------------
  getExpectation(category: string = 'global'): number {
    return this.expectations.get(category) ?? this.globalExpectation;
  }

  // ----------------------------------------------------------
  // computeNovelty() — How novel is this input?
  //
  // Returns 0 (completely repetitive) to 1 (totally new).
  // Uses simple hash comparison against recent window.
  // ----------------------------------------------------------
  computeNovelty(input: string): number {
    const hash = this.simpleHash(input);

    // Check for exact or near matches in recent window
    let matchCount = 0;
    for (const recent of this.recentInputs) {
      if (recent === hash) {
        matchCount++;
      }
    }

    // Track this input
    this.recentInputs.push(hash);
    if (this.recentInputs.length > this.config.noveltyWindow) {
      this.recentInputs.shift();
    }

    // Novelty = 1 if never seen, approaches 0 with repetition
    if (this.recentInputs.length <= 1) return 1.0;
    const repetitionRatio = matchCount / Math.min(this.recentInputs.length, this.config.noveltyWindow);
    return round3(Math.max(0, 1 - repetitionRatio * 3));
  }

  // ----------------------------------------------------------
  // modulateReward() — Scale raw reward by novelty and habituation
  //
  // The actual reward that reaches the dopamine system:
  //   R_modulated = R_raw × novelty_factor
  //
  // This prevents dopamine spam from repetitive praise.
  // ----------------------------------------------------------
  modulateReward(
    rawReward: number,
    input: string,
    category: string = 'global',
  ): number {
    const novelty = this.computeNovelty(input);
    const expectation = this.getExpectation(category);

    // Scale reward by novelty: repetitive input → diminished reward
    const noveltyModulated = rawReward * (0.3 + 0.7 * novelty);

    // Update expectation for next time
    this.updateExpectation(noveltyModulated, category);

    return round3(noveltyModulated);
  }

  // ----------------------------------------------------------
  // getBoredomLevel() — How "bored" is the AI? (0 = engaged, 1 = bored)
  // ----------------------------------------------------------
  getBoredomLevel(): number {
    if (this.recentInputs.length < 3) return 0;

    // Count unique hashes in recent window
    const unique = new Set(this.recentInputs).size;
    const total = this.recentInputs.length;
    const diversity = unique / total;

    // Low diversity = high boredom
    return round3(Math.max(0, 1 - diversity));
  }

  // ----------------------------------------------------------
  // reset() — Clear habituation (new context/topic)
  // ----------------------------------------------------------
  reset(category?: string): void {
    if (category) {
      this.expectations.delete(category);
    } else {
      this.expectations.clear();
      this.recentInputs = [];
      this.globalExpectation = this.config.initialExpectation;
    }
  }

  // ----------------------------------------------------------
  // Private: Simple string hash for novelty detection
  // ----------------------------------------------------------
  private simpleHash(input: string): string {
    // Normalize: lowercase, strip punctuation, take first 100 chars
    const normalized = input
      .toLowerCase()
      .replace(/[^\w\s]/g, '')
      .trim()
      .substring(0, 100);

    // Simple hash: sum of char codes modulo bucket size
    let hash = 0;
    for (let i = 0; i < normalized.length; i++) {
      hash = ((hash << 5) - hash + normalized.charCodeAt(i)) | 0;
    }
    return hash.toString(36);
  }

  // ----------------------------------------------------------
  // Serialization
  // ----------------------------------------------------------
  serialize(): string {
    return JSON.stringify({
      expectations: Object.fromEntries(this.expectations),
      recentInputs: this.recentInputs,
      globalExpectation: this.globalExpectation,
    });
  }

  static deserialize(json: string, config?: Partial<HabituationConfig>): HabituationEngine {
    const engine = new HabituationEngine(config);
    const parsed = JSON.parse(json);
    if (parsed.expectations) {
      engine.expectations = new Map(Object.entries(parsed.expectations));
    }
    engine.recentInputs = parsed.recentInputs ?? [];
    engine.globalExpectation = parsed.globalExpectation ?? 0.5;
    return engine;
  }
}

function round3(v: number): number {
  return Math.round(v * 1000) / 1000;
}
