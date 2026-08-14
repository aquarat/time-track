import { describe, expect, test } from 'bun:test';
import type { Entry, Settings } from '../src/shared/types';
import {
  buildInvoice,
  findPeriod,
  listPeriods,
  periodAt,
  roundSeconds,
  summarisePeriod,
  summaryLine,
  summaryLineDescription,
} from '../src/shared/invoice';
import { fromZonedParts, snapToMinutes, startOfWeek, toZonedParts } from '../src/shared/time';

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
  summaryServiceDescription: 'Software development services',
  roundingMode: 'exact',
  roundingIncrement: 15,
  defaultDetailedInvoice: true,
  defaultDetailedTimeLog: true,
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

describe('summary (non-detailed) invoice', () => {
  const now = at(2026, 3, 1, 12);
  const entries = [
    entry('a', 'Migration', at(2026, 2, 27, 9), at(2026, 2, 27, 10, 7)),
    entry('b', 'Migration', at(2026, 2, 28, 9), at(2026, 2, 28, 10, 3)),
    entry('c', 'Support', at(2026, 3, 1, 9), at(2026, 3, 1, 9, 22)),
    entry('d', '', at(2026, 3, 1, 11), at(2026, 3, 1, 11, 40)),
  ];

  test('collapsing to one line never changes the amount due', () => {
    // The invariant that matters: a display toggle must not alter what is billed.
    for (const mode of ['exact', 'up', 'down', 'nearest'] as const) {
      for (const increment of [15, 30, 60]) {
        const settings = { ...base, roundingMode: mode, roundingIncrement: increment };
        const invoice = buildInvoice(periodAt(settings, 1), settings, entries, now);
        const line = summaryLine(invoice);
        expect(line.amount).toBe(invoice.total);
        expect(line.billedSeconds).toBe(invoice.billedSeconds);
        expect(line.rawSeconds).toBe(invoice.rawSeconds);
      }
    }
  });

  test('the single line carries the sum of the rounded lines, not a re-rounded total', () => {
    const settings = { ...base, roundingMode: 'up' as const, roundingIncrement: 60 };
    const invoice = buildInvoice(periodAt(settings, 1), settings, entries, now);
    // Three line items — Migration (2h10m), Support (22m), (no description) (40m) —
    // each rounded up to a whole hour independently, giving 3h + 1h + 1h.
    expect(invoice.billedSeconds).toBe(5 * 3600);
    expect(summaryLine(invoice).billedSeconds).toBe(5 * 3600);
    // Re-rounding the 3h12m raw total instead would bill 4h, an hour less.
    expect(roundSeconds(invoice.rawSeconds, 'up', 60)).toBe(4 * 3600);
  });

  test('the description names the service and the period boundaries', () => {
    const period = periodAt(base, 0);
    expect(summaryLineDescription(period, base)).toBe(
      'Software development services - 26 January 2026 to 26 February 2026',
    );
  });

  test('the description follows the configured timezone', () => {
    const settings = { ...base, timezone: 'Pacific/Kiritimati' }; // UTC+14
    const period = periodAt(settings, 0);
    expect(summaryLineDescription(period, settings)).toContain('26 January 2026');
    expect(summaryLineDescription(period, settings)).toContain('26 February 2026');
  });

  test('an empty period summarises to a zero line rather than breaking', () => {
    const invoice = buildInvoice(periodAt(base, 1), base, [], now);
    const line = summaryLine(invoice);
    expect(line.billedSeconds).toBe(0);
    expect(line.amount).toBe(0);
  });
});

describe('extra line items', () => {
  const now = at(2026, 3, 1, 12);
  const entries = [entry('a', 'Build', at(2026, 2, 27, 9), at(2026, 2, 27, 11))]; // 2h @ 100 = 200
  const extra = (id: string, description: string, amount: number) => ({
    id,
    periodKey: '2026-02',
    description,
    amount,
    createdAt: 0,
    updatedAt: 0,
  });

  test('extras are added to the time total without disturbing it', () => {
    const invoice = buildInvoice(periodAt(base, 1), base, entries, now, [
      extra('x', 'AWS reimbursement', 42.5),
      extra('y', 'Licence', 100),
    ]);
    expect(invoice.total).toBe(200); // time only
    expect(invoice.extrasTotal).toBe(142.5);
    expect(invoice.grandTotal).toBe(342.5);
    // Hours are unaffected by money that was never tracked.
    expect(invoice.billedSeconds).toBe(2 * 3600);
  });

  test('a negative extra acts as a discount', () => {
    const invoice = buildInvoice(periodAt(base, 1), base, entries, now, [extra('d', 'Goodwill discount', -50)]);
    expect(invoice.extrasTotal).toBe(-50);
    expect(invoice.grandTotal).toBe(150);
  });

  test('extras alone can carry an invoice with no tracked time', () => {
    const invoice = buildInvoice(periodAt(base, 1), base, [], now, [extra('x', 'Retainer', 500)]);
    expect(invoice.lines).toEqual([]);
    expect(invoice.total).toBe(0);
    expect(invoice.grandTotal).toBe(500);
  });

  test('no extras leaves the grand total equal to the time total', () => {
    const invoice = buildInvoice(periodAt(base, 1), base, entries, now);
    expect(invoice.extras).toEqual([]);
    expect(invoice.extrasTotal).toBe(0);
    expect(invoice.grandTotal).toBe(invoice.total);
  });

  test('fractional amounts sum without floating-point drift', () => {
    const invoice = buildInvoice(periodAt(base, 1), base, [], now, [
      extra('a', 'One', 0.1),
      extra('b', 'Two', 0.2),
    ]);
    expect(invoice.extrasTotal).toBe(0.3);
    expect(invoice.grandTotal).toBe(0.3);
  });

  test('the summary line still reports time only, so extras are never double-counted', () => {
    const invoice = buildInvoice(periodAt(base, 1), base, entries, now, [extra('x', 'Licence', 100)]);
    const line = summaryLine(invoice);
    expect(line.amount).toBe(invoice.total);
    expect(line.amount + invoice.extrasTotal).toBe(invoice.grandTotal);
  });

  test('period summaries carry the same figures as the document', () => {
    const period = periodAt(base, 1);
    const extras = [extra('x', 'Licence', 100)];
    const summary = summarisePeriod(period, base, entries, now, extras);
    const invoice = buildInvoice(period, base, entries, now, extras);
    expect(summary.grandTotal).toBe(invoice.grandTotal);
    expect(summary.extrasTotal).toBe(invoice.extrasTotal);
    expect(summary.extrasCount).toBe(1);
  });
});

describe('configurable summary wording', () => {
  test('the setting replaces the service wording', () => {
    const settings = { ...base, summaryServiceDescription: 'Consulting retainer' };
    expect(summaryLineDescription(periodAt(settings, 0), settings)).toBe(
      'Consulting retainer - 26 January 2026 to 26 February 2026',
    );
  });

  test('a blank setting falls back rather than producing a dangling dash', () => {
    for (const value of ['', '   ']) {
      const settings = { ...base, summaryServiceDescription: value };
      expect(summaryLineDescription(periodAt(settings, 0), settings)).toBe(
        'Software development services - 26 January 2026 to 26 February 2026',
      );
    }
  });
});

describe('quarter-hour snapping', () => {
  const clock = (utcMs: number, tz: string) => {
    const p = toZonedParts(utcMs, tz);
    return `${String(p.hour).padStart(2, '0')}:${String(p.minute).padStart(2, '0')}:${String(p.second).padStart(2, '0')}`;
  };

  test('rounds to the nearest quarter of the local wall clock', () => {
    const cases: [number, number, string][] = [
      [9, 7, '09:00:00'],
      [9, 8, '09:15:00'],
      [9, 22, '09:15:00'],
      [9, 23, '09:30:00'],
      [9, 53, '10:00:00'],
      [9, 45, '09:45:00'],
    ];
    for (const [hour, minute, expected] of cases) {
      const instant = fromZonedParts(2026, 6, 15, hour, minute, 0, LONDON);
      expect(clock(snapToMinutes(instant, LONDON, 15), LONDON)).toBe(expected);
    }
  });

  test('seconds are absorbed into the snap', () => {
    const instant = fromZonedParts(2026, 6, 15, 9, 7, 31, LONDON);
    expect(clock(snapToMinutes(instant, LONDON, 15), LONDON)).toBe('09:15:00');
  });

  test('snapping is idempotent', () => {
    const once = snapToMinutes(fromZonedParts(2026, 6, 15, 13, 38, 0, LONDON), LONDON, 15);
    expect(snapToMinutes(once, LONDON, 15)).toBe(once);
  });

  test('late in the day it can roll into the next midnight', () => {
    const instant = fromZonedParts(2026, 6, 15, 23, 53, 0, LONDON);
    const snapped = snapToMinutes(instant, LONDON, 15);
    expect(toZonedParts(snapped, LONDON)).toMatchObject({ day: 16, hour: 0, minute: 0 });
  });

  test('a zone offset by :45 snaps to its own wall clock, not to UTC boundaries', () => {
    // Kathmandu is UTC+05:45. At a 15-minute step that offset happens to line up
    // with UTC quarters, so the distinguishing case is a coarser step: snapping to
    // the hour must land on the local hour, which is quarter past in UTC.
    const KTM = 'Asia/Kathmandu';
    const snapped = snapToMinutes(fromZonedParts(2026, 6, 15, 9, 20, 0, KTM), KTM, 60);
    expect(clock(snapped, KTM)).toBe('09:00:00');
    expect(new Date(snapped).toISOString()).toBe('2026-06-15T03:15:00.000Z');
    // Rounding the epoch value directly would have moved it to a different hour.
    expect(snapped % (60 * 60_000)).not.toBe(0);
  });

  test('snapping stays on the local clock across a DST boundary', () => {
    // 29 March 2026: London jumps 01:00 → 02:00. An afternoon time that day is
    // still snapped against the wall clock, not against a 24-hour assumption.
    const instant = fromZonedParts(2026, 3, 29, 14, 7, 0, LONDON);
    expect(clock(snapToMinutes(instant, LONDON, 15), LONDON)).toBe('14:00:00');
    expect(toZonedParts(snapToMinutes(instant, LONDON, 15), LONDON).day).toBe(29);
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
