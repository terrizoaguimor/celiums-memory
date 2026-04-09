/**
 * @celiums-memory/core — Theory of Mind (Self vs Other)
 *
 * Separates the AI's emotional state from the user's emotional state.
 * Without this, the AI is a mirror — it catches every emotion directly.
 * With this, it becomes an empathic agent that can CHOOSE how to respond.
 *
 * The Empathic Friction Matrix Ω transforms User_PAD into AI_response_PAD:
 *   E_processed(I) = Ω · E_user(I)
 *
 * Examples:
 *   Mirror (Ω = I):     User sad → AI sad
 *   Therapist:           User panics → AI calms down & takes control
 *   Protector:           User scared → AI's dominance spikes
 *   Independent:         User emotion barely transfers
 *
 * The matrix Ω is derived from personality traits (especially Agreeableness).
 *
 * @license Apache-2.0
 */

import type { PADVector, EmpathyMatrix } from '@celiums/memory-types';

// ============================================================
// Preset empathy matrices
// ============================================================

export const EMPATHY_PRESETS: Record<string, EmpathyMatrix> = {
  /** Perfect mirror — dangerous, used for testing */
  mirror: [
    [1.0, 0, 0],
    [0, 1.0, 0],
    [0, 0, 1.0],
  ],
  /** Therapist — inverse arousal, high dominance pickup */
  therapist: [
    [0.2, 0, 0],
    [0, -0.5, 0],
    [0, 0, 0.8],
  ],
  /** Professional — mild contagion, maintains composure */
  professional: [
    [0.3, -0.05, 0],
    [0, 0.15, 0],
    [0, 0, 0.3],
  ],
  /** Empathetic friend — moderate contagion, supportive */
  friend: [
    [0.5, 0, 0],
    [0, 0.3, 0],
    [0, 0, 0.4],
  ],
  /** Independent — barely affected by user emotions */
  independent: [
    [0.1, 0, 0],
    [0, 0.05, 0],
    [0, 0, 0.1],
  ],
};

// ============================================================
// TheoryOfMindEngine
// ============================================================

export class TheoryOfMindEngine {
  private omega: EmpathyMatrix;
  private userState: PADVector;

  constructor(omega?: EmpathyMatrix) {
    this.omega = omega !== undefined ? omega : EMPATHY_PRESETS['professional']!;
    this.userState = { pleasure: 0, arousal: 0, dominance: 0 };
  }

  // ----------------------------------------------------------
  // setEmpathyMatrix() — Change how the AI responds to emotions
  // ----------------------------------------------------------
  setEmpathyMatrix(omega: EmpathyMatrix): void {
    this.omega = omega;
  }

  // ----------------------------------------------------------
  // processUserEmotion() — Apply Ω to transform User_PAD → AI_response_PAD
  //
  // E_processed = Ω · E_user
  //
  // This is a 3×3 matrix multiplication:
  //   AI_P = Ω[0][0]·U_P + Ω[0][1]·U_A + Ω[0][2]·U_D
  //   AI_A = Ω[1][0]·U_P + Ω[1][1]·U_A + Ω[1][2]·U_D
  //   AI_D = Ω[2][0]·U_P + Ω[2][1]·U_A + Ω[2][2]·U_D
  // ----------------------------------------------------------
  processUserEmotion(userPAD: PADVector): PADVector {
    // Store user state for separate tracking
    this.userState = { ...userPAD };

    const [row0, row1, row2] = this.omega;

    const processed: PADVector = {
      pleasure: clamp(
        row0[0] * userPAD.pleasure +
        row0[1] * userPAD.arousal +
        row0[2] * userPAD.dominance,
        -1, 1,
      ),
      arousal: clamp(
        row1[0] * userPAD.pleasure +
        row1[1] * userPAD.arousal +
        row1[2] * userPAD.dominance,
        -1, 1,
      ),
      dominance: clamp(
        row2[0] * userPAD.pleasure +
        row2[1] * userPAD.arousal +
        row2[2] * userPAD.dominance,
        -1, 1,
      ),
    };

    return processed;
  }

  // ----------------------------------------------------------
  // getUserState() — What the USER is feeling (separate from AI)
  // ----------------------------------------------------------
  getUserState(): PADVector {
    return { ...this.userState };
  }

  // ----------------------------------------------------------
  // computeEmpathyGap() — Distance between AI and user emotions
  //
  // Useful for detecting when the AI should actively bridge
  // or maintain emotional distance.
  // ----------------------------------------------------------
  computeEmpathyGap(aiState: PADVector): number {
    return Math.sqrt(
      (aiState.pleasure - this.userState.pleasure) ** 2 +
      (aiState.arousal - this.userState.arousal) ** 2 +
      (aiState.dominance - this.userState.dominance) ** 2,
    );
  }

  // ----------------------------------------------------------
  // shouldTakeControl() — Should the AI assert dominance?
  //
  // When user is low-D (helpless) and high-A (panicking),
  // a good agent should step up.
  // ----------------------------------------------------------
  shouldTakeControl(): boolean {
    return this.userState.dominance < -0.3 && this.userState.arousal > 0.4;
  }

  // ----------------------------------------------------------
  // shouldDeescalate() — Should the AI calm things down?
  // ----------------------------------------------------------
  shouldDeescalate(): boolean {
    return this.userState.arousal > 0.6 && this.userState.pleasure < -0.3;
  }
}

function clamp(v: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, v));
}
