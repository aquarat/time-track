/**
 * Timezone-aware calendar maths.
 *
 * Everything is persisted as a UTC epoch millisecond instant. Calendar concepts
 * — "today", "this week", "the 26th of the month" — only exist relative to a
 * timezone, so every function that turns an instant into a calendar position (or
 * back) takes an IANA zone id explicitly. There is no implicit local time.
 */

export interface ZonedParts {
  year: number;
  /** 1-based. */
  month: number;
  day: number;
  hour: number;
  minute: number;
  second: number;
}

const partsFormatterCache = new Map<string, Intl.DateTimeFormat>();

function partsFormatter(tz: string): Intl.DateTimeFormat {
  let fmt = partsFormatterCache.get(tz);
  if (!fmt) {
    fmt = new Intl.DateTimeFormat('en-US', {
      timeZone: tz,
      hourCycle: 'h23',
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
      hour: '2-digit',
      minute: '2-digit',
      second: '2-digit',
    });
    partsFormatterCache.set(tz, fmt);
  }
  return fmt;
}

/** Wall-clock parts of an instant, as observed in `tz`. */
export function toZonedParts(utcMs: number, tz: string): ZonedParts {
  const parts = partsFormatter(tz).formatToParts(new Date(utcMs));
  const get = (type: Intl.DateTimeFormatPartTypes): number => {
    const found = parts.find((p) => p.type === type);
    return found ? Number(found.value) : 0;
  };
  return {
    year: get('year'),
    month: get('month'),
    day: get('day'),
    hour: get('hour'),
    minute: get('minute'),
    second: get('second'),
  };
}

/** Offset of `tz` from UTC at a given instant, in milliseconds (east positive). */
function offsetMsAt(utcMs: number, tz: string): number {
  const p = toZonedParts(utcMs, tz);
  const asIfUtc = Date.UTC(p.year, p.month - 1, p.day, p.hour, p.minute, p.second);
  // Drop sub-second precision from the comparison so the offset lands on a whole second.
  return asIfUtc - (utcMs - (utcMs % 1000));
}

/**
 * Turn a wall-clock time in `tz` into a UTC instant.
 *
 * Solved by iteration because the offset depends on the instant we are trying to
 * find. Two passes converge for every real zone: the first pass lands within an
 * hour of the answer, the second corrects for a DST boundary crossed in between.
 * Times inside a spring-forward gap resolve to the instant just after the jump.
 */
export function fromZonedParts(
  year: number,
  month: number,
  day: number,
  hour: number,
  minute: number,
  second: number,
  tz: string,
): number {
  const naive = Date.UTC(year, month - 1, day, hour, minute, second);
  let utc = naive - offsetMsAt(naive, tz);
  utc = naive - offsetMsAt(utc, tz);
  return utc;
}

export function daysInMonth(year: number, month: number): number {
  return new Date(Date.UTC(year, month, 0)).getUTCDate();
}

/** Advance a (year, month) pair by `delta` months, keeping month 1-based. */
export function addMonths(year: number, month: number, delta: number): { year: number; month: number } {
  const zeroBased = year * 12 + (month - 1) + delta;
  return { year: Math.floor(zeroBased / 12), month: (zeroBased % 12) + 1 };
}

/** Midnight starting the day that `utcMs` falls on, in `tz`. */
export function startOfDay(utcMs: number, tz: string): number {
  const p = toZonedParts(utcMs, tz);
  return fromZonedParts(p.year, p.month, p.day, 0, 0, 0, tz);
}

/** Midnight starting the Monday of the week that `utcMs` falls in, in `tz`. */
export function startOfWeek(utcMs: number, tz: string): number {
  const dayStart = startOfDay(utcMs, tz);
  const p = toZonedParts(dayStart, tz);
  // getUTCDay on a UTC-normalised copy of the wall-clock date gives the weekday.
  const weekday = new Date(Date.UTC(p.year, p.month - 1, p.day)).getUTCDay();
  const backToMonday = (weekday + 6) % 7;
  return fromZonedParts(p.year, p.month, p.day - backToMonday, 0, 0, 0, tz);
}

/** Midnight starting the first day of the month that `utcMs` falls in, in `tz`. */
export function startOfMonth(utcMs: number, tz: string): number {
  const p = toZonedParts(utcMs, tz);
  return fromZonedParts(p.year, p.month, 1, 0, 0, 0, tz);
}

export function addDaysUtc(utcMs: number, days: number, tz: string): number {
  const p = toZonedParts(utcMs, tz);
  return fromZonedParts(p.year, p.month, p.day + days, p.hour, p.minute, p.second, tz);
}

/** "YYYY-MM-DD" for the calendar day that `utcMs` falls on in `tz`. */
export function dateKey(utcMs: number, tz: string): string {
  const p = toZonedParts(utcMs, tz);
  return `${p.year}-${pad2(p.month)}-${pad2(p.day)}`;
}

export function pad2(n: number): string {
  return String(n).padStart(2, '0');
}

export const MONTH_NAMES = [
  'January', 'February', 'March', 'April', 'May', 'June',
  'July', 'August', 'September', 'October', 'November', 'December',
];

export function monthLabel(year: number, month: number): string {
  return `${MONTH_NAMES[month - 1]} ${year}`;
}

/** Parse a "YYYY-MM" string, falling back to January 1970 when malformed. */
export function parseMonthKey(key: string): { year: number; month: number } {
  const m = /^(\d{4})-(\d{2})$/.exec(key.trim());
  if (!m) return { year: 1970, month: 1 };
  const month = Number(m[2]);
  return { year: Number(m[1]), month: month >= 1 && month <= 12 ? month : 1 };
}

export function monthKey(year: number, month: number): string {
  return `${year}-${pad2(month)}`;
}

/**
 * Duration formatted as H:MM:SS, the shape a running timer wants.
 */
export function formatDuration(seconds: number): string {
  const s = Math.max(0, Math.floor(seconds));
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  return `${h}:${pad2(m)}:${pad2(s % 60)}`;
}

/** Duration formatted as "3h 42m", the shape a summary wants. */
export function formatCompact(seconds: number): string {
  const s = Math.max(0, Math.floor(seconds));
  const h = Math.floor(s / 3600);
  const m = Math.round((s % 3600) / 60);
  if (h === 0 && m === 0) return '0m';
  if (h === 0) return `${m}m`;
  return m === 0 ? `${h}h` : `${h}h ${m}m`;
}

/** Wall-clock "HH:MM" of an instant in `tz`. */
export function formatClock(utcMs: number, tz: string): string {
  const p = toZonedParts(utcMs, tz);
  return `${pad2(p.hour)}:${pad2(p.minute)}`;
}

/**
 * Snap an instant to the nearest `minutes` boundary of the wall clock in `tz`.
 *
 * Done through the zone's calendar fields rather than by rounding the epoch
 * value. At a 15-minute step the two happen to agree for every current zone,
 * since all live UTC offsets are multiples of 15 minutes — but that is a
 * coincidence not worth relying on: it already fails at coarser steps (in a
 * +05:45 zone the local hour is quarter past in UTC), and measuring from the
 * day's midnight instead would drift on a day containing a DST change.
 */
export function snapToMinutes(utcMs: number, tz: string, minutes: number): number {
  const step = Math.max(1, Math.round(minutes));
  const p = toZonedParts(utcMs, tz);
  const minuteOfDay = p.hour * 60 + p.minute + p.second / 60;
  const snapped = Math.round(minuteOfDay / step) * step;
  // An hour of 24 is normalised into the next day by Date.UTC inside fromZonedParts.
  return fromZonedParts(p.year, p.month, p.day, Math.floor(snapped / 60), snapped % 60, 0, tz);
}

/** "26 January 2026" — the calendar date of an instant in `tz`. */
export function formatLongDate(utcMs: number, tz: string): string {
  const p = toZonedParts(utcMs, tz);
  return `${p.day} ${MONTH_NAMES[p.month - 1]} ${p.year}`;
}
