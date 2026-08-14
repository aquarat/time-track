import { describe, expect, test } from 'bun:test';
import type { Entry, Settings } from '../src/shared/types';
import { buildInvoice, findPeriod, listPeriods, periodAt, roundSeconds } from '../src/shared/invoice';
import { fromZonedParts, startOfWeek, toZonedParts } from '../src/shared/time';

const SAST = 'Africa/Johannesburg'; // UTC+2, no DST
const LONDON = 'Europe/London'; // has DST

const base: Settings = {
  timezone: SAST,
  invoicePeriodDay: 26,
  invoicePrefix: 'TDC-TT-G2A-',
  invoiceStartSeq: 1,
  invoiceStartMonth: '2026-01',
  periodLabelMode: 'start',
  logoDataUrl: '',
  companyName: 'Me',
  companyAddress: '',
  clientName: 'Client',
  clientAddress: '',
  currency: 'ZAR',
  hourlyRate: 100,
  invoiceFooter: '',
  roundingMode: 'exact',
  roundingIncrement: 15,
  updatedAt: 0,
};

const at = (y: number, m: number, d: number, h = 0, mi = 0, tz = SAST) =>
  fromZonedParts(y, m, d, h, mi, 0, tz);

const entry = (id: string, description: string, start: number, end: number | null): Entry => ({
  id,
  description,
  startedAt: start,
  endedAt: end,
  createdAt: start,
  updatedAt: start,
});

describe('period boundaries', () => {
  test('a period runs from the cut-over day to the same day next month', () => {
    const p = periodAt(base, 0);
    expect(p.key).toBe('2026-01');
    expect(p.label).toBe('January 2026');
    expect(p.startUtc).toBe(at(2026, 1, 26));
    expect(p.endUtc).toBe(at(2026, 2, 26));
    expect(p.invoiceNumber).toBe('TDC-TT-G2A-1');
  });

  test('boundaries are midnight in the configured zone, not UTC', () => {
    // 26 Jan 00:00 SAST is 25 Jan 22:00 UTC.
    const p = periodAt(base, 0);
    expect(new Date(p.startUtc).toISOString()).toBe('2026-01-25T22:00:00.000Z');
  });

  test('sequence increments monthly from the configured start', () => {
    const s = { ...base, invoiceStartSeq: 6 };
    expect(periodAt(s, 0).invoiceNumber).toBe('TDC-TT-G2A-6');
    expect(periodAt(s, 1).invoiceNumber).toBe('TDC-TT-G2A-7');
    expect(periodAt(s, 7).invoiceNumber).toBe('TDC-TT-G2A-13');
  });

  test('consecutive periods abut exactly, leaving no untracked seam', () => {
    for (let i = 0; i < 36; i++) {
      expect(periodAt(base, i).endUtc).toBe(periodAt(base, i + 1).startUtc);
    }
  });

  test('a cut-over day past the end of a short month clamps to the last day', () => {
    const s = { ...base, invoicePeriodDay: 31, invoiceStartMonth: '2026-01' };
    expect(periodAt(s, 0).startUtc).toBe(at(2026, 1, 31));
    expect(periodAt(s, 0).endUtc).toBe(at(2026, 2, 28)); // February clamps
    expect(periodAt(s, 1).startUtc).toBe(at(2026, 2, 28));
    expect(periodAt(s, 1).endUtc).toBe(at(2026, 3, 31));
  });

  test("'end' labelling shifts the name back a month without moving the boundaries", () => {
    const s = { ...base, periodLabelMode: 'end' as const };
    const p = periodAt(s, 0);
    expect(p.label).toBe('January 2026');
    expect(p.startUtc).toBe(at(2025, 12, 26));
    expect(p.endUtc).toBe(at(2026, 1, 26));
  });

  test('periods survive a DST transition in a zone that observes it', () => {
    // UK clocks go forward on 29 March 2026. The 26 Mar → 26 Apr period spans it.
    const s = { ...base, timezone: LONDON, invoiceStartMonth: '2026-03' };
    const p = periodAt(s, 0);
    expect(toZonedParts(p.startUtc, LONDON)).toMatchObject({ month: 3, day: 26, hour: 0 });
    expect(toZonedParts(p.endUtc, LONDON)).toMatchObject({ month: 4, day: 26, hour: 0 });
    // 31 days, one of which is an hour short.
    expect(p.endUtc - p.startUtc).toBe((31 * 24 - 1) * 3600_000);
  });
});

describe('period listing', () => {
  test('lists every period that has begun, newest first, including the open one', () => {
    // 14 August 2026: the period running today started on 26 July.
    const now = at(2026, 8, 14, 10);
    const periods = listPeriods(base, now);
    expect(periods[0].key).toBe('2026-07');
    expect(periods[0].startUtc).toBeLessThanOrEqual(now);
    expect(periods[0].endUtc).toBeGreaterThan(now);
    expect(periods.at(-1)!.key).toBe('2026-01');
    expect(periods).toHaveLength(7);
  });

  test('a period is not listed before it starts', () => {
    // One minute before the January cut-over there is nothing to invoice.
    expect(listPeriods(base, at(2026, 1, 25, 23) )).toHaveLength(0);
    expect(listPeriods(base, at(2026, 1, 26, 0))).toHaveLength(1);
  });

  test('findPeriod rejects keys outside the configured range', () => {
    const now = at(2026, 8, 14);
    expect(findPeriod(base, '2026-03', now)?.invoiceNumber).toBe('TDC-TT-G2A-3');
    expect(findPeriod(base, '2025-12', now)).toBeNull(); // before the start month
    expect(findPeriod(base, '2026-11', now)).toBeNull(); // has not started
  });
});

describe('rounding', () => {
  const cases: [Parameters<typeof roundSeconds>[1], number, number, number][] = [
    ['exact', 15, 3600 + 7 * 60, 3600 + 7 * 60],
    ['up', 15, 3600 + 1, 3600 + 15 * 60],
    ['up', 15, 3600, 3600],
    ['down', 15, 3600 + 14 * 60, 3600],
    ['nearest', 15, 3600 + 7 * 60, 3600],
    ['nearest', 15, 3600 + 8 * 60, 3600 + 15 * 60],
    ['nearest', 30, 3600 + 16 * 60, 3600 + 30 * 60],
    ['up', 60, 1, 3600],
    ['down', 60, 3599, 0],
  ];

  for (const [mode, increment, input, expected] of cases) {
    test(`${mode} to ${increment}m: ${input}s → ${expected}s`, () => {
      expect(roundSeconds(input, mode, increment)).toBe(expected);
    });
  }
});

describe('invoice building', () => {
  const now = at(2026, 3, 1, 12);

  test('groups by description and clips entries to the period', () => {
    const period = periodAt(base, 1); // 26 Feb → 26 Mar
    const entries = [
      // Straddles the opening boundary: only the part on or after 26 Feb counts.
      entry('a', 'Migration', at(2026, 2, 25, 23), at(2026, 2, 26, 1)),
      entry('b', 'Migration', at(2026, 2, 27, 9), at(2026, 2, 27, 11)),
      entry('c', 'Support', at(2026, 2, 28, 9), at(2026, 2, 28, 9, 30)),
      // Entirely before the period.
      entry('d', 'Old work', at(2026, 1, 5, 9), at(2026, 1, 5, 17)),
    ];

    const invoice = buildInvoice(period, base, entries, now);
    expect(invoice.lines).toHaveLength(2);
    const migration = invoice.lines.find((l) => l.description === 'Migration')!;
    expect(migration.rawSeconds).toBe(3600 + 2 * 3600); // 1h clipped + 2h
    expect(invoice.rawSeconds).toBe(3 * 3600 + 1800);
    expect(invoice.total).toBe(350); // 3.5h at 100
    expect(invoice.lines.some((l) => l.description === 'Old work')).toBe(false);
  });

  test('a running timer is billed up to now, and only within the period', () => {
    const period = periodAt(base, 1);
    const entries = [entry('r', 'Live', at(2026, 3, 1, 10), null)];
    const invoice = buildInvoice(period, base, entries, now);
    expect(invoice.rawSeconds).toBe(2 * 3600);
    expect(invoice.hasRunningEntry).toBe(true);
    expect(invoice.inProgress).toBe(true);
  });

  test('rounding applies per line item, and the total matches the sum of the lines', () => {
    const settings = { ...base, roundingMode: 'up' as const, roundingIncrement: 15 };
    const period = periodAt(settings, 1);
    const entries = [
      // Three short check-ins on one task: rounded together, not individually.
      entry('a', 'Standup', at(2026, 2, 27, 9), at(2026, 2, 27, 9, 5)),
      entry('b', 'Standup', at(2026, 2, 28, 9), at(2026, 2, 28, 9, 5)),
      entry('c', 'Standup', at(2026, 3, 1, 9), at(2026, 3, 1, 9, 5)),
      entry('d', 'Build', at(2026, 2, 27, 10), at(2026, 2, 27, 11, 1)),
    ];

    const invoice = buildInvoice(period, settings, entries, now);
    const standup = invoice.lines.find((l) => l.description === 'Standup')!;
    // 15 minutes raw rounds up to 15, not to 3 × 15.
    expect(standup.billedSeconds).toBe(15 * 60);
    const build = invoice.lines.find((l) => l.description === 'Build')!;
    expect(build.billedSeconds).toBe(75 * 60); // 1h01m → 1h15m

    expect(invoice.total).toBe(invoice.lines.reduce((s, l) => s + l.amount, 0));
    expect(invoice.billedSeconds).toBe(90 * 60);
    expect(invoice.total).toBe(150);
  });

  test('blank descriptions collapse into a single labelled line', () => {
    const period = periodAt(base, 1);
    const entries = [
      entry('a', '', at(2026, 2, 27, 9), at(2026, 2, 27, 10)),
      entry('b', '   ', at(2026, 2, 27, 11), at(2026, 2, 27, 12)),
    ];
    const invoice = buildInvoice(period, base, entries, now);
    expect(invoice.lines).toHaveLength(1);
    expect(invoice.lines[0].description).toBe('(no description)');
    expect(invoice.lines[0].rawSeconds).toBe(2 * 3600);
  });

  test('the daily detail groups by local date', () => {
    const period = periodAt(base, 1);
    const entries = [
      // 23:30 SAST on the 27th is 21:30 UTC — it must not land on the 28th.
      entry('a', 'Late night', at(2026, 2, 27, 23, 30), at(2026, 2, 28, 0, 30)),
    ];
    const invoice = buildInvoice(period, base, entries, now);
    expect(invoice.details.map((d) => d.date)).toEqual(['2026-02-27']);
  });

  test('an empty period produces a zero invoice rather than an error', () => {
    const invoice = buildInvoice(periodAt(base, 1), base, [], now);
    expect(invoice.lines).toEqual([]);
    expect(invoice.total).toBe(0);
    expect(invoice.billedSeconds).toBe(0);
  });
});

describe('calendar helpers', () => {
  test('the week starts on Monday in the configured zone', () => {
    // 14 August 2026 is a Friday.
    const monday = startOfWeek(at(2026, 8, 14, 15), SAST);
    expect(toZonedParts(monday, SAST)).toMatchObject({ year: 2026, month: 8, day: 10, hour: 0 });
  });

  test('a wall-clock time inside a spring-forward gap resolves just past the jump', () => {
    // London jumps 01:00 → 02:00 on 29 March 2026, so 01:30 never happens.
    const instant = fromZonedParts(2026, 3, 29, 1, 30, 0, LONDON);
    expect(toZonedParts(instant, LONDON)).toMatchObject({ day: 29, hour: 2, minute: 30 });
  });

  test('an ambiguous autumn wall-clock time resolves deterministically', () => {
    // London repeats 01:00–01:59 on 25 October 2026. Either instant is defensible;
    // what matters is that the same input always gives the same answer.
    const first = fromZonedParts(2026, 10, 25, 1, 30, 0, LONDON);
    const second = fromZonedParts(2026, 10, 25, 1, 30, 0, LONDON);
    expect(first).toBe(second);
    expect(toZonedParts(first, LONDON)).toMatchObject({ day: 25, hour: 1, minute: 30 });
  });

  test('midnight is unambiguous on a DST day, so day boundaries never drift', () => {
    for (const day of [29, 30]) {
      const midnight = fromZonedParts(2026, 3, day, 0, 0, 0, LONDON);
      expect(toZonedParts(midnight, LONDON)).toMatchObject({ day, hour: 0, minute: 0 });
    }
  });

  test('a wall-clock time outside a DST transition round-trips exactly', () => {
    for (const [tz, month] of [[SAST, 6], [LONDON, 6], [LONDON, 12], ['America/New_York', 7]] as const) {
      const instant = fromZonedParts(2026, month, 15, 9, 45, 0, tz);
      expect(toZonedParts(instant, tz)).toMatchObject({ year: 2026, month, day: 15, hour: 9, minute: 45 });
    }
  });
});
