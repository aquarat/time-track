import type {
  Client,
  Entry,
  InvoiceExtra,
  PeriodLabelMode,
  RoundingMode,
  Settings,
} from '../shared/types';

/**
 * Only the global columns are read. The migration deliberately left the old
 * client-specific columns in place so the previous Worker version still works
 * against this schema; nothing here should touch them.
 */
interface SettingsRow {
  timezone: string;
  logo_data_url: string;
  company_name: string;
  company_address: string;
  default_client_id: string;
  updated_at: number;
}

interface ClientRow {
  id: string;
  slug: string;
  name: string;
  address: string;
  colour: string;
  invoice_period_day: number;
  invoice_prefix: string;
  invoice_start_seq: number;
  invoice_start_month: string;
  period_label_mode: string;
  currency: string;
  hourly_rate: number;
  rounding_mode: string;
  rounding_increment: number;
  invoice_footer: string;
  summary_service_description: string;
  default_detailed_invoice: number;
  default_detailed_time_log: number;
  created_at: number;
  updated_at: number;
}

interface EntryRow {
  id: string;
  client_id: string;
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
    logoDataUrl: row.logo_data_url,
    companyName: row.company_name,
    companyAddress: row.company_address,
    defaultClientId: row.default_client_id,
    updatedAt: row.updated_at,
  };
}

function rowToClient(row: ClientRow): Client {
  return {
    id: row.id,
    slug: row.slug,
    name: row.name,
    address: row.address,
    colour: row.colour,
    invoicePeriodDay: row.invoice_period_day,
    invoicePrefix: row.invoice_prefix,
    invoiceStartSeq: row.invoice_start_seq,
    invoiceStartMonth: row.invoice_start_month,
    periodLabelMode: LABEL_MODES.includes(row.period_label_mode as PeriodLabelMode)
      ? (row.period_label_mode as PeriodLabelMode)
      : 'start',
    currency: row.currency,
    hourlyRate: row.hourly_rate,
    roundingMode: ROUNDING_MODES.includes(row.rounding_mode as RoundingMode)
      ? (row.rounding_mode as RoundingMode)
      : 'exact',
    roundingIncrement: row.rounding_increment,
    invoiceFooter: row.invoice_footer,
    summaryServiceDescription: row.summary_service_description,
    // SQLite has no boolean type; the columns hold 0/1.
    defaultDetailedInvoice: row.default_detailed_invoice !== 0,
    defaultDetailedTimeLog: row.default_detailed_time_log !== 0,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

function rowToEntry(row: EntryRow): Entry {
  return {
    id: row.id,
    clientId: row.client_id,
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

export async function saveSettings(
  db: D1Database,
  patch: Partial<Settings>,
  now: number,
): Promise<Settings> {
  const current = await getSettings(db);
  const next: Settings = { ...current, ...patch, updatedAt: now };

  if (!isValidTimezone(next.timezone)) throw new HttpError(400, `Unknown timezone: ${next.timezone}`);
  // A D1 row has a hard size ceiling; a logo is meant to be a small mark, not a photo.
  if (next.logoDataUrl.length > 512 * 1024) throw new HttpError(413, 'Logo too large (max ~512KB encoded)');
  if (next.logoDataUrl !== '' && !/^data:image\/(png|jpeg|gif|svg\+xml|webp);base64,/.test(next.logoDataUrl)) {
    throw new HttpError(400, 'Logo must be a base64 image data URL');
  }
  if (next.defaultClientId !== current.defaultClientId) {
    // Pointing the default at a client that does not exist would break the
    // tracker's start button for every new entry.
    if (!(await getClient(db, next.defaultClientId))) throw new HttpError(400, 'Unknown default client');
  }

  await db
    .prepare(
      `UPDATE settings SET
         timezone = ?, logo_data_url = ?, company_name = ?, company_address = ?,
         default_client_id = ?, updated_at = ?
       WHERE id = 1`,
    )
    .bind(
      next.timezone, next.logoDataUrl, next.companyName, next.companyAddress,
      next.defaultClientId, next.updatedAt,
    )
    .run();

  return next;
}

/* --- clients -------------------------------------------------------------- */

export async function listClients(db: D1Database): Promise<Client[]> {
  const { results } = await db
    .prepare('SELECT * FROM clients ORDER BY name COLLATE NOCASE ASC')
    .all<ClientRow>();
  return results.map(rowToClient);
}

export async function getClient(db: D1Database, id: string): Promise<Client | null> {
  const row = await db.prepare('SELECT * FROM clients WHERE id = ?').bind(id).first<ClientRow>();
  return row ? rowToClient(row) : null;
}

export async function getClientBySlug(db: D1Database, slug: string): Promise<Client | null> {
  const row = await db.prepare('SELECT * FROM clients WHERE slug = ?').bind(slug).first<ClientRow>();
  return row ? rowToClient(row) : null;
}

/** Resolve a client by slug, falling back to the configured default. */
export async function resolveClient(
  db: D1Database,
  slug: string | null,
  settings: Settings,
): Promise<Client> {
  const client = slug ? await getClientBySlug(db, slug) : await getClient(db, settings.defaultClientId);
  if (!client) throw new HttpError(404, slug ? `Unknown client "${slug}"` : 'No default client configured');
  return client;
}

/** "Acme Widgets (Pty) Ltd." -> "acme-widgets-pty-ltd". */
export function slugify(name: string): string {
  const base = name
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 60);
  return base || 'client';
}

async function assertSlugFree(db: D1Database, slug: string, exceptId?: string): Promise<void> {
  const row = await db.prepare('SELECT id FROM clients WHERE slug = ?').bind(slug).first<{ id: string }>();
  if (row && row.id !== exceptId) throw new HttpError(409, `The slug "${slug}" is already in use`);
}

function validateClient(next: Client, previous?: Client): Client {
  if (next.name.trim() === '') throw new HttpError(400, 'A client needs a name');
  if (!/^[a-z0-9][a-z0-9-]*$/.test(next.slug)) {
    throw new HttpError(400, 'Slug may contain only lowercase letters, numbers and hyphens');
  }
  if (!/^\d{4}-(0[1-9]|1[0-2])$/.test(next.invoiceStartMonth)) {
    throw new HttpError(400, 'Start month must look like "2026-01"');
  }
  if (!LABEL_MODES.includes(next.periodLabelMode)) throw new HttpError(400, 'Invalid period naming');
  if (!ROUNDING_MODES.includes(next.roundingMode)) throw new HttpError(400, 'Invalid rounding mode');
  if (!Number.isFinite(next.hourlyRate) || next.hourlyRate < 0) throw new HttpError(400, 'Invalid hourly rate');
  if (!/^#[0-9a-fA-F]{6}$/.test(next.colour)) throw new HttpError(400, 'Colour must be a #rrggbb value');
  if (next.summaryServiceDescription.length > 200) {
    throw new HttpError(400, 'Summary service description is too long (max 200 characters)');
  }
  return {
    ...next,
    name: next.name.trim(),
    invoicePeriodDay: clampInt(next.invoicePeriodDay, 1, 31, previous?.invoicePeriodDay ?? 26),
    invoiceStartSeq: clampInt(next.invoiceStartSeq, 0, 1_000_000, previous?.invoiceStartSeq ?? 1),
    roundingIncrement: clampInt(next.roundingIncrement, 1, 480, previous?.roundingIncrement ?? 15),
  };
}

const CLIENT_COLUMNS = `slug = ?, name = ?, address = ?, colour = ?,
  invoice_period_day = ?, invoice_prefix = ?, invoice_start_seq = ?, invoice_start_month = ?,
  period_label_mode = ?, currency = ?, hourly_rate = ?, rounding_mode = ?, rounding_increment = ?,
  invoice_footer = ?, summary_service_description = ?,
  default_detailed_invoice = ?, default_detailed_time_log = ?, updated_at = ?`;

function clientBindings(c: Client): unknown[] {
  return [
    c.slug, c.name, c.address, c.colour,
    c.invoicePeriodDay, c.invoicePrefix, c.invoiceStartSeq, c.invoiceStartMonth,
    c.periodLabelMode, c.currency, c.hourlyRate, c.roundingMode, c.roundingIncrement,
    c.invoiceFooter, c.summaryServiceDescription,
    c.defaultDetailedInvoice ? 1 : 0, c.defaultDetailedTimeLog ? 1 : 0, c.updatedAt,
  ];
}

/**
 * Create a client, seeding anything unspecified from the current default so a
 * new client is a few fields rather than twenty.
 */
export async function createClient(
  db: D1Database,
  patch: Partial<Client>,
  now: number,
): Promise<Client> {
  const settings = await getSettings(db);
  const template = await getClient(db, settings.defaultClientId);

  const name = (patch.name ?? '').trim();
  const slug = (patch.slug ?? '').trim() || slugify(name);
  await assertSlugFree(db, slug);

  const client = validateClient({
    id: crypto.randomUUID(),
    slug,
    name,
    address: patch.address ?? '',
    colour: patch.colour ?? nextColour(template?.colour),
    // A new client starts its own series at 1 rather than inheriting a
    // half-used sequence from whoever the template was.
    invoicePeriodDay: patch.invoicePeriodDay ?? template?.invoicePeriodDay ?? 26,
    invoicePrefix: patch.invoicePrefix ?? '',
    invoiceStartSeq: patch.invoiceStartSeq ?? 1,
    invoiceStartMonth: patch.invoiceStartMonth ?? template?.invoiceStartMonth ?? '2026-01',
    periodLabelMode: patch.periodLabelMode ?? template?.periodLabelMode ?? 'start',
    currency: patch.currency ?? template?.currency ?? 'GBP',
    hourlyRate: patch.hourlyRate ?? 0,
    roundingMode: patch.roundingMode ?? template?.roundingMode ?? 'exact',
    roundingIncrement: patch.roundingIncrement ?? template?.roundingIncrement ?? 15,
    invoiceFooter: patch.invoiceFooter ?? template?.invoiceFooter ?? '',
    summaryServiceDescription:
      patch.summaryServiceDescription ?? template?.summaryServiceDescription ?? 'Software development services',
    defaultDetailedInvoice: patch.defaultDetailedInvoice ?? template?.defaultDetailedInvoice ?? true,
    defaultDetailedTimeLog: patch.defaultDetailedTimeLog ?? template?.defaultDetailedTimeLog ?? true,
    createdAt: now,
    updatedAt: now,
  });

  await db
    .prepare(
      `INSERT INTO clients (
         id, slug, name, address, colour, invoice_period_day, invoice_prefix, invoice_start_seq,
         invoice_start_month, period_label_mode, currency, hourly_rate, rounding_mode,
         rounding_increment, invoice_footer, summary_service_description,
         default_detailed_invoice, default_detailed_time_log, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    )
    .bind(client.id, ...clientBindings(client).slice(0, 17), client.createdAt, client.updatedAt)
    .run();
  return client;
}

export async function updateClient(
  db: D1Database,
  id: string,
  patch: Partial<Client>,
  now: number,
): Promise<Client> {
  const existing = await getClient(db, id);
  if (!existing) throw new HttpError(404, 'Client not found');

  const merged = validateClient({ ...existing, ...patch, id, updatedAt: now }, existing);
  if (merged.slug !== existing.slug) await assertSlugFree(db, merged.slug, id);

  await db.prepare(`UPDATE clients SET ${CLIENT_COLUMNS} WHERE id = ?`).bind(...clientBindings(merged), id).run();
  return merged;
}

/** Pick a colour for a new client that is unlikely to clash with the last one. */
function nextColour(previous?: string): string {
  const palette = ['#2563eb', '#059669', '#d97706', '#7c3aed', '#db2777', '#0891b2'];
  const i = previous ? palette.indexOf(previous) : -1;
  return palette[(i + 1) % palette.length];
}

/**
 * Entries that overlap [from, to). A running entry is included whenever it
 * started before `to`, since its open end always reaches the present.
 */
export async function listEntries(
  db: D1Database,
  from: number,
  to: number,
  clientId?: string,
): Promise<Entry[]> {
  const { results } = await db
    .prepare(
      `SELECT * FROM entries
       WHERE started_at < ? AND (ended_at IS NULL OR ended_at > ?)
         AND (? = '' OR client_id = ?)
       ORDER BY started_at ASC`,
    )
    .bind(to, from, clientId ?? '', clientId ?? '')
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
export async function startEntry(
  db: D1Database,
  clientId: string,
  description: string,
  now: number,
): Promise<Entry> {
  await db
    .prepare('UPDATE entries SET ended_at = ?, updated_at = ? WHERE ended_at IS NULL')
    .bind(now, now)
    .run();

  const entry: Entry = {
    id: crypto.randomUUID(),
    clientId,
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
      `INSERT INTO entries (id, client_id, description, started_at, ended_at, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?)`,
    )
    .bind(
      entry.id, entry.clientId, entry.description, entry.startedAt, entry.endedAt,
      entry.createdAt, entry.updatedAt,
    )
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
  patch: { clientId?: string; description?: string; startedAt?: number; endedAt?: number | null },
  now: number,
): Promise<Entry> {
  const existing = await getEntry(db, id);
  if (!existing) throw new HttpError(404, 'Entry not found');

  if (patch.clientId !== undefined && patch.clientId !== existing.clientId) {
    if (!(await getClient(db, patch.clientId))) throw new HttpError(400, 'Unknown client');
  }

  const next: Entry = {
    ...existing,
    clientId: patch.clientId ?? existing.clientId,
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
    .prepare(
      'UPDATE entries SET client_id = ?, description = ?, started_at = ?, ended_at = ?, updated_at = ? WHERE id = ?',
    )
    .bind(next.clientId, next.description, next.startedAt, next.endedAt, next.updatedAt, id)
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
export async function suggestDescriptions(
  db: D1Database,
  query: string,
  clientId: string | null,
  limit = 8,
): Promise<string[]> {
  const trimmed = query.trim();
  const like = `%${trimmed.replace(/[\\%_]/g, (c) => `\\${c}`)}%`;
  // Scoped to one client when given: what you typed for this client last week is
  // a far better suggestion than something from a different engagement.
  const { results } = await db
    .prepare(
      `SELECT description, MAX(started_at) AS last_used
       FROM entries
       WHERE description != '' AND (? = '' OR description LIKE ? ESCAPE '\\')
         AND (? = '' OR client_id = ?)
       GROUP BY description
       ORDER BY last_used DESC
       LIMIT ?`,
    )
    .bind(trimmed, like, clientId ?? '', clientId ?? '', limit)
    .all<{ description: string }>();
  return results.map((r) => r.description);
}

interface ExtraRow {
  id: string;
  client_id: string;
  period_key: string;
  description: string;
  amount: number;
  created_at: number;
  updated_at: number;
}

function rowToExtra(row: ExtraRow): InvoiceExtra {
  return {
    id: row.id,
    clientId: row.client_id,
    periodKey: row.period_key,
    description: row.description,
    amount: row.amount,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

/** Hand-entered line items for one invoice period, oldest first. */
export async function listExtras(
  db: D1Database,
  clientId: string,
  periodKey: string,
): Promise<InvoiceExtra[]> {
  const { results } = await db
    .prepare(
      'SELECT * FROM invoice_extras WHERE client_id = ? AND period_key = ? ORDER BY created_at ASC, id ASC',
    )
    .bind(clientId, periodKey)
    .all<ExtraRow>();
  return results.map(rowToExtra);
}

/**
 * Every extra, grouped by period key.
 *
 * The invoice list needs all of them at once to show correct totals; at personal
 * scale that is one small query rather than one per period.
 */
export async function listAllExtras(
  db: D1Database,
  clientId: string,
): Promise<Map<string, InvoiceExtra[]>> {
  const { results } = await db
    .prepare('SELECT * FROM invoice_extras WHERE client_id = ? ORDER BY created_at ASC, id ASC')
    .bind(clientId)
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
  clientId: string,
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
    clientId,
    periodKey,
    description: trimmed,
    amount: Math.round(amount * 100) / 100,
    createdAt: now,
    updatedAt: now,
  };
  await db
    .prepare(
      `INSERT INTO invoice_extras (id, client_id, period_key, description, amount, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?)`,
    )
    .bind(
      extra.id, extra.clientId, extra.periodKey, extra.description, extra.amount,
      extra.createdAt, extra.updatedAt,
    )
    .run();
  return extra;
}

export async function deleteExtra(
  db: D1Database,
  clientId: string,
  periodKey: string,
  id: string,
): Promise<boolean> {
  // Scoped by client and period as well as id, so a stale form cannot reach
  // another invoice's line item — or another client's.
  const res = await db
    .prepare('DELETE FROM invoice_extras WHERE id = ? AND client_id = ? AND period_key = ?')
    .bind(id, clientId, periodKey)
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
