// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Celiums Solutions LLC

/**
 * Activity rhythm — the VPN-IMMUNE timezone signal (#165 Layer B).
 *
 * A per-user 24-bucket histogram of interaction counts indexed by UTC
 * hour. It is filled server-side from real activity, so a VPN, a spoofed
 * client clock, or a lying tz string CANNOT move it — the only thing that
 * shifts the histogram is the user genuinely interacting at different
 * real-world times.
 *
 * Inference: humans have a daily ~7–9h low-activity trough (sleep). Find
 * the contiguous circular window of minimum activity → that trough's UTC
 * centre. A typical person's sleep centre is ~03:30 local. The offset
 * that maps the observed UTC trough centre onto ~03:30 local IS the
 * user's effective UTC offset — regardless of what their client claims.
 *
 * This is a coarse estimator (whole-ish hours, no DST — DST is irrelevant
 * for a behavioural prior) and slow to converge, by design: it is the
 * trustworthy floor under the fast-but-forgeable IP/geo signals. Abrupt
 * real changes (travel) are caught by the IP anomaly detector, not here.
 *
 * Pure + deterministic — no DB, no network, fully unit-testable. The SQL
 * that increments the histogram lives in store.ts next to last_interaction.
 *
 * @license Apache-2.0
 */

/** Expected local hour at the CENTRE of a human sleep trough. */
const EXPECTED_LOCAL_TROUGH_CENTRE = 3.5; // ~03:30 local
/** Trough width searched (hours of lowest activity ≈ sleep). */
const TROUGH_WIDTH = 8;
/** Minimum total interactions before the estimate is trustworthy at all. */
const MIN_SAMPLES = 12;

export interface ActivityRhythm {
  /** Inferred UTC offset in minutes, or null if not enough signal. */
  offsetMinutes: number | null;
  /** 0..1 — grows with sample volume AND trough/peak contrast. */
  confidence: number;
  /** UTC hour at the centre of the detected low-activity (sleep) window. */
  troughCentreUtc: number | null;
  samples: number;
}

function normalizeHist(hist: number[]): number[] {
  const h = new Array(24).fill(0);
  for (let i = 0; i < 24 && i < hist.length; i++) {
    const v = Number(hist[i]);
    h[i] = Number.isFinite(v) && v > 0 ? v : 0;
  }
  return h;
}

/**
 * Infer the user's effective UTC offset from their UTC activity
 * histogram. Returns offsetMinutes=null (confidence 0) until there is
 * enough signal — callers must treat low confidence as "don't assert".
 */
export function inferActivityRhythm(rawHist: number[] | null | undefined): ActivityRhythm {
  const empty: ActivityRhythm = {
    offsetMinutes: null, confidence: 0, troughCentreUtc: null, samples: 0,
  };
  if (!rawHist || rawHist.length === 0) return empty;
  const hist = normalizeHist(rawHist);
  const total = hist.reduce((s, v) => s + v, 0);
  if (total < MIN_SAMPLES) return { ...empty, samples: total };

  // Slide an 8h circular window, find the one with the LEAST activity
  // (the sleep trough). Tie-break: earliest start for determinism.
  let bestStart = 0;
  let bestSum = Infinity;
  for (let start = 0; start < 24; start++) {
    let sum = 0;
    for (let k = 0; k < TROUGH_WIDTH; k++) sum += hist[(start + k) % 24];
    if (sum < bestSum) { bestSum = sum; bestStart = start; }
  }
  const troughCentreUtc = (bestStart + TROUGH_WIDTH / 2) % 24;

  // Offset that puts the observed trough centre at the expected local
  // sleep centre. Normalised to (-720, 720] minutes.
  let offsetHours = EXPECTED_LOCAL_TROUGH_CENTRE - troughCentreUtc;
  while (offsetHours <= -12) offsetHours += 24;
  while (offsetHours > 12) offsetHours -= 24;
  const offsetMinutes = Math.round(offsetHours * 60);

  // Confidence is MULTIPLICATIVE: volume × trough/peak contrast. Both are
  // necessary — lots of data with NO daily trough (always-on bot, uniform
  // activity) carries zero tz information, so confidence must collapse to
  // ~0 regardless of sample count. Likewise a sharp trough on 5 data
  // points isn't trustworthy yet. Neither term can paper over the other.
  const troughAvg = bestSum / TROUGH_WIDTH;
  const meanPerHour = total / 24;
  const contrast = meanPerHour > 0 ? Math.max(0, 1 - troughAvg / meanPerHour) : 0;
  const volume = Math.min(1, total / 120);
  const confidence = Math.round(Math.min(1, volume * contrast) * 1000) / 1000;

  return { offsetMinutes, confidence, troughCentreUtc, samples: total };
}

/** Map an offset (minutes east of UTC) to a fixed POSIX `Etc/GMT±H` zone.
 *  Behaviour is a coarse prior with no DST, so a fixed zone is correct
 *  here. NOTE: POSIX `Etc/GMT` signs are INVERTED (Etc/GMT-5 == UTC+5). */
export function offsetToEtcZone(offsetMinutes: number): string {
  const h = Math.round(offsetMinutes / 60);
  if (h === 0) return 'UTC';
  // east of UTC (positive) → Etc/GMT-<h>
  return h > 0 ? `Etc/GMT-${h}` : `Etc/GMT+${Math.abs(h)}`;
}
