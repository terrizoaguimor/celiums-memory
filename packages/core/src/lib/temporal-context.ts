// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Celiums Solutions LLC

/**
 * Temporal Context — Layer A of the circadian rework (#165).
 *
 * THE TRUSTWORTHY HALF. This computes the user's real elapsed-time /
 * session-gap context from SERVER-SIDE UTC timestamps only. It is immune
 * to VPNs, client clock spoofing, and timezone lies because the server
 * measures the interval — the client never reports it.
 *
 * It answers the questions Mario built the circadian for, example (1):
 *   "You told me last night it was late. The day changed. It's 8:34 AM.
 *    How long was the user gone? Is this a new day? Did they come back
 *    after a long absence?"
 *
 * Pure, deterministic, no DB, no network — fully unit-testable. The only
 * optional input that touches timezone is `tzOffsetMinutes` used SOLELY to
 * decide whether a *local* calendar day was crossed; when it's absent we
 * fall back to the UTC day and SAY SO via `dayBoundaryBasis` rather than
 * pretend we know the user's local day. Honest over cosmetic.
 *
 * Layer B (wall-clock phase / chronotype / wellness, which needs a
 * trustworthy timezone and is the VPN-sensitive part) is a separate
 * module — this one never guesses phase.
 *
 * @license Apache-2.0
 */

export type GapClass =
  | 'first-ever'      // no prior interaction on record
  | 'continuous'      // < 5 min — same active stretch
  | 'short-break'     // 5–45 min — stepped away briefly
  | 'extended-break'  // 45 min – 6 h — meal, meeting, errand
  | 'overnight'       // 6–24 h AND a calendar day was crossed — slept / next day
  | 'day-away'        // 6–24 h, no day crossed — long single-day absence
  | 'multi-day';      // ≥ 24 h — back after one or more full days

export interface TemporalContext {
  /** Seconds since the user's previous interaction. null on first-ever. */
  secondsSinceLast: number | null;
  /** Coarse semantic class of the gap (see GapClass). */
  gapClass: GapClass;
  /** Did a calendar day boundary fall between last interaction and now? */
  crossedDayBoundary: boolean;
  /** Whether crossedDayBoundary was computed in the user's LOCAL day
   *  (tz known) or fell back to the UTC day (tz unknown). The agent must
   *  not claim "it's a new day for you" on a 'utc' basis with confidence. */
  dayBoundaryBasis: 'local' | 'utc' | 'n/a';
  /** Whole calendar days crossed (0 if same day, 1 = "yesterday → today"). */
  daysCrossed: number;
  lastSeenIso: string | null;
  nowIso: string;
  /** Compact human string: "just now", "23m", "4h 12m", "2 days". */
  humanGap: string;
  /** True when the gap is long enough that the agent SHOULD acknowledge
   *  the absence / day change before continuing (overnight+ or ≥6h). */
  shouldAcknowledge: boolean;
}

const MIN = 60;
const HOUR = 3600;
const DAY = 86_400;

function humanize(sec: number): string {
  if (sec < 45) return 'just now';
  if (sec < HOUR) return `${Math.round(sec / MIN)}m`;
  if (sec < DAY) {
    const h = Math.floor(sec / HOUR);
    const m = Math.round((sec % HOUR) / MIN);
    return m > 0 ? `${h}h ${m}m` : `${h}h`;
  }
  const d = Math.floor(sec / DAY);
  const h = Math.round((sec % DAY) / HOUR);
  return h > 0 ? `${d}d ${h}h` : `${d} day${d === 1 ? '' : 's'}`;
}

/**
 * Count calendar-day boundaries between two instants, in a given tz offset
 * (minutes east of UTC). Pure arithmetic on epoch ms — no Date tz APIs, so
 * it's deterministic regardless of the server's local zone.
 */
function calendarDaysBetween(aMs: number, bMs: number, tzOffsetMinutes: number): number {
  const off = tzOffsetMinutes * 60_000;
  const dayA = Math.floor((aMs + off) / (DAY * 1000));
  const dayB = Math.floor((bMs + off) / (DAY * 1000));
  return Math.max(0, dayB - dayA);
}

export function computeTemporalContext(args: {
  prevLastInteraction: Date | null;
  now?: Date;
  /** Minutes east of UTC for the user's resolved local zone. Omit when
   *  unknown/low-confidence — boundary then falls back to UTC and is
   *  flagged accordingly. */
  tzOffsetMinutes?: number | null;
}): TemporalContext {
  const now = args.now ?? new Date();
  const nowIso = now.toISOString();
  const prev = args.prevLastInteraction;

  if (!prev || Number.isNaN(prev.getTime())) {
    return {
      secondsSinceLast: null,
      gapClass: 'first-ever',
      crossedDayBoundary: false,
      dayBoundaryBasis: 'n/a',
      daysCrossed: 0,
      lastSeenIso: null,
      nowIso,
      humanGap: 'first interaction',
      shouldAcknowledge: false,
    };
  }

  const secondsSinceLast = Math.max(0, (now.getTime() - prev.getTime()) / 1000);

  const hasTz = typeof args.tzOffsetMinutes === 'number' && Number.isFinite(args.tzOffsetMinutes);
  const basis: 'local' | 'utc' = hasTz ? 'local' : 'utc';
  const daysCrossed = calendarDaysBetween(
    prev.getTime(),
    now.getTime(),
    hasTz ? (args.tzOffsetMinutes as number) : 0,
  );
  const crossedDayBoundary = daysCrossed > 0;

  let gapClass: GapClass;
  if (secondsSinceLast < 5 * MIN) gapClass = 'continuous';
  else if (secondsSinceLast < 45 * MIN) gapClass = 'short-break';
  else if (secondsSinceLast < 6 * HOUR) gapClass = 'extended-break';
  else if (secondsSinceLast < DAY) gapClass = crossedDayBoundary ? 'overnight' : 'day-away';
  else gapClass = 'multi-day';

  const shouldAcknowledge =
    gapClass === 'overnight' || gapClass === 'multi-day' ||
    (secondsSinceLast >= 6 * HOUR);

  return {
    secondsSinceLast,
    gapClass,
    crossedDayBoundary,
    dayBoundaryBasis: basis,
    daysCrossed,
    lastSeenIso: prev.toISOString(),
    nowIso,
    humanGap: humanize(secondsSinceLast),
    shouldAcknowledge,
  };
}
