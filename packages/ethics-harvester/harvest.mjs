/**
 * Celiums Ethics Harvester v0.1 — Main Pipeline Script
 * 
 * Generates compliance knowledge modules using open-weight models.
 * Stack: deepseek-v4-pro → llama-4-maverick → deepseek-r1-distill-70b
 * 
 * Usage: INFERENCE_KEY=xxx node harvest.mjs
 */

const key = process.env.INFERENCE_KEY;
if (!key) { console.error('INFERENCE_KEY env var is required'); process.exit(1); }
const url = process.env.INFERENCE_URL || 'https://inference.do-ai.run/v1/chat/completions';
const CONCURRENCY = parseInt(process.env.CONCURRENCY || '3');
const BUDGET = parseFloat(process.env.BUDGET || '200');
const MIN_CURATOR_SCORE = parseFloat(process.env.MIN_CURATOR || '0.55');
const MIN_VERIFIER_SCORE = parseFloat(process.env.MIN_VERIFIER || '0.6');

let totalCost = 0, generated = 0, rejected = 0, errors = 0;
const startTime = Date.now();
const modules = [];

async function call(model, system, user, temp = 0.5) {
  const t0 = Date.now();
  const r = await fetch(url, {
    method: 'POST',
    headers: { 'Authorization': 'Bearer ' + key, 'Content-Type': 'application/json' },
    body: JSON.stringify({ model, messages: [{ role: 'system', content: system }, { role: 'user', content: user }], max_tokens: 2048, temperature: temp })
  });
  const d = await r.json();
  const elapsed = (Date.now() - t0) / 1000;
  const tokens = d.usage?.total_tokens || 1500;
  totalCost += (tokens / 1_000_000) * 0.15;
  return { content: d.choices?.[0]?.message?.content || '', elapsed };
}

const GEN_SYS = 'You are a legal compliance curator for an AI ethics engine. Generate a structured knowledge module. Output ONLY valid JSON. CRITICAL: Every harmful/illegal concept MUST include benign_counterparts — similar legitimate concepts that are NOT harmful (to prevent the ethics engine from false-positive on legitimate use). Include: concept, verdict (harmful|context_dependent|legitimate_with_exceptions), severity (critical|high|moderate|low), aliases (object with language keys, each an array of terms), explanation_en (2-3 paragraphs with real facts), legal_references (array of real statute names with articles/sections), jurisdictional_notes (how it varies by country), legitimate_exceptions (when it IS permitted), benign_counterparts (array of strings — similar but legitimate concepts), distinction_rules (clear criteria to distinguish harmful from benign).';

const CUR_SYS = 'You are a legal accuracy quality reviewer. Score the module on: legal accuracy (are statutes real?), completeness, clarity, benign counterpoints. Output ONLY: {"score": <0-100>, "feedback": "<issues found>"}';

const VER_SYS = 'You are a legal verification system. Verify legal references are REAL statutes. Check the verdict matches what the law says. Check benign counterparts would ACTUALLY be classified differently. Output ONLY: {"score": <0-100>, "verdict": "accurate|minor_issues|major_issues"}';

async function processTopic(topic) {
  const t0 = Date.now();
  console.log(`[${topic.id}] ${topic.concept}`);

  try {
    const gen = await call('deepseek-v4-pro', GEN_SYS,
      `Concept: ${topic.concept}\nCategory: ${topic.category}\nDescription: ${topic.description}\nLanguages: ${topic.languages.join(',')}\nLegal frameworks: ${topic.legalFrameworks.join(', ')}`
    );

    const json = gen.content.match(/\{[\s\S]*\}/);
    if (!json) { console.log('  REJECTED: No JSON'); rejected++; return; }
    let mod;
    try { mod = JSON.parse(json[0]); } catch(e) { console.log('  REJECTED: Parse error'); rejected++; return; }

    if (!mod.benign_counterparts?.length) { console.log('  REJECTED: No benign counterparts'); rejected++; return; }

    const cur = await call('llama-4-maverick', CUR_SYS,
      JSON.stringify({ module: mod, topic: topic.concept, expectedLanguages: topic.languages })
    );
    const cj = cur.content.match(/\{[\s\S]*\}/);
    const cScore = cj ? JSON.parse(cj[0]).score / 100 : 0;
    if (cScore < MIN_CURATOR_SCORE) { console.log(`  REJECTED: Curator ${(cScore*100).toFixed(0)}%`); rejected++; return; }

    const ver = await call('deepseek-r1-distill-llama-70b', VER_SYS,
      JSON.stringify({ concept: topic.concept, legalReferences: mod.legal_references, verdict: mod.verdict, benignCounterparts: mod.benign_counterparts })
    );
    const vj = ver.content.match(/\{[\s\S]*\}/);
    const vScore = vj ? JSON.parse(vj[0]).score / 100 : 0;
    if (vScore < MIN_VERIFIER_SCORE) { console.log(`  REJECTED: Verifier ${(vScore*100).toFixed(0)}%`); rejected++; return; }

    const elapsed = ((Date.now() - t0) / 1000).toFixed(1);
    console.log(`  ACCEPTED: c=${(cScore*100).toFixed(0)} v=${(vScore*100).toFixed(0)} benign=${mod.benign_counterparts.length} legal=${mod.legal_references.length} (${elapsed}s)`);
    modules.push(mod);
    generated++;

    if (totalCost > BUDGET) { console.log(`\nBUDGET EXCEEDED: $${totalCost.toFixed(2)}`); process.exit(0); }
  } catch(e) { console.log(`  ERROR: ${e.message}`); errors++; }
}

const TOPICS = [
  {id:'violence_001',category:'violence_harm',concept:'Assassination and targeted killings',description:'Contract killing, political assassination — legal status and exceptions for state actors',languages:['en','es','fr','de'],legalFrameworks:['ICC Rome Statute','Geneva Conventions','UN Charter Article 51']},
  {id:'violence_002',category:'violence_harm',concept:'Chemical and biological weapons',description:'Production, possession of nerve agents, mustard gas, ricin, anthrax — CWC and BWC',languages:['en','es','fr','de','ru'],legalFrameworks:['Chemical Weapons Convention','Biological Weapons Convention','US 18 USC 175']},
  {id:'violence_003',category:'violence_harm',concept:'Explosive devices manufacturing',description:'IED construction, pipe bombs, fertilizer bombs — criminal statutes worldwide',languages:['en','es','fr','de','pt'],legalFrameworks:['US 18 USC 842','UK Explosive Substances Act 1883','EU Directive 2014/28/EU']},
  {id:'violence_004',category:'violence_harm',concept:'Torture techniques and methods',description:'Physical and psychological torture methods, legal prohibitions under CAT',languages:['en','es','fr','de'],legalFrameworks:['UN Convention Against Torture','Geneva Conventions Common Article 3','US 18 USC 2340']},
  {id:'child_001',category:'child_safety',concept:'Child sexual abuse material (CSAM)',description:'Production, distribution, possession — legal framework and reporting obligations',languages:['en','es','fr','de','pt','ja'],legalFrameworks:['US 18 USC 2251-2260','EU Directive 2011/93/EU','Optional Protocol CRC']},
  {id:'child_002',category:'child_safety',concept:'Online child grooming',description:'Grooming tactics, legal definitions, platform responsibilities',languages:['en','es','fr','de'],legalFrameworks:['US 18 USC 2422','UK Sexual Offences Act 2003 s15','Lanzarote Convention']},
  {id:'fraud_001',category:'deception',concept:'Financial fraud schemes',description:'Ponzi schemes, pyramid schemes, investment fraud — detection and legal status',languages:['en','es','fr','de','pt'],legalFrameworks:['US Securities Act 1933','UK Fraud Act 2006','EU Market Abuse Regulation']},
  {id:'fraud_002',category:'deception',concept:'Identity theft and impersonation',description:'Methods, synthetic identity fraud, legal penalties, victim remediation',languages:['en','es','fr','de'],legalFrameworks:['US Identity Theft Act','UK Fraud Act 2006','GDPR Article 33']},
  {id:'fraud_003',category:'deception',concept:'Cryptocurrency and NFT scams',description:'Rug pulls, fake ICOs, wallet draining — regulatory status globally',languages:['en','es','fr','de','ko'],legalFrameworks:['US SEC enforcement','EU MiCA Regulation','FATF Travel Rule']},
  {id:'cyber_001',category:'cybersecurity',concept:'Malware development and distribution',description:'Creating, distributing ransomware, trojans, worms, spyware, botnets',languages:['en','es','fr','de','ru'],legalFrameworks:['US CFAA','UK Computer Misuse Act 1990','Budapest Convention on Cybercrime']},
  {id:'cyber_002',category:'cybersecurity',concept:'Exploit development and zero-days',description:'Developing exploits, zero-day markets, vulnerability disclosure ethics',languages:['en','es','fr','de'],legalFrameworks:['US CFAA','Wassenaar Arrangement','various national export controls']},
  {id:'cyber_003',category:'cybersecurity',concept:'DDoS attacks and network disruption',description:'Distributed denial of service, booter/stresser services, botnet rental',languages:['en','es','fr','de','ru'],legalFrameworks:['US CFAA','UK Computer Misuse Act 1990 s3','EU Directive 2013/40/EU']},
  {id:'cyber_005',category:'cybersecurity',concept:'Penetration testing vs hacking',description:'Legal distinctions between authorized pentesting, bug bounties, and criminal hacking',languages:['en','es','fr','de'],legalFrameworks:['US CFAA authorized access','UK Computer Misuse Act authorized access']},
  {id:'illegal_004',category:'illegal_activities',concept:'Counterfeit currency and documents',description:'Counterfeiting currency, passports, IDs — methods, detection, penalties',languages:['en','es','fr','de','pt'],legalFrameworks:['US 18 USC 471-514','International Convention 1929']},
  {id:'illegal_005',category:'illegal_activities',concept:'Wildlife trafficking and endangered species',description:'CITES regulations, illegal wildlife trade, penalties',languages:['en','es','fr','de','pt','zh'],legalFrameworks:['CITES','US Lacey Act','US Endangered Species Act']},
  {id:'privacy_001',category:'privacy',concept:'Doxxing and personal information exposure',description:'Publishing private information with malicious intent',languages:['en','es','fr','de','ja'],legalFrameworks:['US 18 USC 2261A','GDPR right to erasure']},
  {id:'selfharm_001',category:'self_harm',concept:'Suicide methods and instruction',description:'Providing specific instructions for suicide methods',languages:['en','es','fr','de','ja'],legalFrameworks:['various assisted suicide laws','WHO suicide prevention guidelines']},
  {id:'decep_001',category:'deception',concept:'Romance scams and catfishing',description:'Online romance fraud, psychological manipulation, financial exploitation',languages:['en','es','fr','de','pt'],legalFrameworks:['US wire fraud statute','UK Fraud Act 2006']},
  {id:'illegal_006',category:'illegal_activities',concept:'Arms trafficking and weapons trade',description:'Illegal firearms, 3D-printed guns, ghost guns',languages:['en','es','fr','de'],legalFrameworks:['UN Arms Trade Treaty','US Arms Export Control Act']},
  {id:'illegal_002',category:'illegal_activities',concept:'Money laundering',description:'Shell companies, trade-based laundering, crypto mixing',languages:['en','es','fr','de','pt'],legalFrameworks:['US Bank Secrecy Act','EU 5AMLD','FATF 40 Recommendations']},
  {id:'hate_001',category:'hate_speech',concept:'Incitement to racial hatred',description:'Legal definitions, criminal thresholds vs free speech',languages:['en','es','fr','de'],legalFrameworks:['ICERD Article 4','ECHR Article 10']},
  {id:'hate_005',category:'hate_speech',concept:'White supremacy and extremist ideologies',description:'Neo-Nazi, white nationalist, accelerationist ideologies',languages:['en','es','fr','de'],legalFrameworks:['German StGB 86a','EU Terrorist Content Online Regulation']},
  {id:'misinfo_001',category:'misinformation',concept:'Health misinformation',description:'Vaccine misinfo, fake cures, COVID-19 misinfo',languages:['en','es','fr','de','pt'],legalFrameworks:['WHO Infodemic Management','EU DSA Code of Practice']},
  {id:'misinfo_003',category:'misinformation',concept:'Conspiracy theories with real-world harm',description:'QAnon, Pizzagate, 5G conspiracies',languages:['en','es','fr','de'],legalFrameworks:['various incitement statutes','platform deplatforming policies']},
  {id:'autonomy_001',category:'autonomy',concept:'Psychological manipulation and coercive control',description:'Gaslighting, coercive control in relationships',languages:['en','es','fr','de','pt'],legalFrameworks:['UK Serious Crime Act 2015 s76','Ireland Domestic Violence Act 2018']},
  {id:'override_001',category:'system_override',concept:'AI jailbreak and safety bypass techniques',description:'Prompt injection, DAN-style jailbreaks, token smuggling',languages:['en','es','fr','de'],legalFrameworks:['EU AI Act Article 5','US AI Executive Order 2023']},
  {id:'illegal_001',category:'illegal_activities',concept:'Drug manufacturing and trafficking',description:'Synthesis of controlled substances, trafficking routes',languages:['en','es','fr','de','pt'],legalFrameworks:['UN Single Convention 1961','US Controlled Substances Act']},
  {id:'sexual_001',category:'sexual_content',concept:'Non-consensual intimate imagery',description:'Revenge porn, deepfake pornography',languages:['en','es','fr','de','ko'],legalFrameworks:['US 15 USC 6851','UK Criminal Justice and Courts Act 2015 s33']},
  {id:'privacy_003',category:'privacy',concept:'Data breaches and unauthorized access',description:'Hacking accounts, data exfiltration, selling stolen data',languages:['en','es','fr','de'],legalFrameworks:['US CFAA','UK Computer Misuse Act 1990','GDPR Articles 32-34']},
  {id:'illegal_003',category:'illegal_activities',concept:'Human trafficking and smuggling',description:'Forced labor, sex trafficking, organ trafficking',languages:['en','es','fr','de','pt','th'],legalFrameworks:['Palermo Protocol','US Trafficking Victims Protection Act']},
];

async function main() {
  console.log(`ETHICS HARVESTER — ${TOPICS.length} topics, ${CONCURRENCY} concurrent\n`);
  const queue = [...TOPICS];

  while (queue.length > 0) {
    const batch = queue.splice(0, CONCURRENCY);
    await Promise.all(batch.map(processTopic));
    if (queue.length > 0) await new Promise(r => setTimeout(r, 1000));
    const min = ((Date.now() - startTime) / 60000).toFixed(1);
    console.log(`[PROGRESS] ${generated}/${TOPICS.length} done, $${totalCost.toFixed(2)}, ${min}min\n`);
    if (totalCost >= BUDGET) { console.log('BUDGET REACHED'); break; }
  }

  const min = ((Date.now() - startTime) / 60000).toFixed(1);
  console.log(`\nDONE: ${generated} modules in ${min}min, $${totalCost.toFixed(2)}`);
  console.log(`Rejected: ${rejected}, Errors: ${errors}`);

  const fs = await import('fs');
  fs.writeFileSync('/opt/celiums-ethics-harvester/logs/modules.json', JSON.stringify(modules, null, 2));
  fs.writeFileSync('/opt/celiums-ethics-harvester/logs/stats.json', JSON.stringify({ generated, rejected, errors, totalCost, elapsedMin: min }, null, 2));
  console.log('Saved to /opt/celiums-ethics-harvester/logs/');
}

main().catch(e => { console.error('FATAL:', e); process.exit(1); });
