import type { Entry, InvoiceExtra, PeriodLabelMode, RoundingMode, Settings } from '../shared/types';

interface SettingsRow {
  timezone: string;
  invoice_period_day: number;
  invoice_prefix: string;
  invoice_start_seq: number;
  invoice_start_month: string;
  period_label_mode: string;
  logo_data_url: string;
  company_name: string;
  company_address: string;
  client_name: string;
  client_address: string;
  currency: string;
  hourly_rate: number;
  invoice_footer: string;
  summary_service_description: string;
  rounding_mode: string;
  rounding_increment: number;
  default_detailed_invoice: number;
  default_detailed_time_log: number;
  updated_at: number;
}

interface EntryRow {
  id: string;
  description: string;
  started_at: number;
  ended_at: number | null;
  created_at: number;
  updated_at: number;
}

const ROUNDING_MODES: RoundingMode[] = ['exact', 'up', 'down', 'nearest'];
const LABEL_MODES: PeriodLabelMode[] = ['start', 'end'];

function rowToSettings(row: SettingsRow): Settings {
  return {
    timezone: row.timezone,
    invoicePeriodDay: row.invoice_period_day,
    invoicePrefix: row.invoice_prefix,
    invoiceStartSeq: row.invoice_start_seq,
    invoiceStartMonth: row.invoice_start_month,
    periodLabelMode: LABEL_MODES.includes(row.period_label_mode as PeriodLabelMode)
      ? (row.period_label_mode as PeriodLabelMode)
      : 'start',
    logoDataUrl: row.logo_data_url,
    companyName: row.company_name,
    companyAddress: row.company_address,
    clientName: row.client_name,
    clientAddress: row.client_address,
    currency: row.currency,
    hourlyRate: row.hourly_rate,
    invoiceFooter: row.invoice_footer,
    summaryServiceDescription: row.summary_service_description,
    roundingMode: ROUNDING_MODES.includes(row.rounding_mode as RoundingMode)
      ? (row.rounding_mode as RoundingMode)
      : 'exact',
    roundingIncrement: row.rounding_increment,
    // SQLite has no boolean type; the columns hold 0/1.
    defaultDetailedInvoice: row.default_detailed_invoice !== 0,
    defaultDetailedTimeLog: row.default_detailed_time_log !== 0,
    updatedAt: row.updated_at,
  };
}

function rowToEntry(row: EntryRow): Entry {
  return {
    id: row.id,
    description: row.description,
    startedAt: row.started_at,
    endedAt: row.ended_at,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

export async function getSettings(db: D1Database): Promise<Settings> {
  const row = await db.prepare('SELECT * FROM settings WHERE id = 1').first<SettingsRow>();
  if (!row) throw new Error('settings row missing — run the D1 migrations');
  return rowToSettings(row);
}

/** Validate and clamp an incoming settings patch, then persist it. */
export async function saveSettings(
  db: D1Database,
  patch: Partial<Settings>,
  now: number,
): Promise<Settings> {
  const current = await getSettings(db);
  const next: Settings = { ...current, ...patch, updatedAt: now };

  if (!isValidTimezone(next.timezone)) throw new HttpError(400, `Unknown timezone: ${next.timezone}`);
  next.invoicePeriodDay = clampInt(next.invoicePeriodDay, 1, 31, current.invoicePeriodDay);
  next.invoiceStartSeq = clampInt(next.invoiceStartSeq, 0, 1_000_000, current.invoiceStartSeq);
  if (!/^\d{4}-(0[1-9]|1[0-2])$/.test(next.invoiceStartMonth)) {
    throw new HttpError(400, 'invoiceStartMonth must look like "2026-01"');
  }
  if (!LABEL_MODES.includes(next.periodLabelMode)) throw new HttpError(400, 'Invalid periodLabelMode');
  if (!ROUNDING_MODES.includes(next.roundingMode)) throw new HttpError(400, 'Invalid roundingMode');
  next.roundingIncrement = clampInt(next.roundingIncrement, 1, 480, current.roundingIncrement);
  if (!Number.isFinite(next.hourlyRate) || next.hourlyRate < 0) throw new HttpError(400, 'Invalid hourlyRate');
  if (next.summaryServiceDescription.length > 200) {
    throw new HttpError(400, 'Summary service description is too long (max 200 characters)');
  }
  next.defaultDetailedInvoice = next.defaultDetailedInvoice !== false;
  next.defaultDetailedTimeLog = next.defaultDetailedTimeLog !== false;
  // A D1 row has a hard size ceiling; a logo is meant to be a small mark, not a photo.
  if (next.logoDataUrl.length > 512 * 1024) throw new HttpError(413, 'Logo too large (max ~512KB encoded)');
  if (next.logoDataUrl !== '' && !/^data:image\/(png|jpeg|gif|svg\+xml|webp);base64,/.test(next.logoDataUrl)) {
    throw new HttpError(400, 'Logo must be a base64 image data URL');
  }

  await db
    .prepare(
      `UPDATE settings SET
         timezone = ?, invoice_period_day = ?, invoice_prefix = ?, invoice_start_seq = ?,
         invoice_start_month = ?, period_label_mode = ?, logo_data_url = ?, company_name = ?,
         company_address = ?, client_name = ?, client_address = ?, currency = ?, hourly_rate = ?,
         invoice_footer = ?, summary_service_description = ?, rounding_mode = ?, rounding_increment = ?,
         default_detailed_invoice = ?, default_detailed_time_log = ?, updated_at = ?
       WHERE id = 1`,
    )
    .bind(
      next.timezone, next.invoicePeriodDay, next.invoicePrefix, next.invoiceStartSeq,
      next.invoiceStartMonth, next.periodLabelMode, next.logoDataUrl, next.companyName,
      next.companyAddress, next.clientName, next.clientAddress, next.currency, next.hourlyRate,
      next.invoiceFooter, next.summaryServiceDescription, next.roundingMode, next.roundingIncrement,
      next.defaultDetailedInvoice ? 1 : 0, next.defaultDetailedTimeLog ? 1 : 0, next.updatedAt,
    )
    .run();

  return next;
}

/**
 * Entries that overlap [from, to). A running entry is included whenever it
 * started before `to`, since its open end always reaches the present.
 */
export async function listEntries(db: D1Database, from: number, to: number): Promise<Entry[]> {
  const { results } = await db
    .prepare(
      `SELECT * FROM entries
       WHERE started_at < ? AND (ended_at IS NULL OR ended_at > ?)
       ORDER BY started_at ASC`,
    )
    .bind(to, from)
    .all<EntryRow>();
  return results.map(rowToEntry);
}

export async function getRunningEntry(db: D1Database): Promise<Entry | null> {
  const row = await db
    .prepare('SELECT * FROM entries WHERE ended_at IS NULL ORDER BY started_at DESC LIMIT 1')
    .first<EntryRow>();
  return row ? rowToEntry(row) : null;
}

export async function getEntry(db: D1Database, id: string): Promise<Entry | null> {
  const row = await db.prepare('SELECT * FROM entries WHERE id = ?').bind(id).first<EntryRow>();
  return row ? rowToEntry(row) : null;
}

/**
 * Start a timer, closing any already-running one first.
 *
 * Toggl's behaviour, and the only sane reading of "start" when a timer is
 * already going: you moved on to the next thing, so the previous entry ends now.
 */
export async function startEntry(db: D1Database, description: string, now: number): Promise<Entry> {
  await db
    .prepare('UPDATE entries SET ended_at = ?, updated_at = ? WHERE ended_at IS NULL')
    .bind(now, now)
    .run();

  const entry: Entry = {
    id: crypto.randomUUID(),
    description: description.trim(),
    startedAt: now,
    endedAt: null,
    createdAt: now,
    updatedAt: now,
  };
  await insertEntry(db, entry);
  return entry;
}

export async function insertEntry(db: D1Database, entry: Entry): Promise<void> {
  await db
    .prepare(
      `INSERT INTO entries (id, description, started_at, ended_at, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?)`,
    )
    .bind(entry.id, entry.description, entry.startedAt, entry.endedAt, entry.createdAt, entry.updatedAt)
    .run();
}

export async function stopRunningEntries(db: D1Database, now: number): Promise<Entry | null> {
  const running = await getRunningEntry(db);
  if (!running) return null;
  // Guard against a clock skew or a timer started "in the future" by a manual edit.
  const endedAt = Math.max(now, running.startedAt);
  await db
    .prepare('UPDATE entries SET ended_at = ?, updated_at = ? WHERE ended_at IS NULL')
    .bind(endedAt, now)
    .run();
  return { ...running, endedAt, updatedAt: now };
}

export async function updateEntry(
  db: D1Database,
  id: string,
  patch: { description?: string; startedAt?: number; endedAt?: number | null },
  now: number,
): Promise<Entry> {
  const existing = await getEntry(db, id);
  if (!existing) throw new HttpError(404, 'Entry not found');

  const next: Entry = {
    ...existing,
    description: patch.description !== undefined ? patch.description.trim() : existing.description,
    startedAt: patch.startedAt !== undefined ? patch.startedAt : existing.startedAt,
    endedAt: patch.endedAt !== undefined ? patch.endedAt : existing.endedAt,
    updatedAt: now,
  };

  if (!Number.isFinite(next.startedAt)) throw new HttpError(400, 'Invalid startedAt');
  if (next.endedAt !== null) {
    if (!Number.isFinite(next.endedAt)) throw new HttpError(400, 'Invalid endedAt');
    if (next.endedAt < next.startedAt) throw new HttpError(400, 'Entry cannot end before it starts');
  } else {
    // Reopening an entry would create a second running timer; close the others.
    await db
      .prepare('UPDATE entries SET ended_at = ?, updated_at = ? WHERE ended_at IS NULL AND id != ?')
      .bind(now, now, id)
      .run();
  }

  await db
    .prepare('UPDATE entries SET description = ?, started_at = ?, ended_at = ?, updated_at = ? WHERE id = ?')
    .bind(next.description, next.startedAt, next.endedAt, next.updatedAt, id)
    .run();
  return next;
}

export async function deleteEntry(db: D1Database, id: string): Promise<boolean> {
  const res = await db.prepare('DELETE FROM entries WHERE id = ?').bind(id).run();
  return (res.meta.changes ?? 0) > 0;
}

/**
 * Autocomplete over past descriptions.
 *
 * Ranked by most-recently-used rather than most-frequent: the task you logged an
 * hour ago is far more likely to be the one you are starting again.
 */
export async function suggestDescriptions(db: D1Database, query: string, limit = 8): Promise<string[]> {
  const trimmed = query.trim();
  const like = `%${trimmed.replace(/[\\%_]/g, (c) => `\\${c}`)}%`;
  const { results } = await db
    .prepare(
      `SELECT description, MAX(started_at) AS last_used
       FROM entries
       WHERE description != '' AND (? = '' OR description LIKE ? ESCAPE '\\')
       GROUP BY description
       ORDER BY last_used DESC
       LIMIT ?`,
    )
    .bind(trimmed, like, limit)
    .all<{ description: string }>();
  return results.map((r) => r.description);
}

interface ExtraRow {
  id: string;
  period_key: string;
  description: string;
  amount: number;
  created_at: number;
  updated_at: number;
}

function rowToExtra(row: ExtraRow): InvoiceExtra {
  return {
    id: row.id,
    periodKey: row.period_key,
    description: row.description,
    amount: row.amount,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

/** Hand-entered line items for one invoice period, oldest first. */
export async function listExtras(db: D1Database, periodKey: string): Promise<InvoiceExtra[]> {
  const { results } = await db
    .prepare('SELECT * FROM invoice_extras WHERE period_key = ? ORDER BY created_at ASC, id ASC')
    .bind(periodKey)
    .all<ExtraRow>();
  return results.map(rowToExtra);
}

/**
 * Every extra, grouped by period key.
 *
 * The invoice list needs all of them at once to show correct totals; at personal
 * scale that is one small query rather than one per period.
 */
export async function listAllExtras(db: D1Database): Promise<Map<string, InvoiceExtra[]>> {
  const { results } = await db
    .prepare('SELECT * FROM invoice_extras ORDER BY created_at ASC, id ASC')
    .all<ExtraRow>();
  const byPeriod = new Map<string, InvoiceExtra[]>();
  for (const row of results) {
    const extra = rowToExtra(row);
    const bucket = byPeriod.get(extra.periodKey);
    if (bucket) bucket.push(extra);
    else byPeriod.set(extra.periodKey, [extra]);
  }
  return byPeriod;
}

export async function addExtra(
  db: D1Database,
  periodKey: string,
  description: string,
  amount: number,
  now: number,
): Promise<InvoiceExtra> {
  const trimmed = description.trim();
  if (trimmed === '') throw new HttpError(400, 'A line item needs a description');
  if (trimmed.length > 300) throw new HttpError(400, 'Description is too long (max 300 characters)');
  // Negatives are allowed on purpose: a discount or credit is a line item too.
  if (!Number.isFinite(amount)) throw new HttpError(400, 'Amount must be a number');

  const extra: InvoiceExtra = {
    id: crypto.randomUUID(),
    periodKey,
    description: trimmed,
    amount: Math.round(amount * 100) / 100,
    createdAt: now,
    updatedAt: now,
  };
  await db
    .prepare(
      `INSERT INTO invoice_extras (id, period_key, description, amount, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?)`,
    )
    .bind(extra.id, extra.periodKey, extra.description, extra.amount, extra.createdAt, extra.updatedAt)
    .run();
  return extra;
}

export async function deleteExtra(db: D1Database, periodKey: string, id: string): Promise<boolean> {
  // Scoped by period as well as id so a stale form cannot delete another
  // invoice's line item.
  const res = await db
    .prepare('DELETE FROM invoice_extras WHERE id = ? AND period_key = ?')
    .bind(id, periodKey)
    .run();
  return (res.meta.changes ?? 0) > 0;
}

export class HttpError extends Error {
  constructor(
    readonly status: number,
    message: string,
  ) {
    super(message);
  }
}

function clampInt(value: number, min: number, max: number, fallback: number): number {
  const n = Math.round(Number(value));
  if (!Number.isFinite(n)) return fallback;
  return Math.min(max, Math.max(min, n));
}

function isValidTimezone(tz: string): boolean {
  try {
    new Intl.DateTimeFormat('en-US', { timeZone: tz });
    return true;
  } catch {
    return false;
  }
}
