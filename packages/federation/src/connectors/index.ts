// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Celiums Solutions LLC

/**
 * Connector registry — the 10 verified public APIs (latencies measured
 * from the cluster VPC, recorded for the F2 router's timeout budgeting):
 *
 *   clinicaltrials   48ms   medical
 *   pubmed          124ms   medical
 *   arxiv           211ms   scientific
 *   wikidata        227ms   general
 *   crossref        272ms   scientific   (150M DOIs — dedup anchor)
 *   wikipedia       334ms   general
 *   openfda         424ms   medical
 *   openalex        438ms   scientific   (250M works)
 *   europepmc       662ms   medical+scientific (carries abstracts)
 *   semanticscholar 1005ms  scientific   (slowest; S2_API_KEY recommended)
 *
 * F2 will map query domain → connector subset. F1 exposes the full list
 * plus a domain filter so the debug fan-out endpoint is already useful.
 */

import type { Connector, Domain } from '../types.js';
import { clinicaltrials } from './clinicaltrials.js';
import { pubmed } from './pubmed.js';
import { arxiv } from './arxiv.js';
import { wikidata } from './wikidata.js';
import { crossref } from './crossref.js';
import { wikipedia } from './wikipedia.js';
import { openfda } from './openfda.js';
import { openalex } from './openalex.js';
import { europepmc } from './europepmc.js';
import { semanticscholar } from './semanticscholar.js';

export const CONNECTORS: Connector[] = [
  clinicaltrials,
  pubmed,
  arxiv,
  wikidata,
  crossref,
  wikipedia,
  openfda,
  openalex,
  europepmc,
  semanticscholar,
];

export const CONNECTOR_BY_ID: Record<string, Connector> = Object.fromEntries(
  CONNECTORS.map((c) => [c.id, c]),
);

export function connectorsForDomain(domain: Domain): Connector[] {
  return CONNECTORS.filter((c) => c.domains.includes(domain));
}
