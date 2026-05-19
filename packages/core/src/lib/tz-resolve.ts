// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Celiums Solutions LLC

/**
 * Timezone resolver — Layer B of the circadian rework (#165).
 *
 * THE VPN-SENSITIVE HALF. Wall-clock phase needs the user's REAL local
 * time, and the declared/client tz can be spoofed (VPN, manual clock,
 * travel). So this never trusts a single source: it ranks signals by
 * how forgeable they are, attaches a confidence, and flags VPN suspicion
 * so the agent never asserts "it's morning for you" on a lie.
 *
 * Signal precedence (most → least trustworthy for *intent*):
 *   1. browserGeo  — explicit geolocation permission in the Console
 *                     (real coordinates → IANA). Strongest.
 *   2. ip          — server-side MaxMind City lookup. Strong UNLESS the
 *                     IP is a datacenter/VPN (then confidence collapses).
 *   3. behavior    — learned from the user's real activity histogram
 *                     (server UTC). VPN-IMMUNE but slow to converge.
 *   4. stored      — last resolved value persisted on the profile.
 *   5. UTC         — last resort; confidence 0, never assert phase.
 *
 * DST is handled correctly: offsets are derived from the IANA name AT a
 * specific instant via Intl (Node 22 full-ICU), never frozen as a number.
 *
 * Pure + deterministic (no DB, no network). The MaxMind/IP plumbing lives
 * in lib/geoip.ts and feeds the `ip` signal into resolveTimezone().
 *
 * @license Apache-2.0
 */

export type TzSource = 'browserGeo' | 'ip' | 'behavior' | 'stored' | 'utc';

export interface TzSignals {
  /** IANA from explicit browser geolocation (Console only). */
  browserGeoIana?: string | null;
  /** IANA from server-side IP→MaxMind City lookup. */
  ipIana?: string | null;
  /** The IP looked like a datacenter/VPN/proxy — discount the ip signal. */
  ipVpnSuspected?: boolean;
  /** IANA inferred from the user's activity histogram (VPN-immune). */
  behaviorIana?: string | null;
  /** Previously resolved + persisted IANA. */
  storedIana?: string | null;
}

export interface ResolvedTz {
  tzIana: string;
  /** DST-correct minutes east of UTC AT `atInstant` (or now). */
  offsetMinutes: number;
  source: TzSource;
  /** 0..1 — how much the agent should trust phase-based reasoning. */
  confidence: number;
  /** True when the resolved tz is contradicted/forgeable (VPN). The
   *  agent must NOT assert local phase/wellness when this is set. */
  vpnSuspected: boolean;
}

/**
 * DST-correct UTC offset (minutes east of UTC) for an IANA zone at a
 * given instant. Uses Intl `longOffset` ("GMT-05:00", "GMT+02:00",
 * "GMT+05:30", "GMT") — Node 22 ships full ICU. Returns null for an
 * invalid/unknown zone (caller falls back).
 */
export function offsetMinutesFor(iana: string, atInstant: Date = new Date()): number | null {
  try {
    const parts = new Intl.DateTimeFormat('en-US', {
      timeZone: iana,
      timeZoneName: 'longOffset',
    }).formatToParts(atInstant);
    const tzName = parts.find((p) => p.type === 'timeZoneName')?.value ?? '';
    if (tzName === 'GMT' || tzName === 'UTC') return 0;
    const m = /GMT([+-])(\d{1,2})(?::(\d{2}))?/.exec(tzName);
    if (!m) return null;
    const sign = m[1] === '-' ? -1 : 1;
    const hours = Number(m[2]);
    const mins = m[3] ? Number(m[3]) : 0;
    return sign * (hours * 60 + mins);
  } catch {
    return null; // invalid IANA id
  }
}

function isValidIana(iana: string | null | undefined): iana is string {
  return !!iana && offsetMinutesFor(iana) !== null;
}

/**
 * Resolve the effective timezone from all available signals.
 *
 * Confidence model (capped at 1):
 *   browserGeo            → 0.95
 *   ip (not VPN)          → 0.80
 *   ip (VPN suspected)    → 0.25  (kept as a weak hint, flagged)
 *   behavior              → 0.70  (VPN-immune; trustworthy once converged)
 *   stored                → 0.50
 *   utc fallback          → 0.00
 *
 * When the IP is VPN-suspected we prefer behavior (if present) over the
 * IP, because behavior cannot be spoofed by a VPN. vpnSuspected is
 * propagated regardless so the caller can gate the UX / agent phrasing.
 */
export function resolveTimezone(signals: TzSignals, atInstant: Date = new Date()): ResolvedTz {
  const vpn = !!signals.ipVpnSuspected;
  const mk = (iana: string, source: TzSource, confidence: number): ResolvedTz => ({
    tzIana: iana,
    offsetMinutes: offsetMinutesFor(iana, atInstant) ?? 0,
    source,
    confidence,
    vpnSuspected: vpn,
  });

  if (isValidIana(signals.browserGeoIana)) {
    return mk(signals.browserGeoIana, 'browserGeo', 0.95);
  }
  // If the IP smells like a VPN, behavior (if we have it) beats the IP.
  if (vpn && isValidIana(signals.behaviorIana)) {
    return mk(signals.behaviorIana, 'behavior', 0.7);
  }
  if (isValidIana(signals.ipIana)) {
    return mk(signals.ipIana, 'ip', vpn ? 0.25 : 0.8);
  }
  if (isValidIana(signals.behaviorIana)) {
    return mk(signals.behaviorIana, 'behavior', 0.7);
  }
  if (isValidIana(signals.storedIana)) {
    return mk(signals.storedIana, 'stored', 0.5);
  }
  return {
    tzIana: 'UTC',
    offsetMinutes: 0,
    source: 'utc',
    confidence: 0,
    vpnSuspected: vpn,
  };
}
