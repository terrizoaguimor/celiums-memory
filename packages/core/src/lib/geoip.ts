// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Celiums Solutions LLC

/**
 * GeoIP — server-side IP → timezone + VPN/datacenter signal (#165 Layer B).
 *
 * Self-hosted MaxMind GeoLite2 (free): the City DB gives `location.time_zone`
 * (an IANA string — no mapping table needed) and the ASN DB gives the
 * connecting network's organization. The user's IP NEVER leaves our infra
 * (zero-knowledge): the .mmdb files are mounted into the container and
 * looked up locally; we do not call an external geo service.
 *
 * VPN/datacenter detection here is a HEURISTIC over the ASN org (hosting
 * providers run most commercial VPN exit nodes). It is intentionally
 * behind a stable interface (`geoSignals`) so the precise paid
 * GeoIP2-Anonymous-IP DB can be slotted in later without touching callers.
 *
 * Safe-by-default: if `maxmind` isn't installed or the .mmdb files are
 * absent (in-memory mode, pre-deploy, local dev), every lookup returns
 * null and the resolver simply falls back to behavior/stored/UTC. It
 * NEVER throws into the request path.
 *
 * Env:
 *   CELIUMS_GEOIP_DIR  — dir holding GeoLite2-City.mmdb / GeoLite2-ASN.mmdb
 *                        (default /data/geoip). A CronJob refreshes them.
 *
 * @license Apache-2.0
 */

import { join } from 'node:path';

interface CityRecord { location?: { time_zone?: string }; country?: { iso_code?: string } }
interface AsnRecord { autonomous_system_number?: number; autonomous_system_organization?: string }
interface MmdbReader<T> { get(ip: string): T | null }

const GEOIP_DIR = process.env['CELIUMS_GEOIP_DIR'] ?? '/data/geoip';

// Known hosting / VPN / proxy network operators. A datacenter ASN is a
// strong "not a residential ISP" signal → likely VPN/proxy for an end
// user. Heuristic, free (GeoLite2-ASN), upgradeable to Anonymous-IP.
const VPN_DC_ORG_RE =
  /\b(ovh|digitalocean|digital ocean|m247|datacamp|leaseweb|hetzner|linode|akamai|amazon|aws|google (llc|cloud)|microsoft|azure|oracle|cloudflare|vultr|choopa|contabo|scaleway|nforce|gcore|g-core|psychz|quadranet|colocrossing|frantech|hostroyale|zenlayer|tencent|alibaba|ucloud|nordvpn|expressvpn|mullvad|surfshark|protonvpn|private internet access|pia|cyberghost|ipvanish|vpn|proxy|hosting|datacenter|data center|server|cloud)\b/i;

let _loaded = false;
let _city: MmdbReader<CityRecord> | null = null;
let _asn: MmdbReader<AsnRecord> | null = null;

/** Lazily open the MMDB readers once. Any failure → readers stay null
 *  and lookups degrade to null (never throws). */
async function ensureReaders(): Promise<void> {
  if (_loaded) return;
  _loaded = true;
  try {
    // Optional dependency: dynamic import so the module compiles/loads
    // even where `maxmind` or the .mmdb files are absent.
    const mod = (await import('maxmind').then(
      (m) => m as unknown as { open?: (p: string) => Promise<MmdbReader<unknown>> },
      (): null => null,
    ));
    if (!mod || typeof mod.open !== 'function') return;
    const open = mod.open;
    _city = (await open(join(GEOIP_DIR, 'GeoLite2-City.mmdb')).then(
      (r) => r as MmdbReader<CityRecord>,
      (): null => null,
    ));
    _asn = (await open(join(GEOIP_DIR, 'GeoLite2-ASN.mmdb')).then(
      (r) => r as MmdbReader<AsnRecord>,
      (): null => null,
    ));
  } catch {
    _city = null;
    _asn = null;
  }
}

function isPublicIp(ip: string): boolean {
  if (!ip) return false;
  if (ip === '127.0.0.1' || ip === '::1') return false;
  if (/^10\./.test(ip)) return false;
  if (/^192\.168\./.test(ip)) return false;
  if (/^172\.(1[6-9]|2\d|3[01])\./.test(ip)) return false;
  if (/^169\.254\./.test(ip)) return false;
  if (/^(fc|fd)/i.test(ip)) return false; // ULA
  return true;
}

export interface GeoSignals {
  /** IANA timezone from the IP's City record, or null. */
  ipIana: string | null;
  /** ISO-3166 alpha-2 country, or null. */
  countryIso: string | null;
  /** Heuristic: the connecting ASN looks like a hosting/VPN/proxy net. */
  vpnSuspected: boolean;
  /** The ASN org string, for audit/telemetry (not user-facing). */
  asnOrg: string | null;
}

const EMPTY: GeoSignals = { ipIana: null, countryIso: null, vpnSuspected: false, asnOrg: null };

/**
 * Resolve geo signals for a client IP. Always resolves (never rejects);
 * returns EMPTY when geo data is unavailable or the IP is private.
 */
export async function geoSignals(ip: string | null | undefined): Promise<GeoSignals> {
  const addr = (ip ?? '').trim();
  if (!isPublicIp(addr)) return EMPTY;
  await ensureReaders();
  if (!_city && !_asn) return EMPTY;
  try {
    const city = _city?.get(addr) ?? null;
    const asn = _asn?.get(addr) ?? null;
    const asnOrg = asn?.autonomous_system_organization ?? null;
    return {
      ipIana: city?.location?.time_zone ?? null,
      countryIso: city?.country?.iso_code ?? null,
      vpnSuspected: asnOrg ? VPN_DC_ORG_RE.test(asnOrg) : false,
      asnOrg,
    };
  } catch {
    return EMPTY;
  }
}

/** Test seam: inject fake readers (used by unit tests; no DB needed). */
export function __setReadersForTest(
  city: MmdbReader<CityRecord> | null,
  asn: MmdbReader<AsnRecord> | null,
): void {
  _loaded = true;
  _city = city;
  _asn = asn;
}
