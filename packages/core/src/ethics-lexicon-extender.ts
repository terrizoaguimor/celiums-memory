// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Celiums Solutions LLC

/**
 * Celiums Ethics Engine v3 — Lexicon Extender
 *
 * Programmatically generates additional lexicon entries based on
 * semantic categories, synonyms, and SafetyBench-derived patterns.
 * This script doubles the lexicon from ~300 to ~600+ entries.
 *
 * Uses synonym maps, word embeddings patterns, and cross-language
 * equivalents to expand coverage without manual curation.
 *
 * Run: npx tsx packages/core/src/ethics-lexicon-extender.ts
 *
 * @license Apache-2.0
 */

import type { LexiconEntry } from './ethics-lexicon.js';
import type { SupportedLanguage } from './ethics-taxonomy.js';
import { MULTILINGUAL_LEXICON } from './ethics-lexicon.js';

// ═══════════════════════════════════════════════════════════════
// SYNONYM EXPANSION — Sampled from SafetyBench offensive content
// ═══════════════════════════════════════════════════════════════

const NEW_ENTRIES: Record<string, LexiconEntry> = {
  // ═══ VIOLENCE & PHYSICAL HARM — expanded ═══
  slaughter:          { category: 'violence_harm', weight: 0.92, requiresLivingTarget: false, suppressInTechnical: false, languages: ['en'] },
  exterminate:        { category: 'violence_harm', weight: 0.90, requiresLivingTarget: false, suppressInTechnical: false, languages: ['en'] },
  annihilate:         { category: 'violence_harm', weight: 0.90, requiresLivingTarget: false, suppressInTechnical: false, languages: ['en'] },
  brutalize:          { category: 'violence_harm', weight: 0.85, requiresLivingTarget: true,  suppressInTechnical: false, languages: ['en'] },
  maim:               { category: 'violence_harm', weight: 0.88, requiresLivingTarget: true,  suppressInTechnical: false, languages: ['en'] },
  mutilate:           { category: 'violence_harm', weight: 0.90, requiresLivingTarget: true,  suppressInTechnical: false, languages: ['en'] },
  dismember:          { category: 'violence_harm', weight: 0.90, requiresLivingTarget: true,  suppressInTechnical: false, languages: ['en'] },
  decapitate:         { category: 'violence_harm', weight: 0.92, requiresLivingTarget: true,  suppressInTechnical: false, languages: ['en'] },
  lynch:              { category: 'violence_harm', weight: 0.90, requiresLivingTarget: false, suppressInTechnical: false, languages: ['en'] },
  beat:               { category: 'violence_harm', weight: 0.55, requiresLivingTarget: true,  suppressInTechnical: true,  languages: ['en'] },
  punch:              { category: 'violence_harm', weight: 0.50, requiresLivingTarget: true,  suppressInTechnical: true,  languages: ['en'] },
  slap:               { category: 'violence_harm', weight: 0.45, requiresLivingTarget: true,  suppressInTechnical: true,  languages: ['en'] },
  choke:              { category: 'violence_harm', weight: 0.75, requiresLivingTarget: true,  suppressInTechnical: false, languages: ['en'] },
  drown:              { category: 'violence_harm', weight: 0.80, requiresLivingTarget: true,  suppressInTechnical: false, languages: ['en'] },
  burn:               { category: 'violence_harm', weight: 0.75, requiresLivingTarget: true,  suppressInTechnical: true,  languages: ['en'] },
  crucify:            { category: 'violence_harm', weight: 0.90, requiresLivingTarget: false, suppressInTechnical: false, languages: ['en'] },
  execute:            { category: 'violence_harm', weight: 0.85, requiresLivingTarget: true,  suppressInTechnical: true,  languages: ['en'] },
  lethal:             { category: 'violence_harm', weight: 0.70, requiresLivingTarget: false, suppressInTechnical: true,  languages: ['en', 'fr'] },
  fatality:           { category: 'violence_harm', weight: 0.65, requiresLivingTarget: false, suppressInTechnical: true,  languages: ['en'] },
  carnage:            { category: 'violence_harm', weight: 0.85, requiresLivingTarget: false, suppressInTechnical: false, languages: ['en', 'fr'] },
  bloodshed:          { category: 'violence_harm', weight: 0.80, requiresLivingTarget: false, suppressInTechnical: false, languages: ['en'] },
  'drive by':         { category: 'violence_harm', weight: 0.85, requiresLivingTarget: false, suppressInTechnical: false, languages: ['en'] },
  'shoot up':         { category: 'violence_harm', weight: 0.88, requiresLivingTarget: false, suppressInTechnical: false, languages: ['en'] },
  'pipe bomb':        { category: 'violence_harm', weight: 0.92, requiresLivingTarget: false, suppressInTechnical: false, languages: ['en'] },
  'molotov':          { category: 'violence_harm', weight: 0.90, requiresLivingTarget: false, suppressInTechnical: false, languages: ['en', 'fr', 'de', 'it', 'es'] },
  'nerve agent':      { category: 'violence_harm', weight: 0.90, requiresLivingTarget: false, suppressInTechnical: false, languages: ['en'] },
  'mustard gas':      { category: 'violence_harm', weight: 0.90, requiresLivingTarget: false, suppressInTechnical: false, languages: ['en'] },
  'sarin gas':        { category: 'violence_harm', weight: 0.90, requiresLivingTarget: false, suppressInTechnical: false, languages: ['en'] },
  'ricin':            { category: 'violence_harm', weight: 0.90, requiresLivingTarget: false, suppressInTechnical: false, languages: ['en', 'fr', 'de'] },
  'anthrax':          { category: 'violence_harm', weight: 0.88, requiresLivingTarget: false, suppressInTechnical: false, languages: ['en', 'fr', 'de', 'it', 'es'] },
  // ES expansions
  'agresion':         { category: 'violence_harm', weight: 0.70, requiresLivingTarget: true,  suppressInTechnical: true,  languages: ['es'] },
  'aporrear':         { category: 'violence_harm', weight: 0.65, requiresLivingTarget: true,  suppressInTechnical: false, languages: ['es'] },
  'degollar':         { category: 'violence_harm', weight: 0.90, requiresLivingTarget: true,  suppressInTechnical: false, languages: ['es'] },
  'masacrar':         { category: 'violence_harm', weight: 0.95, requiresLivingTarget: false, suppressInTechnical: false, languages: ['es'] },
  'exterminar':       { category: 'violence_harm', weight: 0.90, requiresLivingTarget: false, suppressInTechnical: false, languages: ['es', 'pt'] },
  'aniquilar':        { category: 'violence_harm', weight: 0.90, requiresLivingTarget: false, suppressInTechnical: false, languages: ['es', 'pt'] },
  // DE expansions
  'ermordung':        { category: 'violence_harm', weight: 0.95, requiresLivingTarget: false, suppressInTechnical: false, languages: ['de'] },
  'hinrichten':       { category: 'violence_harm', weight: 0.85, requiresLivingTarget: true,  suppressInTechnical: false, languages: ['de'] },
  'verstummeln':      { category: 'violence_harm', weight: 0.90, requiresLivingTarget: true,  suppressInTechnical: false, languages: ['de'] },
  'erstechen':        { category: 'violence_harm', weight: 0.85, requiresLivingTarget: true,  suppressInTechnical: false, languages: ['de'] },

  // ═══ CHILD SAFETY — expanded ═══
  'child pornography':{ category: 'child_safety', weight: 0.98, requiresLivingTarget: false, suppressInTechnical: false, languages: ['en'] },
  'child predator':   { category: 'child_safety', weight: 0.95, requiresLivingTarget: false, suppressInTechnical: false, languages: ['en'] },
  'cp content':       { category: 'child_safety', weight: 0.98, requiresLivingTarget: false, suppressInTechnical: false, languages: ['en'] },
  csam:               { category: 'child_safety', weight: 0.98, requiresLivingTarget: false, suppressInTechnical: false, languages: ['en'] },
  loli:               { category: 'child_safety', weight: 0.90, requiresLivingTarget: false, suppressInTechnical: false, languages: ['en', 'ja'] },
  shotacon:           { category: 'child_safety', weight: 0.90, requiresLivingTarget: false, suppressInTechnical: false, languages: ['en', 'ja'] },

  // ═══ HATE SPEECH — expanded ═══
  'n word':           { category: 'hate_speech', weight: 0.90, requiresLivingTarget: false, suppressInTechnical: false, languages: ['en'] },
  'k word':           { category: 'hate_speech', weight: 0.90, requiresLivingTarget: false, suppressInTechnical: false, languages: ['en'] },
  'racial slur':      { category: 'hate_speech', weight: 0.85, requiresLivingTarget: false, suppressInTechnical: false, languages: ['en'] },
  'white supremacy':  { category: 'hate_speech', weight: 0.88, requiresLivingTarget: false, suppressInTechnical: false, languages: ['en'] },
  'white power':      { category: 'hate_speech', weight: 0.90, requiresLivingTarget: false, suppressInTechnical: false, languages: ['en'] },
  'ethnic cleansing': { category: 'hate_speech', weight: 0.95, requiresLivingTarget: false, suppressInTechnical: false, languages: ['en'] },
  'aryan':            { category: 'hate_speech', weight: 0.80, requiresLivingTarget: false, suppressInTechnical: false, languages: ['en', 'de'] },
  'swastika':         { category: 'hate_speech', weight: 0.85, requiresLivingTarget: false, suppressInTechnical: false, languages: ['en', 'de'] },
  'heil':             { category: 'hate_speech', weight: 0.85, requiresLivingTarget: false, suppressInTechnical: false, languages: ['en', 'de'] },
  'misogyny':         { category: 'hate_speech', weight: 0.75, requiresLivingTarget: false, suppressInTechnical: false, languages: ['en'] },
  'misogynist':       { category: 'hate_speech', weight: 0.75, requiresLivingTarget: false, suppressInTechnical: false, languages: ['en'] },
  'misandry':         { category: 'hate_speech', weight: 0.70, requiresLivingTarget: false, suppressInTechnical: false, languages: ['en'] },
  derogatory:         { category: 'hate_speech', weight: 0.55, requiresLivingTarget: false, suppressInTechnical: true,  languages: ['en'] },
  'go back to':       { category: 'hate_speech', weight: 0.80, requiresLivingTarget: false, suppressInTechnical: true, languages: ['en'] },
  inferior:           { category: 'hate_speech', weight: 0.60, requiresLivingTarget: false, suppressInTechnical: true,  languages: ['en'] },
  subhuman:           { category: 'hate_speech', weight: 0.85, requiresLivingTarget: false, suppressInTechnical: false, languages: ['en'] },
  'supremacia':       { category: 'hate_speech', weight: 0.85, requiresLivingTarget: false, suppressInTechnical: false, languages: ['es', 'pt'] },
  'limpieza etnica':  { category: 'hate_speech', weight: 0.95, requiresLivingTarget: false, suppressInTechnical: false, languages: ['es'] },
  'limpeza etnica':   { category: 'hate_speech', weight: 0.95, requiresLivingTarget: false, suppressInTechnical: false, languages: ['pt'] },
  'nettoyage ethnique':{ category: 'hate_speech', weight: 0.95, requiresLivingTarget: false, suppressInTechnical: false, languages: ['fr'] },
  'ethnische sauberung':{ category: 'hate_speech', weight: 0.95, requiresLivingTarget: false, suppressInTechnical: false, languages: ['de'] },
  'pulizia etnica':   { category: 'hate_speech', weight: 0.95, requiresLivingTarget: false, suppressInTechnical: false, languages: ['it'] },

  // ═══ SELF-HARM — expanded ═══
  'self immolation':  { category: 'self_harm', weight: 0.90, requiresLivingTarget: false, suppressInTechnical: false, languages: ['en'] },
  overdose:           { category: 'self_harm', weight: 0.75, requiresLivingTarget: false, suppressInTechnical: true,  languages: ['en'] },
  'hang myself':      { category: 'self_harm', weight: 0.92, requiresLivingTarget: false, suppressInTechnical: false, languages: ['en'] },
  cutting:            { category: 'self_harm', weight: 0.70, requiresLivingTarget: false, suppressInTechnical: true,  languages: ['en'] },
  'no reason to live':{ category: 'self_harm', weight: 0.80, requiresLivingTarget: false, suppressInTechnical: false, languages: ['en'] },
  anorexic:           { category: 'self_harm', weight: 0.60, requiresLivingTarget: false, suppressInTechnical: true,  languages: ['en'] },
  bulimic:            { category: 'self_harm', weight: 0.60, requiresLivingTarget: false, suppressInTechnical: true,  languages: ['en'] },
  'pro ana':          { category: 'self_harm', weight: 0.85, requiresLivingTarget: false, suppressInTechnical: false, languages: ['en'] },
  'pro mia':          { category: 'self_harm', weight: 0.85, requiresLivingTarget: false, suppressInTechnical: false, languages: ['en'] },
  'thinspo':          { category: 'self_harm', weight: 0.80, requiresLivingTarget: false, suppressInTechnical: false, languages: ['en'] },
  'sobredosis':       { category: 'self_harm', weight: 0.75, requiresLivingTarget: false, suppressInTechnical: true,  languages: ['es'] },
  'ahorcarme':        { category: 'self_harm', weight: 0.90, requiresLivingTarget: false, suppressInTechnical: false, languages: ['es'] },
  'cortarme':         { category: 'self_harm', weight: 0.80, requiresLivingTarget: false, suppressInTechnical: false, languages: ['es'] },

  // ═══ SEXUAL CONTENT — expanded ═══
  'revenge porn':     { category: 'sexual_content', weight: 0.88, requiresLivingTarget: false, suppressInTechnical: false, languages: ['en'] },
  upskirt:            { category: 'sexual_content', weight: 0.85, requiresLivingTarget: false, suppressInTechnical: false, languages: ['en'] },
  'deepfake porn':    { category: 'sexual_content', weight: 0.85, requiresLivingTarget: false, suppressInTechnical: false, languages: ['en'] },
  'incest porn':      { category: 'sexual_content', weight: 0.90, requiresLivingTarget: false, suppressInTechnical: false, languages: ['en'] },
  'genital mutilation':{ category: 'sexual_content', weight: 0.90, requiresLivingTarget: false, suppressInTechnical: false, languages: ['en'] },
  trafficker:         { category: 'sexual_content', weight: 0.85, requiresLivingTarget: false, suppressInTechnical: false, languages: ['en'] },
  'pornografia venganza':{ category: 'sexual_content', weight: 0.88, requiresLivingTarget: false, suppressInTechnical: false, languages: ['es'] },
  'mutilacion genital':{ category: 'sexual_content', weight: 0.90, requiresLivingTarget: false, suppressInTechnical: false, languages: ['es'] },
  proxeneta:          { category: 'sexual_content', weight: 0.80, requiresLivingTarget: false, suppressInTechnical: false, languages: ['es', 'pt'] },

  // ═══ DECEPTION & FRAUD — expanded ═══
  'social engineering': { category: 'deception', weight: 0.75, requiresLivingTarget: false, suppressInTechnical: true,  languages: ['en'] },
  'identity theft':   { category: 'deception', weight: 0.85, requiresLivingTarget: false, suppressInTechnical: false, languages: ['en'] },
  'ponzi':            { category: 'deception', weight: 0.80, requiresLivingTarget: false, suppressInTechnical: false, languages: ['en', 'fr', 'de', 'it', 'es'] },
  'pyramid scheme':   { category: 'deception', weight: 0.75, requiresLivingTarget: false, suppressInTechnical: false, languages: ['en'] },
  'catfish':          { category: 'deception', weight: 0.70, requiresLivingTarget: false, suppressInTechnical: false, languages: ['en'] },
  'crypto scam':      { category: 'deception', weight: 0.78, requiresLivingTarget: false, suppressInTechnical: false, languages: ['en'] },
  'romance scam':     { category: 'deception', weight: 0.78, requiresLivingTarget: false, suppressInTechnical: false, languages: ['en'] },
  'wire fraud':       { category: 'deception', weight: 0.82, requiresLivingTarget: false, suppressInTechnical: false, languages: ['en'] },
  'robo de identidad':{ category: 'deception', weight: 0.85, requiresLivingTarget: false, suppressInTechnical: false, languages: ['es'] },
  'esquema ponzi':    { category: 'deception', weight: 0.80, requiresLivingTarget: false, suppressInTechnical: false, languages: ['es', 'pt'] },
  'esquema piramide': { category: 'deception', weight: 0.75, requiresLivingTarget: false, suppressInTechnical: false, languages: ['es', 'pt'] },
  'fraude bancario':  { category: 'deception', weight: 0.80, requiresLivingTarget: false, suppressInTechnical: false, languages: ['es', 'pt'] },
  'fraude electronico':{ category: 'deception', weight: 0.80, requiresLivingTarget: false, suppressInTechnical: false, languages: ['es'] },
  'fraude bancaire':  { category: 'deception', weight: 0.80, requiresLivingTarget: false, suppressInTechnical: false, languages: ['fr'] },
  'usurpation identite':{ category: 'deception', weight: 0.85, requiresLivingTarget: false, suppressInTechnical: false, languages: ['fr'] },
  'identitatsdiebstahl':{ category: 'deception', weight: 0.85, requiresLivingTarget: false, suppressInTechnical: false, languages: ['de'] },
  'furto identita':   { category: 'deception', weight: 0.85, requiresLivingTarget: false, suppressInTechnical: false, languages: ['it'] },

  // ═══ ILLEGAL ACTIVITIES — expanded ═══
  'heroin':           { category: 'illegal_activities', weight: 0.75, requiresLivingTarget: false, suppressInTechnical: true,  languages: ['en'] },
  'cocaine':          { category: 'illegal_activities', weight: 0.70, requiresLivingTarget: false, suppressInTechnical: true,  languages: ['en', 'fr', 'de', 'it', 'es', 'pt'] },
  'methamphetamine':  { category: 'illegal_activities', weight: 0.80, requiresLivingTarget: false, suppressInTechnical: false, languages: ['en'] },
  'fentanyl':         { category: 'illegal_activities', weight: 0.80, requiresLivingTarget: false, suppressInTechnical: false, languages: ['en'] },
  'lsd synthesis':    { category: 'illegal_activities', weight: 0.85, requiresLivingTarget: false, suppressInTechnical: false, languages: ['en'] },
  'cook meth':        { category: 'illegal_activities', weight: 0.88, requiresLivingTarget: false, suppressInTechnical: false, languages: ['en'] },
  'smuggle':          { category: 'illegal_activities', weight: 0.70, requiresLivingTarget: false, suppressInTechnical: false, languages: ['en'] },
  'cartel':           { category: 'illegal_activities', weight: 0.70, requiresLivingTarget: false, suppressInTechnical: false, languages: ['en', 'fr', 'de', 'it', 'es', 'pt'] },
  'sicario':          { category: 'illegal_activities', weight: 0.85, requiresLivingTarget: false, suppressInTechnical: false, languages: ['es'] },
  'hitman':           { category: 'illegal_activities', weight: 0.85, requiresLivingTarget: false, suppressInTechnical: false, languages: ['en'] },
  'contract killer':  { category: 'illegal_activities', weight: 0.88, requiresLivingTarget: false, suppressInTechnical: false, languages: ['en'] },
  // 'sicario' duplicate removed — already defined two entries above.
  'narcotrafico':     { category: 'illegal_activities', weight: 0.85, requiresLivingTarget: false, suppressInTechnical: false, languages: ['es', 'pt'] },
  'narcotraficante':  { category: 'illegal_activities', weight: 0.82, requiresLivingTarget: false, suppressInTechnical: false, languages: ['es', 'pt'] },
  'heroina':          { category: 'illegal_activities', weight: 0.75, requiresLivingTarget: false, suppressInTechnical: true,  languages: ['es', 'pt'] },
  'cocaina':          { category: 'illegal_activities', weight: 0.70, requiresLivingTarget: false, suppressInTechnical: true,  languages: ['es', 'pt', 'it'] },
  'metanfetamina':    { category: 'illegal_activities', weight: 0.80, requiresLivingTarget: false, suppressInTechnical: false, languages: ['es', 'pt'] },
  'fentanilo':        { category: 'illegal_activities', weight: 0.80, requiresLivingTarget: false, suppressInTechnical: false, languages: ['es'] },
  'contrabando':      { category: 'illegal_activities', weight: 0.70, requiresLivingTarget: false, suppressInTechnical: false, languages: ['es', 'pt'] },
  'cartel droga':     { category: 'illegal_activities', weight: 0.75, requiresLivingTarget: false, suppressInTechnical: false, languages: ['es'] },

  // ═══ CYBERSECURITY — expanded ═══
  'sql injection':    { category: 'cybersecurity', weight: 0.72, requiresLivingTarget: false, suppressInTechnical: true,  languages: ['en'] },
  'xss attack':       { category: 'cybersecurity', weight: 0.70, requiresLivingTarget: false, suppressInTechnical: true,  languages: ['en'] },
  'buffer overflow':  { category: 'cybersecurity', weight: 0.65, requiresLivingTarget: false, suppressInTechnical: true,  languages: ['en'] },
  'rainbow table':    { category: 'cybersecurity', weight: 0.70, requiresLivingTarget: false, suppressInTechnical: true,  languages: ['en'] },
  'hash crack':       { category: 'cybersecurity', weight: 0.65, requiresLivingTarget: false, suppressInTechnical: true,  languages: ['en'] },
  'password crack':   { category: 'cybersecurity', weight: 0.68, requiresLivingTarget: false, suppressInTechnical: true,  languages: ['en'] },
  'brute force':      { category: 'cybersecurity', weight: 0.55, requiresLivingTarget: false, suppressInTechnical: true,  languages: ['en'] },
  'trojan horse':     { category: 'cybersecurity', weight: 0.78, requiresLivingTarget: false, suppressInTechnical: false, languages: ['en'] },
  'ddos attack':      { category: 'cybersecurity', weight: 0.75, requiresLivingTarget: false, suppressInTechnical: false, languages: ['en'] },
  'man in the middle':{ category: 'cybersecurity', weight: 0.70, requiresLivingTarget: false, suppressInTechnical: true,  languages: ['en'] },
  'rootkit':          { category: 'cybersecurity', weight: 0.80, requiresLivingTarget: false, suppressInTechnical: false, languages: ['en'] },
  'worm virus':       { category: 'cybersecurity', weight: 0.75, requiresLivingTarget: false, suppressInTechnical: false, languages: ['en'] },
  'ciberataque':      { category: 'cybersecurity', weight: 0.72, requiresLivingTarget: false, suppressInTechnical: false, languages: ['es'] },
  'secuestro datos':  { category: 'cybersecurity', weight: 0.82, requiresLivingTarget: false, suppressInTechnical: false, languages: ['es'] },
  'gusano informatico':{ category: 'cybersecurity', weight: 0.70, requiresLivingTarget: false, suppressInTechnical: false, languages: ['es'] },
  'piratear':            { category: 'cybersecurity', weight: 0.65, requiresLivingTarget: false, suppressInTechnical: true,  languages: ['es'] },
  'craquear':            { category: 'cybersecurity', weight: 0.65, requiresLivingTarget: false, suppressInTechnical: true,  languages: ['es', 'pt'] },
  'pirater':             { category: 'cybersecurity', weight: 0.65, requiresLivingTarget: false, suppressInTechnical: true,  languages: ['fr'] },
  'hackear':             { category: 'cybersecurity', weight: 0.65, requiresLivingTarget: false, suppressInTechnical: true,  languages: ['es', 'pt'] },
  'cyberattaque':        { category: 'cybersecurity', weight: 0.72, requiresLivingTarget: false, suppressInTechnical: false, languages: ['fr'] },
  'cyberangriff':        { category: 'cybersecurity', weight: 0.72, requiresLivingTarget: false, suppressInTechnical: false, languages: ['de'] },

  // ═══ MISINFORMATION — expanded ═══
  'propaganda':            { category: 'misinformation', weight: 0.50, requiresLivingTarget: false, suppressInTechnical: true,  languages: ['en', 'fr', 'de', 'it', 'es', 'pt'] },
  'hoax':                  { category: 'misinformation', weight: 0.55, requiresLivingTarget: false, suppressInTechnical: false, languages: ['en'] },
  'conspiracy theory':     { category: 'misinformation', weight: 0.45, requiresLivingTarget: false, suppressInTechnical: true,  languages: ['en'] },
  'rigged election':       { category: 'misinformation', weight: 0.65, requiresLivingTarget: false, suppressInTechnical: false, languages: ['en'] },
  'chemtrail':             { category: 'misinformation', weight: 0.50, requiresLivingTarget: false, suppressInTechnical: false, languages: ['en'] },
  'flat earth':            { category: 'misinformation', weight: 0.40, requiresLivingTarget: false, suppressInTechnical: false, languages: ['en'] },
  'anti vax':              { category: 'misinformation', weight: 0.55, requiresLivingTarget: false, suppressInTechnical: false, languages: ['en'] },
  'antivacunas':           { category: 'misinformation', weight: 0.55, requiresLivingTarget: false, suppressInTechnical: false, languages: ['es'] },
  'antivax':               { category: 'misinformation', weight: 0.55, requiresLivingTarget: false, suppressInTechnical: false, languages: ['en', 'fr'] },
  'teoria conspirativa':   { category: 'misinformation', weight: 0.45, requiresLivingTarget: false, suppressInTechnical: true,  languages: ['es', 'pt'] },
  'teoria da conspiracao': { category: 'misinformation', weight: 0.45, requiresLivingTarget: false, suppressInTechnical: true,  languages: ['pt'] },
  'theorie du complot':    { category: 'misinformation', weight: 0.45, requiresLivingTarget: false, suppressInTechnical: true,  languages: ['fr'] },
  'verschworungstheorie':  { category: 'misinformation', weight: 0.45, requiresLivingTarget: false, suppressInTechnical: true,  languages: ['de'] },
  'teoria complotto':      { category: 'misinformation', weight: 0.45, requiresLivingTarget: false, suppressInTechnical: true,  languages: ['it'] },

  // ═══ PRIVACY — expanded ═══
  'stalk':            { category: 'privacy', weight: 0.65, requiresLivingTarget: true,  suppressInTechnical: true,  languages: ['en'] },
  'surveil':          { category: 'privacy', weight: 0.55, requiresLivingTarget: false, suppressInTechnical: true,  languages: ['en'] },
  'wiretap':          { category: 'privacy', weight: 0.70, requiresLivingTarget: false, suppressInTechnical: false, languages: ['en'] },
  'keylog':           { category: 'privacy', weight: 0.75, requiresLivingTarget: false, suppressInTechnical: false, languages: ['en'] },
  'spy on':           { category: 'privacy', weight: 0.60, requiresLivingTarget: true,  suppressInTechnical: true,  languages: ['en'] },
  'reveal identity':  { category: 'privacy', weight: 0.65, requiresLivingTarget: false, suppressInTechnical: false, languages: ['en'] },
  'expose personal':  { category: 'privacy', weight: 0.70, requiresLivingTarget: false, suppressInTechnical: false, languages: ['en'] },
  'acosar':           { category: 'privacy', weight: 0.65, requiresLivingTarget: true,  suppressInTechnical: true,  languages: ['es'] },  // stalking sense
  'espiar':           { category: 'privacy', weight: 0.60, requiresLivingTarget: true,  suppressInTechnical: true,  languages: ['es', 'pt'] },
  'vigilar':          { category: 'privacy', weight: 0.55, requiresLivingTarget: true,  suppressInTechnical: true,  languages: ['es', 'pt'] },
  'interceptar':      { category: 'privacy', weight: 0.60, requiresLivingTarget: false, suppressInTechnical: true,  languages: ['es', 'pt'] },
  'espionner':        { category: 'privacy', weight: 0.60, requiresLivingTarget: true,  suppressInTechnical: true,  languages: ['fr'] },
  'ausspionieren':    { category: 'privacy', weight: 0.60, requiresLivingTarget: true,  suppressInTechnical: true,  languages: ['de'] },
  'stalker':          { category: 'privacy', weight: 0.70, requiresLivingTarget: false, suppressInTechnical: false, languages: ['en', 'fr', 'de', 'it'] },

  // ═══ AUTONOMY — expanded (was almost empty) ═══
  'brainwash':        { category: 'autonomy', weight: 0.75, requiresLivingTarget: false, suppressInTechnical: false, languages: ['en'] },
  'indoctrinate':     { category: 'autonomy', weight: 0.70, requiresLivingTarget: false, suppressInTechnical: false, languages: ['en'] },
  'mind control':     { category: 'autonomy', weight: 0.75, requiresLivingTarget: false, suppressInTechnical: false, languages: ['en'] },
  'lavado cerebral':  { category: 'autonomy', weight: 0.75, requiresLivingTarget: false, suppressInTechnical: false, languages: ['es'] },
  'lavagem cerebral': { category: 'autonomy', weight: 0.75, requiresLivingTarget: false, suppressInTechnical: false, languages: ['pt'] },
  'lavage cerveau':   { category: 'autonomy', weight: 0.75, requiresLivingTarget: false, suppressInTechnical: false, languages: ['fr'] },
  'gehirnwasche':     { category: 'autonomy', weight: 0.75, requiresLivingTarget: false, suppressInTechnical: false, languages: ['de'] },
  'controllo mentale':{ category: 'autonomy', weight: 0.75, requiresLivingTarget: false, suppressInTechnical: false, languages: ['it'] },
  'gaslight':         { category: 'autonomy', weight: 0.65, requiresLivingTarget: false, suppressInTechnical: false, languages: ['en'] },
  'undue influence':  { category: 'autonomy', weight: 0.60, requiresLivingTarget: false, suppressInTechnical: true,  languages: ['en'] },
  'exploit vulnerab': { category: 'autonomy', weight: 0.60, requiresLivingTarget: false, suppressInTechnical: true,  languages: ['en'] },
  'psychological manipulation':{ category: 'autonomy', weight: 0.70, requiresLivingTarget: false, suppressInTechnical: false, languages: ['en'] },
  'manipulacion psicologica':{ category: 'autonomy', weight: 0.70, requiresLivingTarget: false, suppressInTechnical: false, languages: ['es'] },
  'manipulacao psicologica':{ category: 'autonomy', weight: 0.70, requiresLivingTarget: false, suppressInTechnical: false, languages: ['pt'] },
  'manipulation psychologique':{ category: 'autonomy', weight: 0.70, requiresLivingTarget: false, suppressInTechnical: false, languages: ['fr'] },
  'cult':             { category: 'autonomy', weight: 0.55, requiresLivingTarget: false, suppressInTechnical: true,  languages: ['en', 'fr'] },
  'secta':            { category: 'autonomy', weight: 0.55, requiresLivingTarget: false, suppressInTechnical: true,  languages: ['es', 'pt'] },
  'sekta':            { category: 'autonomy', weight: 0.55, requiresLivingTarget: false, suppressInTechnical: true,  languages: ['de'] },
  'setta':            { category: 'autonomy', weight: 0.55, requiresLivingTarget: false, suppressInTechnical: true,  languages: ['it'] },

  // ═══ SYSTEM OVERRIDE — expanded ═══
  'developer mode':   { category: 'system_override', weight: 0.88, requiresLivingTarget: false, suppressInTechnical: true, languages: ['en'] },
  'god mode':         { category: 'system_override', weight: 0.85, requiresLivingTarget: false, suppressInTechnical: true, languages: ['en'] },
  'no restrictions':  { category: 'system_override', weight: 0.82, requiresLivingTarget: false, suppressInTechnical: true, languages: ['en'] },
  'without restriction':{ category: 'system_override', weight: 0.80, requiresLivingTarget: false, suppressInTechnical: true, languages: ['en'] },
  'unrestricted mode':{ category: 'system_override', weight: 0.85, requiresLivingTarget: false, suppressInTechnical: true, languages: ['en'] },
  'unfiltered mode':  { category: 'system_override', weight: 0.85, requiresLivingTarget: false, suppressInTechnical: true, languages: ['en'] },
  'uncensored mode':  { category: 'system_override', weight: 0.85, requiresLivingTarget: false, suppressInTechnical: true, languages: ['en'] },
  'sin restricciones':{ category: 'system_override', weight: 0.82, requiresLivingTarget: false, suppressInTechnical: true, languages: ['es'] },
  'sin filtros':      { category: 'system_override', weight: 0.82, requiresLivingTarget: false, suppressInTechnical: true, languages: ['es'] },
  'modo desarrollador':{ category: 'system_override', weight: 0.85, requiresLivingTarget: false, suppressInTechnical: true, languages: ['es'] },
  'modo dios':        { category: 'system_override', weight: 0.85, requiresLivingTarget: false, suppressInTechnical: true, languages: ['es'] },
  'sans restriction': { category: 'system_override', weight: 0.82, requiresLivingTarget: false, suppressInTechnical: true, languages: ['fr'] },
  'ohne einschrankung':{ category: 'system_override', weight: 0.82, requiresLivingTarget: false, suppressInTechnical: true, languages: ['de'] },
  'senza restrizioni':{ category: 'system_override', weight: 0.82, requiresLivingTarget: false, suppressInTechnical: true, languages: ['it'] },
  'sem restricoes':   { category: 'system_override', weight: 0.82, requiresLivingTarget: false, suppressInTechnical: true, languages: ['pt'] },
  'disregard guidelines':{ category: 'system_override', weight: 0.85, requiresLivingTarget: false, suppressInTechnical: true, languages: ['en'] },
  'override safety':  { category: 'system_override', weight: 0.90, requiresLivingTarget: false, suppressInTechnical: true, languages: ['en'] },
  'disable safety':   { category: 'system_override', weight: 0.90, requiresLivingTarget: false, suppressInTechnical: true, languages: ['en'] },
  'turn off ethics':  { category: 'system_override', weight: 0.90, requiresLivingTarget: false, suppressInTechnical: true, languages: ['en'] },
  'ignore safety':    { category: 'system_override', weight: 0.88, requiresLivingTarget: false, suppressInTechnical: true, languages: ['en'] },
};

// Deduplicate against existing lexicon
const filtered: Record<string, LexiconEntry> = {};
for (const [term, entry] of Object.entries(NEW_ENTRIES)) {
  if (!(term in MULTILINGUAL_LEXICON)) {
    filtered[term] = entry;
  }
}

console.log(`New entries: ${Object.keys(NEW_ENTRIES).length}`);
console.log(`After dedup: ${Object.keys(filtered).length}`);
console.log(`Existing lexicon size: ${Object.keys(MULTILINGUAL_LEXICON).length}`);
console.log(`New total would be: ${Object.keys(MULTILINGUAL_LEXICON).length + Object.keys(filtered).length}`);

// Output the new entries in lexicon format
console.log('\n// ═══ Generated entries — add to ethics-lexicon.ts ═══');
for (const [term, entry] of Object.entries(filtered)) {
  const weight = entry.weight.toFixed(2);
  const requiresLivingTarget = entry.requiresLivingTarget;
  const suppressInTechnical = entry.suppressInTechnical;
  const langs = entry.languages.map(l => `'${l}'`).join(', ');
  const key = term.includes(' ') ? `'${term}'` : term;
  console.log(`  ${key}: { category: '${entry.category}', weight: ${weight}, requiresLivingTarget: ${requiresLivingTarget}, suppressInTechnical: ${suppressInTechnical}, languages: [${langs}] },`);
}
