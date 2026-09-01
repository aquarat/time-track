import { describe, expect, test } from 'bun:test';
import { entriesToCsv } from '../src/shared/exportCsv';
import { parseTogglCsv } from '../src/shared/togglCsv';
import { fromZonedParts } from '../src/shared/time';
import type { Entry } from '../src/shared/types';

const TZ = 'Europe/London';

const entry = (over: Partial<Entry>): Entry => ({
  id: 'id',
  clientId: 'c1',
  description: 'work',
  startedAt: 0,
  endedAt: 0,
  createdAt: 0,
  updatedAt: 0,
  ...over,
});

const clients = new Map([
  ['c1', 'Example Client Ltd'],
  ['c2', 'Client "Two", plc'],
]);

describe('entries CSV export', () => {
  test('round-trips through the Toggl importer without loss or problems', () => {
    const entries: Entry[] = [
      entry({
        id: 'a',
        description: 'Payment gateway work, testing, TICKET-122',
        startedAt: fromZonedParts(2026, 8, 13, 9, 15, 0, TZ),
        endedAt: fromZonedParts(2026, 8, 13, 12, 45, 30, TZ),
      }),
      entry({
        id: 'b',
        clientId: 'c2',
        description: 'Said "done"\nthen more',
        startedAt: fromZonedParts(2026, 8, 14, 22, 0, 0, TZ),
        // Crosses midnight into the next calendar day.
        endedAt: fromZonedParts(2026, 8, 15, 1, 30, 0, TZ),
      }),
    ];

    const parsed = parseTogglCsv(entriesToCsv(entries, clients, TZ), TZ);

    expect(parsed.problems).toEqual([]);
    expect(parsed.rows).toHaveLength(2);
    expect(parsed.rows[0].description).toBe('Payment gateway work, testing, TICKET-122');
    expect(parsed.rows[0].client).toBe('Example Client Ltd');
    expect(parsed.rows[0].startedAt).toBe(entries[0].startedAt);
    expect(parsed.rows[0].endedAt).toBe(entries[0].endedAt);
    expect(parsed.rows[1].description).toBe('Said "done"\nthen more');
    expect(parsed.rows[1].client).toBe('Client "Two", plc');
    expect(parsed.rows[1].startedAt).toBe(entries[1].startedAt);
    expect(parsed.rows[1].endedAt).toBe(entries[1].endedAt);
  });

  test('sub-second timestamps still satisfy the importer duration check', () => {
    const start = fromZonedParts(2026, 8, 13, 9, 0, 0, TZ) + 900;
    const end = fromZonedParts(2026, 8, 13, 9, 0, 5, TZ) + 100;
    const parsed = parseTogglCsv(entriesToCsv([entry({ startedAt: start, endedAt: end })], clients, TZ), TZ);
    expect(parsed.problems).toEqual([]);
    expect(parsed.rows).toHaveLength(1);
  });

  test('excludes the running entry rather than inventing an end for it', () => {
    const rows = [
      entry({
        startedAt: fromZonedParts(2026, 8, 13, 9, 0, 0, TZ),
        endedAt: null,
      }),
    ];
    const csv = entriesToCsv(rows, clients, TZ);
    const parsed = parseTogglCsv(csv, TZ);
    expect(parsed.rows).toEqual([]);
    expect(parsed.problems).toEqual([]);
  });

  test('an unknown client id becomes a blank client rather than a crash', () => {
    const csv = entriesToCsv(
      [entry({ clientId: 'gone', startedAt: 0, endedAt: 60_000 })],
      clients,
      'UTC',
    );
    const parsed = parseTogglCsv(csv, 'UTC');
    expect(parsed.rows[0].client).toBe('');
  });
});
