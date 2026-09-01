/**
 * CSV export of time entries.
 *
 * The columns are deliberately the ones `parseTogglCsv` reads, so an exported
 * file round-trips through the app's own importer (and through Toggl-shaped
 * tooling generally). Like a Toggl export, times are naive wall-clock values in
 * one stated timezone; keep the file together with the zone it was made in.
 */

import { pad2, toZonedParts, formatDuration } from './time';
import type { Entry } from './types';

export const ENTRY_CSV_HEADER = [
  'Description',
  'Client',
  'Start date',
  'Start time',
  'End date',
  'End time',
  'Duration',
  'Billable',
];

function csvField(value: string): string {
  return /[",\r\n]/.test(value) ? `"${value.replace(/"/g, '""')}"` : value;
}

function wallClock(utcMs: number, tz: string): { date: string; time: string } {
  const p = toZonedParts(utcMs, tz);
  return {
    date: `${p.year}-${pad2(p.month)}-${pad2(p.day)}`,
    time: `${pad2(p.hour)}:${pad2(p.minute)}:${pad2(p.second)}`,
  };
}

/**
 * Render completed entries as CSV, oldest first.
 *
 * A still-running entry is excluded: it has no end yet, and inventing one would
 * both misstate the data and create a bogus duplicate-detection fingerprint if
 * the file were ever re-imported after the timer stopped.
 */
export function entriesToCsv(
  entries: Entry[],
  clientNameById: Map<string, string>,
  timezone: string,
): string {
  const lines = [ENTRY_CSV_HEADER.join(',')];

  for (const entry of entries) {
    if (entry.endedAt === null) continue;
    const start = wallClock(entry.startedAt, timezone);
    const end = wallClock(entry.endedAt, timezone);
    // Measured between whole wall-clock seconds — the same truncation the
    // columns themselves carry — so the Duration column always agrees with the
    // timestamps when the file is read back.
    const seconds =
      Math.floor(entry.endedAt / 1000) - Math.floor(entry.startedAt / 1000);
    lines.push(
      [
        csvField(entry.description),
        csvField(clientNameById.get(entry.clientId) ?? ''),
        start.date,
        start.time,
        end.date,
        end.time,
        formatDuration(seconds),
        'Yes',
      ].join(','),
    );
  }

  return lines.join('\r\n') + '\r\n';
}
