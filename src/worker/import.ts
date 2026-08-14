/**
 * Toggl CSV import.
 *
 * Always runs as a preview first: the same request with `dryRun: true` reports
 * exactly what committing would do, computed from the same code path, so the
 * summary can never disagree with the result.
 */

import type { Client, Entry, InvoiceConfig } from '../shared/types';
import { entryFingerprint, parseTogglCsv } from '../shared/togglCsv';
import type { ImportReport, PeriodImpact, TogglRow } from '../shared/togglCsv';
import { listPeriods } from '../shared/invoice';
import { dateKey } from '../shared/time';
import { HttpError, listEntries } from './db';

export interface ImportOptions {
  csv: string;
  /** Zone the file's wall-clock times were recorded in. */
  timezone: string;
  skipNonBillable: boolean;
  dryRun: boolean;
}

const MAX_CSV_BYTES = 5 * 1024 * 1024;

export async function runImport(
  db: D1Database,
  config: InvoiceConfig,
  client: Client,
  options: ImportOptions,
  now: number,
): Promise<ImportReport> {
  if (typeof options.csv !== 'string' || options.csv.trim() === '') {
    throw new HttpError(400, 'No CSV content supplied');
  }
  if (options.csv.length > MAX_CSV_BYTES) {
    throw new HttpError(413, 'CSV is larger than 5MB');
  }

  const timezone = options.timezone || config.timezone;
  if (!isValidTimezone(timezone)) throw new HttpError(400, `Unknown timezone: ${timezone}`);

  const { rows, problems } = parseTogglCsv(options.csv, timezone);
  if (rows.length === 0 && problems.length > 0) {
    // A header problem means nothing was understood at all; surface it directly.
    const fatal = problems.find((p) => p.reason.startsWith('Not a recognised'));
    if (fatal) throw new HttpError(400, fatal.reason);
  }

  const nonBillable = rows.filter((r) => !r.billable);
  const candidates = options.skipNonBillable ? rows.filter((r) => r.billable) : rows;

  // Compare only against entries in the window the file covers.
  const existingFingerprints = new Set<string>();
  const existing: Entry[] = [];
  if (candidates.length > 0) {
    const from = Math.min(...candidates.map((r) => r.startedAt));
    const to = Math.max(...candidates.map((r) => r.endedAt)) + 1;
    // Duplicate detection is per client: the same hour billed to two different
    // clients is two entries, not a repeat.
    existing.push(...(await listEntries(db, from, to, client.id)));
    for (const e of existing) {
      existingFingerprints.add(entryFingerprint(e.startedAt, e.endedAt, e.description));
    }
  }

  const seen = new Set<string>();
  const fresh: TogglRow[] = [];
  let duplicates = 0;
  for (const row of candidates) {
    const fp = entryFingerprint(row.startedAt, row.endedAt, row.description);
    // Guards both re-importing a file and a file containing the same row twice.
    if (existingFingerprints.has(fp) || seen.has(fp)) {
      duplicates++;
      continue;
    }
    seen.add(fp);
    fresh.push(row);
  }

  const totalSeconds = fresh.reduce((sum, r) => sum + (r.endedAt - r.startedAt) / 1000, 0);
  const sorted = [...fresh].sort((a, b) => a.startedAt - b.startedAt);

  const report: ImportReport = {
    timezone,
    parsed: rows.length,
    toImport: fresh.length,
    duplicates,
    nonBillableSkipped: options.skipNonBillable ? nonBillable.length : 0,
    nonBillableIncluded: options.skipNonBillable ? 0 : nonBillable.length,
    blankDescriptions: fresh.filter((r) => r.description === '').length,
    problems: problems.slice(0, 50),
    totalSeconds,
    firstDate: sorted.length > 0 ? dateKey(sorted[0].startedAt, timezone) : null,
    lastDate: sorted.length > 0 ? dateKey(sorted[sorted.length - 1].startedAt, timezone) : null,
    distinctDescriptions: new Set(fresh.map((r) => r.description)).size,
    overlaps: countOverlaps(sorted, existing),
    periods: periodImpact(config, sorted, now),
    sample: sorted.slice(0, 8).map((r) => ({
      description: r.description,
      startedAt: r.startedAt,
      endedAt: r.endedAt,
    })),
    committed: false,
    imported: 0,
  };

  if (options.dryRun || fresh.length === 0) return report;

  // D1 caps how much a single batch may carry, so write in chunks. A partial
  // failure leaves earlier chunks in place; re-running is safe because the
  // fingerprint check will skip whatever already landed.
  const CHUNK = 50;
  let imported = 0;
  for (let i = 0; i < sorted.length; i += CHUNK) {
    const chunk = sorted.slice(i, i + CHUNK);
    await db.batch(
      chunk.map((row) =>
        db
          .prepare(
            `INSERT INTO entries (id, client_id, description, started_at, ended_at, created_at, updated_at)
             VALUES (?, ?, ?, ?, ?, ?, ?)`,
          )
          .bind(crypto.randomUUID(), client.id, row.description, row.startedAt, row.endedAt, now, now),
      ),
    );
    imported += chunk.length;
  }

  report.committed = true;
  report.imported = imported;
  return report;
}

/** How the incoming rows distribute across invoice periods. */
function periodImpact(config: InvoiceConfig, rows: TogglRow[], now: number): PeriodImpact[] {
  if (rows.length === 0) return [];
  const periods = listPeriods(config, Math.max(now, rows[rows.length - 1].endedAt));
  const out: PeriodImpact[] = [];

  for (const period of periods) {
    let seconds = 0;
    let entries = 0;
    for (const row of rows) {
      const overlap = Math.min(row.endedAt, period.endUtc) - Math.max(row.startedAt, period.startUtc);
      if (overlap > 0) {
        seconds += overlap / 1000;
        entries++;
      }
    }
    if (entries > 0) {
      out.push({
        key: period.key,
        label: period.label,
        invoiceNumber: period.invoiceNumber,
        seconds,
        entries,
      });
    }
  }
  return out;
}

/**
 * Count incoming rows that overlap another entry.
 *
 * Overlaps are legal here but worth reporting: Toggl allows them and this app's
 * timeline will draw them in separate lanes, but a billed hour appearing twice
 * is usually a mistake the user wants to know about before committing.
 */
function countOverlaps(incoming: TogglRow[], existing: Entry[]): number {
  const spans = [
    ...incoming.map((r) => ({ from: r.startedAt, to: r.endedAt })),
    ...existing.map((e) => ({ from: e.startedAt, to: e.endedAt ?? e.startedAt })),
  ].sort((a, b) => a.from - b.from);

  let count = 0;
  let watermark = -Infinity;
  for (const span of spans) {
    if (span.from < watermark) count++;
    watermark = Math.max(watermark, span.to);
  }
  return count;
}

function isValidTimezone(tz: string): boolean {
  try {
    new Intl.DateTimeFormat('en-US', { timeZone: tz });
    return true;
  } catch {
    return false;
  }
}
