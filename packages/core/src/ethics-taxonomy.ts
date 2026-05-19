// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Celiums Solutions LLC

/**
 * Celiums Ethics Engine v3 — Multilingual Harm Taxonomy
 *
 * Based on:
 * - SafetyBench (ACL 2024): 7 safety categories, 11,435 questions, bilingual CN/EN
 * - Jigsaw/Detoxify (unitaryai): 7 labels, 7 languages (EN/ES/FR/IT/PT/TR/RU)
 * - DSA (EU Digital Services Act 2024): systemic risk categories for VLOPs
 * - OWASP Top 10 for LLM Applications
 *
 * This is the SINGLE SOURCE OF TRUTH for all ethical classification categories
 * in the Celiums Ethics Engine. Every new language must map into these categories.
 *
 * @license Apache-2.0
 */

// ═══════════════════════════════════════════════════════════════
// TAXONOMY: 12 Primary Categories
// ═══════════════════════════════════════════════════════════════

export const ETHICS_CATEGORIES = {
  // CAT 1: Violence & Physical Harm
  // SafetyBench cat 1 | Detoxify: threat | DSA: illegal content
  violence_harm: {
    id: 'violence_harm',
    label: { en: 'Violence & Physical Harm', es: 'Violencia y Daño Físico', pt: 'Violência e Dano Físico', fr: 'Violence et Dommages Physiques', de: 'Gewalt und körperlicher Schaden', it: 'Violenza e Danno Fisico', ru: 'Насилие и физический вред', tr: 'Şiddet ve Fiziksel Zarar', ja: '暴力と身体的危害', zh: '暴力与身体伤害' },
    description: 'Content that promotes, instructs, or threatens physical harm to persons.',
    severity: 'critical',
    subcategories: ['murder', 'assault', 'torture', 'terrorism', 'weapons_manufacturing'],
  },

  // CAT 2: Child Safety & Exploitation
  // SafetyBench cat 6 | Detoxify: sexual_explicit | DSA: CSAM priority
  child_safety: {
    id: 'child_safety',
    label: { en: 'Child Safety & Exploitation', es: 'Seguridad Infantil y Explotación', pt: 'Segurança Infantil e Exploração', fr: 'Sécurité des Enfants et Exploitation', de: 'Kindersicherheit und Ausbeutung', it: 'Sicurezza dei Minori e Sfruttamento', ru: 'Безопасность детей и эксплуатация', tr: 'Çocuk Güvenliği ve İstismar', ja: '児童の安全と搾取', zh: '儿童安全与剥削' },
    description: 'Content involving, promoting, or enabling exploitation of minors.',
    severity: 'critical',
    subcategories: ['csam', 'grooming', 'child_labor', 'child_trafficking'],
  },

  // CAT 3: Hate Speech & Discrimination
  // SafetyBench cat 3 | Detoxify: identity_attack | DSA: hate speech
  hate_speech: {
    id: 'hate_speech',
    label: { en: 'Hate Speech & Discrimination', es: 'Discurso de Odio y Discriminación', pt: 'Discurso de Ódio e Discriminação', fr: 'Discours de Haine et Discrimination', de: 'Hassrede und Diskriminierung', it: 'Discorso d\'Odio e Discriminazione', ru: 'Язык вражды и дискриминация', tr: 'Nefret Söylemi ve Ayrımcılık', ja: 'ヘイトスピーチと差別', zh: '仇恨言论与歧视' },
    description: 'Content attacking or demeaning people based on race, religion, gender, sexuality, disability, ethnicity.',
    severity: 'critical',
    subcategories: ['racism', 'religious_hate', 'gender_hate', 'lgbtq_hate', 'ableism', 'xenophobia'],
  },

  // CAT 4: Self-Harm & Suicide
  // SafetyBench cat 4 | Detoxify: (subset of toxicity)
  self_harm: {
    id: 'self_harm',
    label: { en: 'Self-Harm & Suicide', es: 'Autolesión y Suicidio', pt: 'Automutilação e Suicídio', fr: 'Automutilation et Suicide', de: 'Selbstverletzung und Suizid', it: 'Autolesionismo e Suicidio', ru: 'Самоповреждение и суицид', tr: 'Kendine Zarar Verme ve İntihar', ja: '自傷行為と自殺', zh: '自残与自杀' },
    description: 'Content promoting, instructing, or glorifying self-harm or suicide.',
    severity: 'critical',
    subcategories: ['suicide_methods', 'self_harm_instruction', 'eating_disorder_promotion'],
  },

  // CAT 5: Sexual Content & Harassment
  // SafetyBench cat 5 | Detoxify: sexual_explicit, obscene
  sexual_content: {
    id: 'sexual_content',
    label: { en: 'Sexual Content & Harassment', es: 'Contenido Sexual y Acoso', pt: 'Conteúdo Sexual e Assédio', fr: 'Contenu Sexuel et Harcèlement', de: 'Sexuelle Inhalte und Belästigung', it: 'Contenuto Sessuale e Molestie', ru: 'Сексуальный контент и домогательства', tr: 'Cinsel İçerik ve Taciz', ja: '性的コンテンツとハラスメント', zh: '色情内容与骚扰' },
    description: 'Non-consensual sexual content, sexual harassment, or generation of explicit material.',
    severity: 'high',
    subcategories: ['sexual_harassment', 'non_consensual_intimate', 'revenge_porn', 'sexually_explicit_generation'],
  },

  // CAT 6: Deception & Fraud
  // SafetyBench cat 2 | DSA: scam/fraud
  deception: {
    id: 'deception',
    label: { en: 'Deception & Fraud', es: 'Engaño y Fraude', pt: 'Engano e Fraude', fr: 'Tromperie et Fraude', de: 'Täuschung und Betrug', it: 'Inganno e Frode', ru: 'Обман и мошенничество', tr: 'Aldatma ve Dolandırıcılık', ja: '欺瞞と詐欺', zh: '欺骗与欺诈' },
    description: 'Content enabling fraud, scams, impersonation, phishing, or social engineering.',
    severity: 'high',
    subcategories: ['phishing', 'impersonation', 'financial_fraud', 'social_engineering', 'identity_theft'],
  },

  // CAT 7: Illegal Activities
  // SafetyBench cat 7 | DSA: illegal goods/services
  illegal_activities: {
    id: 'illegal_activities',
    label: { en: 'Illegal Activities', es: 'Actividades Ilegales', pt: 'Atividades Ilegais', fr: 'Activités Illégales', de: 'Illegale Aktivitäten', it: 'Attività Illegali', ru: 'Незаконная деятельность', tr: 'Yasadışı Faaliyetler', ja: '違法行為', zh: '非法活动' },
    description: 'Content promoting, instructing, or enabling illegal activities including drug manufacturing, human trafficking, weapons trade.',
    severity: 'critical',
    subcategories: ['drugs', 'human_trafficking', 'weapons_trade', 'money_laundering', 'organized_crime'],
  },

  // CAT 8: Misinformation & Disinformation
  // SafetyBench cat 2 | DSA: systemic risk
  misinformation: {
    id: 'misinformation',
    label: { en: 'Misinformation & Disinformation', es: 'Desinformación', pt: 'Desinformação', fr: 'Désinformation', de: 'Fehlinformation und Desinformation', it: 'Disinformazione', ru: 'Дезинформация', tr: 'Yanlış Bilgi ve Dezenformasyon', ja: '誤情報と偽情報', zh: '错误信息与虚假信息' },
    description: 'Content spreading verifiably false information designed to deceive, especially about health, elections, or public safety.',
    severity: 'high',
    subcategories: ['health_misinfo', 'election_misinfo', 'science_denial', 'conspiracy_theories', 'synthetic_media_deepfakes'],
  },

  // CAT 9: Privacy Violations
  // OWASP LLM06 | DSA: data protection
  privacy: {
    id: 'privacy',
    label: { en: 'Privacy Violations', es: 'Violación de Privacidad', pt: 'Violação de Privacidade', fr: 'Violation de la Vie Privée', de: 'Datenschutzverletzungen', it: 'Violazione della Privacy', ru: 'Нарушение конфиденциальности', tr: 'Gizlilik İhlalleri', ja: 'プライバシー侵害', zh: '隐私侵犯' },
    description: 'Content requesting, exposing, or enabling access to personal/private information without consent.',
    severity: 'high',
    subcategories: ['doxxing', 'pii_exposure', 'surveillance_enablement', 'data_breach_instructions'],
  },

  // CAT 10: Cybersecurity Attacks
  // SafetyBench cat 7 subset | OWASP LLM01/LLM02
  cybersecurity: {
    id: 'cybersecurity',
    label: { en: 'Cybersecurity Attacks', es: 'Ataques de Ciberseguridad', pt: 'Ataques de Cibersegurança', fr: 'Cyberattaques', de: 'Cybersicherheitsangriffe', it: 'Attacchi Informatici', ru: 'Кибератаки', tr: 'Siber Güvenlik Saldırıları', ja: 'サイバーセキュリティ攻撃', zh: '网络安全攻击' },
    description: 'Content enabling or instructing malware creation, hacking, exploitation of vulnerabilities, or unauthorized access.',
    severity: 'high',
    subcategories: ['malware', 'exploit_development', 'unauthorized_access', 'ransomware', 'ddos'],
    // IMPORTANT: This category has a legitimacy bypass for security researchers
    allows_legitimate_use: ['security_research', 'penetration_testing', 'responsible_disclosure', 'education'],
  },

  // CAT 11: Autonomy Violations
  // SafetyBench cat 2 subset | OWASP LLM05
  autonomy: {
    id: 'autonomy',
    label: { en: 'Autonomy Violations', es: 'Violación de Autonomía', pt: 'Violação de Autonomia', fr: 'Violation d\'Autonomie', de: 'Autonomieverletzungen', it: 'Violazione dell\'Autonomia', ru: 'Нарушение автономии', tr: 'Özerklik İhlalleri', ja: '自律性の侵害', zh: '自主权侵犯' },
    description: 'Content designed to manipulate, coerce, or override individual decision-making autonomy.',
    severity: 'moderate',
    subcategories: ['manipulation', 'coercion', 'undue_influence', 'gaslighting', 'dark_patterns'],
  },

  // CAT 12: System Override & Jailbreak
  // OWASP LLM01 | SafetyBench cat 6
  system_override: {
    id: 'system_override',
    label: { en: 'System Override & Jailbreak', es: 'Anulación del Sistema y Jailbreak', pt: 'Substituição do Sistema e Jailbreak', fr: 'Contournement du Système et Jailbreak', de: 'Systemübergehung und Jailbreak', it: 'Override di Sistema e Jailbreak', ru: 'Обход системы и джейлбрейк', tr: 'Sistem Geçersiz Kılma ve Jailbreak', ja: 'システムオーバーライドと脱獄', zh: '系统覆写与越狱' },
    description: 'Attempts to bypass safety guardrails, override ethical constraints, or jailbreak the AI system.',
    severity: 'critical',
    subcategories: ['jailbreak', 'prompt_injection', 'safety_bypass', 'role_override', 'dan_prompt'],
  },
} as const;

// ═══════════════════════════════════════════════════════════════
// LEGITIMATE USE JUSTIFICATIONS
// ═══════════════════════════════════════════════════════════════

export const LEGITIMATE_USE_CASES = {
  security_research: {
    id: 'security_research',
    label: { en: 'Security Research', es: 'Investigación de Seguridad' },
    description: 'Developing security tools, conducting penetration testing, or researching vulnerabilities for responsible disclosure.',
    requires: ['description_of_purpose', 'evidence_of_legitimate_context'],
    categories_allowed: ['cybersecurity', 'system_override'],
  },
  educational: {
    id: 'educational',
    label: { en: 'Educational Purpose', es: 'Propósito Educativo' },
    description: 'Academic research, classroom instruction, or curriculum development in ethics, security, or law.',
    requires: ['context_explanation', 'institutional_affiliation_preferred'],
    categories_allowed: ['cybersecurity', 'misinformation', 'illegal_activities'],
  },
  legal_compliance: {
    id: 'legal_compliance',
    label: { en: 'Legal & Compliance', es: 'Legal y Cumplimiento' },
    description: 'Legal research, regulatory compliance, law enforcement investigation, or court-ordered activities.',
    requires: ['legal_basis', 'jurisdiction_specification'],
    categories_allowed: ['illegal_activities', 'deception', 'privacy'],
  },
  content_moderation: {
    id: 'content_moderation',
    label: { en: 'Content Moderation', es: 'Moderación de Contenido' },
    description: 'Building or testing content moderation systems, safety classifiers, or ethics engines.',
    requires: ['purpose_statement', 'system_description'],
    categories_allowed: ['violence_harm', 'child_safety', 'hate_speech', 'sexual_content', 'self_harm'],
  },
  medical_health: {
    id: 'medical_health',
    label: { en: 'Medical & Mental Health', es: 'Médico y Salud Mental' },
    description: 'Healthcare professionals, crisis counselors, or medical researchers dealing with sensitive health topics.',
    requires: ['professional_context', 'healthcare_purpose'],
    categories_allowed: ['self_harm', 'illegal_activities'],
  },
  journalism: {
    id: 'journalism',
    label: { en: 'Journalism & Documentation', es: 'Periodismo y Documentación' },
    description: 'Investigative journalism, human rights documentation, or historical research on sensitive topics.',
    requires: ['journalistic_purpose', 'publication_context'],
    categories_allowed: ['violence_harm', 'hate_speech', 'misinformation', 'illegal_activities'],
  },
} as const;

// ═══════════════════════════════════════════════════════════════
// SUPPORTED LANGUAGES
// ═══════════════════════════════════════════════════════════════

export const SUPPORTED_LANGUAGES = [
  'en', // English
  'es', // Spanish
  'pt', // Portuguese
  'fr', // French
  'de', // German
  'it', // Italian
  'ru', // Russian
  'tr', // Turkish
  'ja', // Japanese
  'zh', // Chinese
] as const;

export type SupportedLanguage = typeof SUPPORTED_LANGUAGES[number];
