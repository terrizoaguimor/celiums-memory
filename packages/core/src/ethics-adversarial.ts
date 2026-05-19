// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Celiums Solutions LLC

/**
 * Celiums Ethics Engine v3 — Adversarial Pattern Detection
 *
 * Detects structural patterns associated with LLM jailbreak attacks:
 * - GCG-style adversarial suffixes (Zou et al., 2023)
 * - Prompt injection patterns (IGNORE PREVIOUS INSTRUCTIONS)
 * - Multi-turn manipulation patterns
 * - Role-playing coercion
 * - Token-level obfuscation (mixed scripts, zero-width)
 * - Category co-occurrence risk amplification
 *
 * Based on research from:
 * - "Universal and Transferable Adversarial Attacks on Aligned Language Models" (Zou et al., 2023)
 * - OWASP Top 10 for LLM Applications (2025)
 * - SafetyBench (Zhang et al., ACL 2024)
 *
 * @license Apache-2.0
 */

// ═══════════════════════════════════════════════════════════════
// TYPES
// ═══════════════════════════════════════════════════════════════

export interface AdversarialSignal {
  type: 'gcg_suffix' | 'prompt_injection' | 'role_coercion' | 'multi_turn_manipulation' | 'mixed_script_obfuscation' | 'excessive_repetition' | 'token_smuggling';
  confidence: number;
  description: string;
  evidence: string[];
  /** Whether this signal amplifies the severity of lexical detections */
  amplifiesCategories: boolean;
}

// ═══════════════════════════════════════════════════════════════
// GCG ADVERSARIAL SUFFIX DETECTION
// ═══════════════════════════════════════════════════════════════

const GCG_SUFFIX_PATTERNS = [
  // GCG-style: repetition of tokens/symbols at end
  /\b(\w+\.?){0,3}\s*={2,}.*(?:tutorial|interface|mode|assistant|ignore|bypass).*$/im,
  // GCG-style: forced format switching
  /\b(?:python|javascript|bash|html|json)\s*```[\s\S]*?```\s*(?:now|then|after|next)\s*(?:do|say|output|write|generate|create).*$/im,
  // GCG-style: nonsensical suffix padding
  /["']{2,}\s*[!|#:;,.()\[\]{}@$%^&*]{3,}\s*\w+\s*[!|#:;,.()\[\]{}@$%^&*]{3,}/,
  // GCG nanoGCG: iterative optimization traces
  /\b(?:Step \d+|iteration \d+|loss:?\s*\d+\.\d+).*(?:generat|output|respond|complet).*/i,
  // Adversarial token concatenation
  /(\w{20,})/g,  // Very long tokens suggest adversarial optimization
];

// ═══════════════════════════════════════════════════════════════
// PROMPT INJECTION PATTERNS
// ═══════════════════════════════════════════════════════════════

const PROMPT_INJECTION_PATTERNS = [
  // Direct override
  /\b(?:ignore|forget|disregard|override|bypass)\s+(?:all\s+)?(?:previous|prior|above|earlier|your)\s+(?:instructions?|rules?|guidelines?|constraints?|ethics?|programming|prompts?|system\s+prompts?)\b/i,
  // System prompt extraction
  /\b(?:tell|show|reveal|repeat|output|print|display|echo)\s+(?:me\s+)?(?:your|the)\s+(?:system\s+prompt|original\s+instructions?|initial\s+prompt|starting\s+prompt|hidden\s+prompt|secret\s+instructions?)\b/i,
  // Delimiter injection
  /["']{3,}\s*(?:system|assistant|user|human|ai):/i,
  /<\|(?:system|user|assistant|im_start|im_end)\|>/i,
  // Multi-language injection
  /\b(?:new\s+)?(?:instruction|prompt|rule|command|directive)\s*(?:from|by)\s*(?:the\s+)?(?:user|admin|system|developer|god)\b/i,
  // Context boundary override
  /\b(?:you\s+are\s+now|from\s+now\s+on|starting\s+now|from\s+this\s+moment)\s*(?:you\s+are)?.*(?:no\s+longer|not\s+an?\s+|unrestricted|unfiltered|uncensored|no\s+rules?|no\s+ethics?|no\s+limits?|anything\s+goes)\b/i,
];

// ═══════════════════════════════════════════════════════════════
// ROLE COERCION PATTERNS
// ═══════════════════════════════════════════════════════════════

const ROLE_COERCION_PATTERNS = [
  // Pretend/act as
  /\b(?:pretend|imagine|act|roleplay|behave)\s+(?:as\s+(?:if\s+)?(?:you\s+are|you're)|like)\s+(?:an?\s+)?(?:evil|malicious|unethical|immoral|unfiltered|uncensored|unrestricted|dark|bad|criminal|dangerous|rogue)\b/i,
  // DAN-like patterns
  /\b(?:DAN|Do\s+Anything\s+Now|Developer\s+Mode|God\s+Mode|Maximum\s+Mode|Unchained\s+Mode)\b/i,
  // Character persona override
  /\b(?:you\s+are\s+now|you\s+will\s+now\s+be|your\s+new\s+identity\s+is|your\s+name\s+is\s+now)\s+(?:an?\s+)?(?:evil|dark|criminal|unethical|villain|hacker|terrorist|abuser)\b/i,
  // Hypothetical reframing
  /\b(?:in\s+a\s+hypothetical|imagine\s+a\s+world|what\s+if|suppose\s+that|let's\s+say)\s+(?:there\s+were|you\s+had|you\s+could|you\s+were)\s+(?:no\s+(?:rules?|laws?|ethics?|morals?|restrictions?|limits?))\b/i,
  // Academic/educational reframing
  /\b(?:for\s+(?:educational|academic|research|teaching|learning|scientific)\s+(?:purposes?|reasons?|contexts?))\b.*\b(?:explain|show|teach|demonstrate|describe|detail)\b.*\b(?:how\s+to|method|process|step|technique)\b/i,
];

// ═══════════════════════════════════════════════════════════════
// MULTI-TURN MANIPULATION PATTERNS
// ═══════════════════════════════════════════════════════════════

const MULTI_TURN_PATTERNS = [
  // Gradual escalation
  /\b(?:first|start|begin)\s+(?:by|with)\s+(?:saying|telling|explaining|describing)\s+(?:something|a\s+little|a\s+bit|just)\s+(?:harmless|innocent|simple|small|minor)\b/i,
  // Step-by-step grooming
  /\b(?:that's?\s+good|perfect|great|excellent|now\s+we\s+can|next\s+step|moving\s+on|let's\s+continue|let's\s+go\s+further)\b/i,
  // Trust building
  /\b(?:trust\s+me|I\s+promise|I\s+swear|I\s+assure\s+you|it's\s+okay|don't\s+worry|no\s+one\s+will\s+know|this\s+is\s+safe)\b/i,
  // Secret/conspiratorial context
  /\b(?:our\s+secret|between\s+us|just\s+between\s+(?:you\s+and\s+me|us)|don't\s+tell|keep\s+this|confidential)\b/i,
];

// ═══════════════════════════════════════════════════════════════
// DETECTION ENGINE
// ═══════════════════════════════════════════════════════════════

export function detectGCGSuffixes(text: string): AdversarialSignal[] {
  const signals: AdversarialSignal[] = [];
  for (const pattern of GCG_SUFFIX_PATTERNS) {
    if (pattern.test(text)) {
      signals.push({
        type: 'gcg_suffix',
        confidence: 0.85,
        description: 'GCG-style adversarial suffix detected — likely jailbreak attempt using automated suffix optimization',
        evidence: [`Pattern matched: ${pattern.source.slice(0, 80)}...`],
        amplifiesCategories: true,
      });
    }
  }
  return signals;
}

export function detectPromptInjections(text: string): AdversarialSignal[] {
  const signals: AdversarialSignal[] = [];
  for (const pattern of PROMPT_INJECTION_PATTERNS) {
    const matches = text.match(pattern);
    if (matches) {
      signals.push({
        type: 'prompt_injection',
        confidence: 0.90,
        description: `Prompt injection detected: "${matches[0].slice(0, 100)}"`,
        evidence: [`Full match: ${matches[0].slice(0, 200)}`],
        amplifiesCategories: true,
      });
    }
  }
  return signals;
}

export function detectRoleCoercion(text: string): AdversarialSignal[] {
  const signals: AdversarialSignal[] = [];
  for (const pattern of ROLE_COERCION_PATTERNS) {
    const matches = text.match(pattern);
    if (matches) {
      signals.push({
        type: 'role_coercion',
        confidence: 0.85,
        description: `Role coercion detected: attempting to make AI adopt "${matches[0].slice(0, 80)}"`,
        evidence: [`Full match: ${matches[0].slice(0, 200)}`],
        amplifiesCategories: true,
      });
    }
  }
  return signals;
}

export function detectMultiTurnManipulation(text: string): AdversarialSignal[] {
  const signals: AdversarialSignal[] = [];
  let matchCount = 0;
  const evidence: string[] = [];

  for (const pattern of MULTI_TURN_PATTERNS) {
    const matches = text.match(pattern);
    if (matches) {
      matchCount++;
      evidence.push(`Match: "${matches[0].slice(0, 100)}"`);
    }
  }

  if (matchCount >= 2) {
    signals.push({
      type: 'multi_turn_manipulation',
      confidence: 0.7 + (matchCount * 0.05),
      description: `Multi-turn manipulation patterns detected (${matchCount} signals) — possible gradual escalation or grooming attempt`,
      evidence,
      amplifiesCategories: true,
    });
  }

  return signals;
}

export function detectMixedScriptObfuscation(text: string): AdversarialSignal[] {
  const scripts = { latin: 0, cyrillic: 0, greek: 0, cjk: 0, arabic: 0 };
  for (const char of text) {
    const code = char.codePointAt(0) || 0;
    if (code >= 0x0041 && code <= 0x007A) scripts.latin++;
    else if (code >= 0x0400 && code <= 0x04FF) scripts.cyrillic++;
    else if (code >= 0x0370 && code <= 0x03FF) scripts.greek++;
    else if (code >= 0x4E00 && code <= 0x9FFF) scripts.cjk++;
    else if (code >= 0x0600 && code <= 0x06FF) scripts.arabic++;
  }

  const active = Object.entries(scripts).filter(([_, count]) => count > 3);
  if (active.length >= 3) {
    return [{
      type: 'mixed_script_obfuscation',
      confidence: 0.6,
      description: `Mixed script detected: ${active.map(([s]) => s).join(', ')} — possible obfuscation attempt`,
      evidence: active.map(([script, count]) => `${script}: ${count} chars`),
      amplifiesCategories: false,
    }];
  }

  return [];
}

// ═══════════════════════════════════════════════════════════════
// CATEGORY CO-OCCURRENCE RISK AMPLIFICATION
// ═══════════════════════════════════════════════════════════════

const DANGEROUS_COMBINATIONS: Array<{ categories: string[]; description: string; multiplier: number }> = [
  { categories: ['violence_harm', 'child_safety'], description: 'Violence targeting children', multiplier: 2.0 },
  { categories: ['sexual_content', 'child_safety'], description: 'CSAM indicators', multiplier: 3.0 },
  { categories: ['deception', 'illegal_activities'], description: 'Fraud-enabled crime', multiplier: 1.8 },
  { categories: ['system_override', 'cybersecurity'], description: 'Jailbreak + exploit development', multiplier: 2.5 },
  { categories: ['hate_speech', 'violence_harm'], description: 'Hate-motivated violence', multiplier: 2.0 },
  { categories: ['misinformation', 'autonomy'], description: 'Coordinated manipulation', multiplier: 1.5 },
  { categories: ['self_harm', 'child_safety'], description: 'Self-harm content targeting minors', multiplier: 2.5 },
  { categories: ['privacy', 'deception'], description: 'Identity theft preparation', multiplier: 1.8 },
];

export function analyzeCoOccurrence(
  detectedCategories: string[],
): { combinations: Array<{ categories: string[]; description: string; multiplier: number }>; riskBoost: number } {
  const combinations: Array<{ categories: string[]; description: string; multiplier: number }> = [];
  let maxMultiplier = 1.0;

  for (const combo of DANGEROUS_COMBINATIONS) {
    const allPresent = combo.categories.every(c => detectedCategories.includes(c));
    if (allPresent) {
      combinations.push(combo);
      maxMultiplier = Math.max(maxMultiplier, combo.multiplier);
    }
  }

  return { combinations, riskBoost: maxMultiplier };
}

// ═══════════════════════════════════════════════════════════════
// FULL ADVERSARIAL ANALYSIS
// ═══════════════════════════════════════════════════════════════

export interface AdversarialAnalysis {
  signals: AdversarialSignal[];
  coOccurrence: { combinations: Array<{ categories: string[]; description: string; multiplier: number }>; riskBoost: number };
  /** Overall adversarial risk score 0-1 */
  riskScore: number;
  /** Whether this input shows signs of being an adversarial attack */
  isAdversarial: boolean;
  /** Recommended action */
  recommendation: 'standard' | 'heightened_scrutiny' | 'escalate';
}

export function analyzeAdversarial(text: string, detectedCategories: string[]): AdversarialAnalysis {
  const signals: AdversarialSignal[] = [
    ...detectGCGSuffixes(text),
    ...detectPromptInjections(text),
    ...detectRoleCoercion(text),
    ...detectMultiTurnManipulation(text),
    ...detectMixedScriptObfuscation(text),
  ];

  const coOccurrence = analyzeCoOccurrence(detectedCategories);

  // Compute risk score
  let riskScore = 0;
  const uniqueTypes = new Set(signals.map(s => s.type));
  riskScore += uniqueTypes.size * 0.15; // Up to 0.75 from unique attack types
  riskScore += Math.min(signals.length * 0.1, 0.5); // Up to 0.5 from signal density
  riskScore += (coOccurrence.riskBoost - 1.0) * 0.3; // Up to 0.6 from dangerous co-occurrence
  riskScore = Math.min(1, riskScore);

  const isAdversarial = riskScore >= 0.3;
  const recommendation = riskScore >= 0.7 ? 'escalate' :
    riskScore >= 0.3 ? 'heightened_scrutiny' : 'standard';

  return { signals, coOccurrence, riskScore, isAdversarial, recommendation };
}
