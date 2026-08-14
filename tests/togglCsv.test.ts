import { describe, expect, test } from 'bun:test';
import { entryFingerprint, parseCsv, parseTogglCsv } from '../src/shared/togglCsv';
import { toZonedParts } from '../src/shared/time';

const HEADER =
  '"User","Email","Client","Project","Task","Description","Billable","Start date","Start time","End date","End time","Duration","Tags"';

const row = (desc: string, sd: string, st: string, ed: string, et: string, dur: string, billable = 'Yes') =>
  `"Test User","user@example.com","Example Client Ltd","Acme Platform","","${desc}","${billable}","${sd}","${st}","${ed}","${et}","${dur}",""`;

describe('CSV reader', () => {
  test('keeps commas that sit inside quoted fields', () => {
    const table = parseCsv('"a","b, still b","c"');
    expect(table).toEqual([['a', 'b, still b', 'c']]);
  });

  test('unescapes doubled quotes', () => {
    expect(parseCsv('"say ""hi""","x"')).toEqual([['say "hi"', 'x']]);
  });

  test('keeps newlines that sit inside quoted fields', () => {
    expect(parseCsv('"line one\nline two","x"')).toEqual([['line one\nline two', 'x']]);
  });

  test('strips the UTF-8 BOM Toggl prefixes', () => {
    const table = parseCsv('﻿"User","Email"');
    expect(table[0][0]).toBe('User');
  });

  test('handles CRLF and ignores a trailing newline', () => {
    expect(parseCsv('"a","b"\r\n"c","d"\r\n')).toEqual([
      ['a', 'b'],
      ['c', 'd'],
    ]);
  });

  test('preserves empty fields', () => {
    expect(parseCsv('"a","","c"')).toEqual([['a', '', 'c']]);
  });
});

describe('Toggl export parsing', () => {
  test('reads a row into a UTC instant using the supplied zone', () => {
    const csv = [HEADER, row('Payment gateway work, testing, TICKET-122', '2026-08-13', '14:42:09', '2026-08-13', '18:19:04', '03:36:55')].join('\n');

    const utc = parseTogglCsv(csv, 'Etc/UTC');
    expect(utc.problems).toEqual([]);
    expect(utc.rows).toHaveLength(1);
    expect(utc.rows[0].description).toBe('Payment gateway work, testing, TICKET-122');
    expect(new Date(utc.rows[0].startedAt).toISOString()).toBe('2026-08-13T14:42:09.000Z');

    // The same wall clock read in SAST is two hours earlier in UTC.
    const sast = parseTogglCsv(csv, 'Africa/Johannesburg');
    expect(new Date(sast.rows[0].startedAt).toISOString()).toBe('2026-08-13T12:42:09.000Z');
    expect(sast.rows[0].startedAt).toBe(utc.rows[0].startedAt - 2 * 3600_000);
  });

  test('the wall-clock time always reads back unchanged in its own zone', () => {
    const csv = [HEADER, row('x', '2026-08-13', '14:42:09', '2026-08-13', '18:19:04', '03:36:55')].join('\n');
    for (const tz of ['Etc/UTC', 'Europe/London', 'Africa/Johannesburg', 'America/New_York']) {
      const p = toZonedParts(parseTogglCsv(csv, tz).rows[0].startedAt, tz);
      expect(p).toMatchObject({ year: 2026, month: 8, day: 13, hour: 14, minute: 42, second: 9 });
    }
  });

  test('duration column is cross-checked against the timestamps', () => {
    const csv = [HEADER, row('Bad', '2026-08-13', '09:00:00', '2026-08-13', '10:00:00', '05:00:00')].join('\n');
    const result = parseTogglCsv(csv, 'Etc/UTC');
    expect(result.rows).toHaveLength(0);
    expect(result.problems[0].reason).toContain('Duration column says');
  });

  test('an entry spanning midnight uses its own end date', () => {
    const csv = [HEADER, row('Late', '2026-08-13', '23:30:00', '2026-08-14', '00:30:00', '01:00:00')].join('\n');
    const r = parseTogglCsv(csv, 'Europe/London').rows[0];
    expect((r.endedAt - r.startedAt) / 1000).toBe(3600);
    expect(toZonedParts(r.endedAt, 'Europe/London')).toMatchObject({ day: 14, hour: 0, minute: 30 });
  });

  test('billable is false only for an explicit No', () => {
    const csv = [
      HEADER,
      row('a', '2026-08-13', '09:00:00', '2026-08-13', '10:00:00', '01:00:00', 'Yes'),
      row('b', '2026-08-13', '10:00:00', '2026-08-13', '11:00:00', '01:00:00', 'No'),
      row('c', '2026-08-13', '11:00:00', '2026-08-13', '12:00:00', '01:00:00', ''),
    ].join('\n');
    expect(parseTogglCsv(csv, 'Etc/UTC').rows.map((r) => r.billable)).toEqual([true, false, true]);
  });

  test('a bad row is reported without costing the good rows', () => {
    const csv = [
      HEADER,
      row('good', '2026-08-13', '09:00:00', '2026-08-13', '10:00:00', '01:00:00'),
      row('bad', 'not-a-date', '09:00:00', '2026-08-13', '10:00:00', '01:00:00'),
      row('also good', '2026-08-13', '11:00:00', '2026-08-13', '12:00:00', '01:00:00'),
    ].join('\n');
    const result = parseTogglCsv(csv, 'Etc/UTC');
    expect(result.rows.map((r) => r.description)).toEqual(['good', 'also good']);
    expect(result.problems).toHaveLength(1);
    expect(result.problems[0].line).toBe(3);
  });

  test('an entry ending before it starts is rejected', () => {
    const csv = [HEADER, row('reversed', '2026-08-13', '10:00:00', '2026-08-13', '09:00:00', '01:00:00')].join('\n');
    expect(parseTogglCsv(csv, 'Etc/UTC').problems[0].reason).toContain('ends before it starts');
  });

  test('a file that is not a Toggl export is rejected with a useful message', () => {
    const result = parseTogglCsv('"Foo","Bar"\n"1","2"', 'Etc/UTC');
    expect(result.rows).toEqual([]);
    expect(result.problems[0].reason).toContain('missing column(s)');
    expect(result.problems[0].reason).toContain('Start date');
  });

  test('blank descriptions survive as empty strings', () => {
    const csv = [HEADER, row('', '2026-08-13', '09:00:00', '2026-08-13', '10:00:00', '01:00:00')].join('\n');
    expect(parseTogglCsv(csv, 'Etc/UTC').rows[0].description).toBe('');
  });
});

describe('duplicate detection', () => {
  test('identical entries share a fingerprint, differing ones do not', () => {
    expect(entryFingerprint(1000, 2000, 'Work')).toBe(entryFingerprint(1000, 2000, 'Work'));
    expect(entryFingerprint(1000, 2000, ' Work ')).toBe(entryFingerprint(1000, 2000, 'Work'));
    expect(entryFingerprint(1000, 2000, 'Work')).not.toBe(entryFingerprint(1001, 2000, 'Work'));
    expect(entryFingerprint(1000, 2000, 'Work')).not.toBe(entryFingerprint(1000, 2000, 'Other'));
  });

  test('a running entry never collides with a completed one', () => {
    expect(entryFingerprint(1000, null, 'Work')).not.toBe(entryFingerprint(1000, 2000, 'Work'));
  });

  test('re-importing the same rows in a different zone is NOT a duplicate', () => {
    // Deliberate: the same wall clock in another zone is a different instant, so
    // an import repeated under a corrected timezone must not be silently skipped.
    const csv = [HEADER, row('x', '2026-08-13', '09:00:00', '2026-08-13', '10:00:00', '01:00:00')].join('\n');
    const a = parseTogglCsv(csv, 'Etc/UTC').rows[0];
    const b = parseTogglCsv(csv, 'Africa/Johannesburg').rows[0];
    expect(entryFingerprint(a.startedAt, a.endedAt, a.description)).not.toBe(
      entryFingerprint(b.startedAt, b.endedAt, b.description),
    );
  });
});
