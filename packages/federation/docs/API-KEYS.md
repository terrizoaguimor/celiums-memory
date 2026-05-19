# celiums-federation — ¿Necesitamos API keys? (respuesta para Mario)

**TL;DR: NO se necesita ninguna key para que funcione. 3 keys gratis
opcionales son recomendadas SOLO para throughput en producción (evitar
429 bajo carga concurrente). Cero dependencia funcional. Una decisión
pendiente: CORE.**

## Matriz por conector (los 10 verificados)

| Conector | ¿Key para funcionar? | Key opcional | Qué cambia con la key |
|---|---|---|---|
| clinicaltrials | ❌ No | — | — |
| arxiv | ❌ No | — | — |
| wikidata | ❌ No | — | — |
| wikipedia | ❌ No | — | — |
| crossref | ❌ No | — | `mailto=` ya hardcodeado (cortesía, NO key) → pool "polite" más estable |
| openalex | ❌ No | — | `mailto=` ya hardcodeado → pool "polite" |
| europepmc | ❌ No | — | — |
| pubmed | ❌ No | `NCBI_API_KEY` (gratis) | rate per-IP 3→10 req/s |
| openfda | ❌ No | `FDA_API_KEY` (gratis) | sube límite diario |
| semanticscholar | ❌ No | `S2_API_KEY` (gratis) | sale del pool compartido (es el más lento ~1s y el más propenso a 429 bajo concurrencia) |

**7/10 jamás necesitan key. 3/10 tienen key gratis opcional que solo
sube rate limits — ningún resultado distinto, solo más throughput.**

El código ya soporta las 3 (env opcional, degrada a keyless si no está):
`packages/federation/src/connectors/{pubmed,openfda,semanticscholar}.ts`.

## Recomendación

- **Para arrancar / dev / Mario único usuario**: **NINGUNA key**. Funciona
  los 10 keyless. No bloquea nada.
- **Para producción pública** (cuando F4 esté live y haya concurrencia):
  sacar las 3 gratis (15 min de registro, sin tarjeta):
  - Semantic Scholar: https://www.semanticscholar.org/product/api → form gratis
  - NCBI/PubMed: https://www.ncbi.nlm.nih.gov/account/ → Settings → API Key
  - OpenFDA: https://open.fda.gov/apis/authentication/ → form gratis
  Inyectar como env del deployment `celiums-federation` (Secret), igual
  patrón que tier-classifier. **Todas gratis, todas opcionales, todas
  solo-rate-limit.** Decisión #2 del plan ya las aprobó (S2 al menos).

## Decisión PENDIENTE para Mario: CORE

La decisión #2 del plan dice literal *"sacar keys free SemanticScholar +
**CORE**"*. Honesto: **CORE NO está entre los 10 conectores verificados**
(los 10 son clinicaltrials/pubmed/arxiv/wikidata/crossref/wikipedia/
openfda/openalex/europepmc/semanticscholar). CORE sería un conector #11.

A diferencia de los otros, **CORE SÍ exige key obligatoria** (su API
requiere registro, no tiene tier keyless). Es la única fuente que
introduciría una dependencia de key dura.

**Mi recomendación: diferir CORE.** Los 10 ya dan cobertura científica
fuerte (OpenAlex 250M works + Crossref 150M DOIs + arXiv + S2 + EuropePMC).
CORE (~250M papers) solapa mucho con OpenAlex. No vale meter una
dependencia de key obligatoria en F2 por marginal recall. Revisitar en F3
solo si la telemetría muestra un gap real de cobertura. **Necesito tu OK
para diferir CORE, o decime que lo agregue como #11 con su key.**

## Cómo se inyectan (cuando toque)

Igual que `celiums-tier-classifier`: Secret en el ns del servicio,
`envFrom` o vars sueltas. F1 ya lee `process.env.{S2_API_KEY,
NCBI_API_KEY,FDA_API_KEY}` — no hay cambio de código, solo el Secret.
Sin Secret → keyless automático (degradación limpia, ya probada).
