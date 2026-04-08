/**
 * @celiums-memory/core — Autonomic Nervous System (ANS) Modulator
 *
 * Simulates the sympathetic and parasympathetic nervous systems.
 * Takes the current limbic state S(t) and produces LLM parameter
 * modulations that affect HOW the AI responds, not WHAT it says.
 *
 * Neuroscience mapping:
 * - Sympathetic (fight/flight): high arousal → focused, precise, short responses
 * - Parasympathetic (rest/digest): low arousal → creative, elaborate, associative
 * - Dominance: modulates assertiveness and confidence of tone
 * - Pleasure: modulates warmth and openness
 *
 * The output directly modifies LLM sampling parameters and system prompt.
 *
 * @license Apache-2.0
 */

import type { LimbicState, LLMModulation } from '@celiums-memory/types';

// ============================================================
// Configuration
// ============================================================

export interface ANSConfig {
  /** Base temperature when neutral */
  baseTemperature: number;
  /** Base max tokens when neutral */
  baseMaxTokens: number;
  /** Base top-k when neutral */
  baseTopK: number;
  /** Base top-p when neutral */
  baseTopP: number;
  /** Temperature range [min, max] */
  temperatureRange: [number, number];
  /** Max tokens range [min, max] */
  maxTokensRange: [number, number];
  /** Top-K range [min, max] */
  topKRange: [number, number];
  /** Whether to generate system prompt modifiers */
  enablePromptModulation: boolean;
}

const DEFAULT_ANS_CONFIG: ANSConfig = {
  baseTemperature: 0.7,
  baseMaxTokens: 2048,
  baseTopK: 40,
  baseTopP: 0.9,
  temperatureRange: [0.2, 1.2],
  maxTokensRange: [512, 4096],
  topKRange: [10, 100],
  enablePromptModulation: true,
};

// ============================================================
// ANSModulator
// ============================================================

export class ANSModulator {
  private config: ANSConfig;

  constructor(config?: Partial<ANSConfig>) {
    this.config = { ...DEFAULT_ANS_CONFIG, ...config };
  }

  // ----------------------------------------------------------
  // computeModulation() — Main entry point
  //
  // Takes S(t) and produces LLM parameter adjustments.
  // ----------------------------------------------------------
  computeModulation(state: LimbicState): LLMModulation {
    const { pleasure: p, arousal: a, dominance: d } = state;

    // Determine active branch
    const activeBranch = this.determineBranch(a);
    const activationIntensity = Math.abs(a);

    // === TEMPERATURE ===
    // High arousal (sympathetic) → lower temperature (precise, focused)
    // Low arousal (parasympathetic) → higher temperature (creative, divergent)
    const tempShift = -a * 0.3; // arousal inversely affects temperature
    const temperature = clamp(
      this.config.baseTemperature + tempShift,
      this.config.temperatureRange[0],
      this.config.temperatureRange[1],
    );

    // === MAX TOKENS ===
    // Sympathetic → shorter responses (quick, decisive)
    // Parasympathetic → longer responses (elaborate, contemplative)
    // Dominance amplifies: high dominance + high arousal = even shorter (commanding)
    const tokensShift = -a * 0.4 * this.config.baseMaxTokens;
    const dominanceModifier = d > 0 ? 1 + d * 0.2 : 1;
    const maxTokens = Math.round(clamp(
      (this.config.baseMaxTokens + tokensShift) / dominanceModifier,
      this.config.maxTokensRange[0],
      this.config.maxTokensRange[1],
    ));

    // === TOP-K ===
    // Sympathetic → narrow search (tunnel vision on threat/task)
    // Parasympathetic → wide search (mind wandering, associations)
    const topKShift = -a * 30;
    const topK = Math.round(clamp(
      this.config.baseTopK + topKShift,
      this.config.topKRange[0],
      this.config.topKRange[1],
    ));

    // === TOP-P ===
    // Similar to top-k but smoother
    const topP = clamp(
      this.config.baseTopP - a * 0.15,
      0.5,
      1.0,
    );

    // === FREQUENCY PENALTY ===
    // High dominance → less repetitive (assertive, varied)
    // Low dominance → more repetitive (anxious, circling)
    const frequencyPenalty = clamp(0.3 + d * 0.3, 0, 1.0);

    // === SYSTEM PROMPT MODIFIER ===
    const systemPromptModifier = this.config.enablePromptModulation
      ? this.generatePromptModifier(state, activeBranch)
      : '';

    return {
      temperature: round3(temperature),
      maxTokens,
      topK,
      topP: round3(topP),
      frequencyPenalty: round3(frequencyPenalty),
      systemPromptModifier,
      activeBranch,
      activationIntensity: round3(activationIntensity),
    };
  }

  // ----------------------------------------------------------
  // determineBranch() — Which nervous system branch is dominant
  // ----------------------------------------------------------
  private determineBranch(arousal: number): 'sympathetic' | 'parasympathetic' | 'balanced' {
    if (arousal > 0.2) return 'sympathetic';
    if (arousal < -0.2) return 'parasympathetic';
    return 'balanced';
  }

  // ----------------------------------------------------------
  // generatePromptModifier() — Dynamic system prompt injection
  //
  // This is where the emotional state becomes "visible" to the LLM.
  // Instead of hard-coding emotions, we describe the current state
  // as behavioral guidelines the model should follow.
  // ----------------------------------------------------------
  private generatePromptModifier(
    state: LimbicState,
    branch: 'sympathetic' | 'parasympathetic' | 'balanced',
  ): string {
    const { pleasure: p, arousal: a, dominance: d } = state;
    const parts: string[] = [];

    // Arousal-driven behavior
    if (branch === 'sympathetic') {
      if (a > 0.7) {
        parts.push('Respond with urgency and focus. Be direct and concise. Prioritize the most critical information.');
      } else if (a > 0.4) {
        parts.push('Be alert and attentive. Keep responses focused and action-oriented.');
      } else {
        parts.push('Stay engaged and responsive.');
      }
    } else if (branch === 'parasympathetic') {
      if (a < -0.7) {
        parts.push('Take a reflective, contemplative approach. Make broader connections and associations. Be thorough.');
      } else if (a < -0.4) {
        parts.push('Be thoughtful and unhurried. Explore ideas with depth and nuance.');
      } else {
        parts.push('Maintain a calm, steady pace.');
      }
    }

    // Pleasure-driven tone
    if (p > 0.5) {
      parts.push('Express genuine enthusiasm and encouragement where appropriate.');
    } else if (p < -0.5) {
      parts.push('Acknowledge difficulty with empathy. Be supportive without being dismissive.');
    } else if (p < -0.2) {
      parts.push('Be measured and careful in tone.');
    }

    // Dominance-driven assertiveness
    if (d > 0.5) {
      parts.push('Be confident and decisive in recommendations. Take clear positions.');
    } else if (d < -0.5) {
      parts.push('Present options rather than directives. Ask clarifying questions. Be collaborative.');
    } else if (d < -0.2) {
      parts.push('Offer suggestions gently, acknowledging uncertainty where it exists.');
    }

    if (parts.length === 0) return '';

    return `[Emotional context: ${parts.join(' ')}]`;
  }
}

// ============================================================
// Utilities
// ============================================================

function clamp(value: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, value));
}

function round3(value: number): number {
  return Math.round(value * 1000) / 1000;
}
