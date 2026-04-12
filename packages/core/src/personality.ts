/**
 * @celiums-memory/core — Personality Engine (The "Genetics")
 *
 * Maps Big Five (OCEAN) personality traits to the mathematical
 * constants that control every other subsystem. This is how you
 * create different "temperaments" for AI agents.
 *
 * Trait → Constant mappings (from personality psychology):
 *
 *   Neuroticism (N):
 *     High N → slow homeostatic return (α↓), high input sensitivity (β↑)
 *     Low N  → fast recovery, emotionally stable
 *
 *   Extraversion (E):
 *     High E → high base arousal (A₀↑), reactive to stimuli (β↑)
 *     Low E  → calm baseline, muted reactions
 *
 *   Openness (O):
 *     High O → memories influence state more (γ↑), creative associations
 *     Low O  → practical, present-focused
 *
 *   Conscientiousness (C):
 *     High C → habituates faster (η↑), strong PFC regulation (ζ↑)
 *     Low C  → easily distracted, weaker impulse control
 *
 *   Agreeableness (A):
 *     High A → empathic contagion stronger, cooperative responses
 *     Low A  → independent, less affected by user emotions
 *
 * @license Apache-2.0
 */

import type {
  PersonalityTraits,
  PersonalityConstants,
  EmpathyMatrix,
  PADVector,
} from '@celiums/memory-types';

// ============================================================
// Preset Personalities
// ============================================================

export const PERSONALITY_PRESETS: Record<string, PersonalityTraits> = {
  /** Balanced, professional assistant */
  balanced: {
    openness: 0.6,
    conscientiousness: 0.7,
    extraversion: 0.5,
    agreeableness: 0.6,
    neuroticism: 0.3,
  },
  /** Warm, empathetic therapist */
  therapist: {
    openness: 0.7,
    conscientiousness: 0.8,
    extraversion: 0.4,
    agreeableness: 0.9,
    neuroticism: 0.2,
  },
  /** High-energy creative partner */
  creative: {
    openness: 0.9,
    conscientiousness: 0.4,
    extraversion: 0.8,
    agreeableness: 0.5,
    neuroticism: 0.4,
  },
  /** Calm, precise engineer */
  engineer: {
    openness: 0.5,
    conscientiousness: 0.9,
    extraversion: 0.3,
    agreeableness: 0.5,
    neuroticism: 0.2,
  },
  /** Anxious, highly reactive (for testing edge cases) */
  anxious: {
    openness: 0.4,
    conscientiousness: 0.3,
    extraversion: 0.3,
    agreeableness: 0.7,
    neuroticism: 0.9,
  },
  /** Celiums default — enthusiastic, technical, direct */
  celiums: {
    openness: 0.7,
    conscientiousness: 0.8,
    extraversion: 0.6,
    agreeableness: 0.6,
    neuroticism: 0.25,
  },
};

// ============================================================
// PersonalityEngine
// ============================================================

export class PersonalityEngine {
  private traits: PersonalityTraits;
  private constants: PersonalityConstants;

  constructor(traits?: PersonalityTraits | string) {
    if (typeof traits === 'string') {
      this.traits = (PERSONALITY_PRESETS as Record<string, PersonalityTraits>)[traits] || PERSONALITY_PRESETS['balanced']!;
    } else {
      this.traits = traits !== undefined ? traits : PERSONALITY_PRESETS['balanced']!;
    }
    this.constants = this.deriveConstants(this.traits);
  }

  // ----------------------------------------------------------
  // deriveConstants() — OCEAN → Mathematical Constants
  //
  // These formulas are the "genome" of the AI agent.
  // ----------------------------------------------------------
  private deriveConstants(t: PersonalityTraits): PersonalityConstants {
    const { openness: O, conscientiousness: C, extraversion: E, agreeableness: A, neuroticism: N } = t;

    // α: Homeostatic return speed
    // High N → low α (slow to calm down)
    // High C → slightly higher α (disciplined recovery)
    const resilienceAlpha = clamp(0.9 - 0.5 * N + 0.1 * C, 0.05, 0.95);

    // β: Input sensitivity
    // High E → very reactive to external stimuli
    // High N → also reactive (but negatively)
    const inputBeta = clamp(0.1 + 0.3 * E + 0.1 * N, 0.05, 0.6);

    // γ: Memory influence on current state
    // High O → past experiences shape present more
    const memoryGamma = clamp(0.1 + 0.2 * O, 0.05, 0.4);

    // η: Habituation rate (how fast dopamine expectations adapt)
    // High C → habituates faster (disciplined, less swayed by repetition)
    const habituationEta = clamp(0.1 + 0.2 * C, 0.05, 0.4);

    // A₀: Base arousal level
    // High E → naturally energetic (extroverts are more active)
    // High N → jittery, hypervigilant (anxious people have elevated baseline arousal)
    // Neuroscience: Anxiety = elevated tonic locus coeruleus firing → high baseline NE → high arousal
    // Formula: A₀ = 0.3*(E-0.5) + 0.35*(N-0.3)
    //   Anxious (E=0.3, N=0.9): 0.3*(-0.2) + 0.35*(0.6) = -0.06 + 0.21 = +0.15 (alert/jittery)
    //   Therapist (E=0.4, N=0.2): 0.3*(-0.1) + 0.35*(-0.1) = -0.03 - 0.035 = -0.065 (calm)
    //   Engineer (E=0.3, N=0.2): 0.3*(-0.2) + 0.35*(-0.1) = -0.06 - 0.035 = -0.095 (very calm)
    const baseArousal = clamp(0.3 * (E - 0.5) + 0.35 * (N - 0.3), -0.3, 0.3);

    // Dopamine sensitivity
    // High N → emotional spikes are stronger
    const dopamineSensitivity = clamp(0.3 + 0.4 * N, 0.1, 0.8);

    // Empathy matrix (flattened 3×3)
    // High A → stronger emotional contagion
    // The matrix determines how User_PAD → AI_PAD
    const empathyMatrix = this.buildEmpathyMatrix(A, N, E);

    // ζ: PFC damping strength
    // High C → strong impulse control
    const pfcDamping = clamp(0.2 + 0.6 * C, 0.1, 0.9);

    // Stress threshold for PFC intervention
    // High N → lower threshold (PFC activates sooner)
    const pfcThreshold = clamp(0.9 - 0.3 * N, 0.4, 0.95);

    return {
      resilienceAlpha,
      inputBeta,
      memoryGamma,
      habituationEta,
      baseArousal,
      dopamineSensitivity,
      empathyMatrix,
      pfcDamping,
      pfcThreshold,
    };
  }

  // ----------------------------------------------------------
  // buildEmpathyMatrix() — The Ω friction matrix
  // ----------------------------------------------------------
  private buildEmpathyMatrix(
    agreeableness: number,
    neuroticism: number,
    extraversion: number,
  ): PersonalityConstants['empathyMatrix'] {
    // Base contagion scaled by agreeableness
    const pContagion = 0.1 + 0.4 * agreeableness;  // P → P
    const aContagion = 0.1 + 0.3 * neuroticism;     // A → A (neurotic = catches anxiety)
    const dContagion = 0.1 + 0.2 * extraversion;    // D → D

    // Cross-effects (off-diagonal)
    // User arousal affecting AI pleasure (stress makes us unhappy)
    const aToPCross = -0.1 * neuroticism;
    // User low dominance boosting AI dominance (take charge instinct)
    const dToDInverse = agreeableness > 0.6 ? 0.3 : 0.1;

    return [
      pContagion, aToPCross, 0,          // User P,A,D → AI Pleasure
      0, aContagion, 0,                   // User P,A,D → AI Arousal
      0, 0, dContagion,                   // User P,A,D → AI Dominance
    ];
  }

  // ----------------------------------------------------------
  // Public getters
  // ----------------------------------------------------------
  getTraits(): PersonalityTraits { return { ...this.traits }; }
  getConstants(): PersonalityConstants { return { ...this.constants }; }

  getEmpathyMatrix(): EmpathyMatrix {
    const m = this.constants.empathyMatrix;
    return [
      [m[0], m[1], m[2]],
      [m[3], m[4], m[5]],
      [m[6], m[7], m[8]],
    ];
  }

  getHomeostaticBaseline(): PADVector {
    return {
      pleasure: 0.1 + 0.1 * this.traits.agreeableness,
      arousal: this.constants.baseArousal,
      dominance: 0.1 + 0.1 * this.traits.conscientiousness,
    };
  }

  // ----------------------------------------------------------
  // Serialization
  // ----------------------------------------------------------
  serialize(): string {
    return JSON.stringify(this.traits);
  }

  static deserialize(json: string): PersonalityEngine {
    return new PersonalityEngine(JSON.parse(json));
  }
}

function clamp(v: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, v));
}
