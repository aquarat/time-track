-- Time Track schema.
--
-- Instants are stored as UTC epoch milliseconds; all calendar grouping happens
-- at render time in the configured IANA timezone.
--
-- New schema changes go in new numbered files beside this one
-- (`bunx wrangler d1 migrations create time-track <name>`). Never edit this file
-- once a database has applied it: wrangler records migrations by filename and
-- will not re-run it.

-- Single-row settings: what belongs to you rather than to a client. The CHECK
-- keeps it a singleton.
CREATE TABLE IF NOT EXISTS settings (
  id                          INTEGER PRIMARY KEY CHECK (id = 1),
  timezone                    TEXT    NOT NULL DEFAULT 'UTC',

  -- Legacy single-client columns, from before clients had their own table.
  -- Nothing reads them; they are kept so every instance has the same schema.
  invoice_period_day          INTEGER NOT NULL DEFAULT 26,
  invoice_prefix              TEXT    NOT NULL DEFAULT '',
  invoice_start_seq           INTEGER NOT NULL DEFAULT 1,
  invoice_start_month         TEXT    NOT NULL DEFAULT '2026-01',
  period_label_mode           TEXT    NOT NULL DEFAULT 'start',

  logo_data_url               TEXT    NOT NULL DEFAULT '',
  company_name                TEXT    NOT NULL DEFAULT '',
  company_address             TEXT    NOT NULL DEFAULT '',

  -- Legacy (see above).
  client_name                 TEXT    NOT NULL DEFAULT '',
  client_address              TEXT    NOT NULL DEFAULT '',
  currency                    TEXT    NOT NULL DEFAULT 'USD',
  hourly_rate                 REAL    NOT NULL DEFAULT 0,
  invoice_footer              TEXT    NOT NULL DEFAULT '',
  rounding_mode               TEXT    NOT NULL DEFAULT 'exact',
  rounding_increment          INTEGER NOT NULL DEFAULT 15,

  updated_at                  INTEGER NOT NULL DEFAULT 0,

  -- Legacy (see above).
  default_detailed_invoice    INTEGER NOT NULL DEFAULT 1,
  default_detailed_time_log   INTEGER NOT NULL DEFAULT 1,
  summary_service_description TEXT    NOT NULL DEFAULT 'Software development services',

  -- Which client new time entries and the invoice list default to.
  default_client_id           TEXT    NOT NULL DEFAULT ''
);

-- One row per billable client. Each client numbers its invoices independently.
CREATE TABLE IF NOT EXISTS clients (
  id                          TEXT PRIMARY KEY,
  -- URL segment: /invoice/<slug>/2026-05. Editable, but changing it breaks
  -- links to invoices already sent.
  slug                        TEXT    NOT NULL UNIQUE,
  name                        TEXT    NOT NULL,
  address                     TEXT    NOT NULL DEFAULT '',
  -- Distinguishes this client's blocks in the calendar.
  colour                      TEXT    NOT NULL DEFAULT '#2563eb',

  -- Invoice series.
  invoice_period_day          INTEGER NOT NULL DEFAULT 26,
  invoice_prefix              TEXT    NOT NULL DEFAULT '',
  invoice_start_seq           INTEGER NOT NULL DEFAULT 1,
  invoice_start_month         TEXT    NOT NULL DEFAULT '2026-01',   -- YYYY-MM
  period_label_mode           TEXT    NOT NULL DEFAULT 'start',     -- 'start' | 'end'

  -- Billing terms.
  currency                    TEXT    NOT NULL DEFAULT 'GBP',
  hourly_rate                 REAL    NOT NULL DEFAULT 0,
  rounding_mode               TEXT    NOT NULL DEFAULT 'exact',     -- exact|up|down|nearest
  rounding_increment          INTEGER NOT NULL DEFAULT 15,          -- minutes

  -- Document.
  invoice_footer              TEXT    NOT NULL DEFAULT '',
  summary_service_description TEXT    NOT NULL DEFAULT 'Software development services',
  -- Default layout of the rendered invoice. Overridable per invoice via query
  -- parameters, which are deliberately not persisted.
  default_detailed_invoice    INTEGER NOT NULL DEFAULT 1,
  default_detailed_time_log   INTEGER NOT NULL DEFAULT 1,

  created_at                  INTEGER NOT NULL,
  updated_at                  INTEGER NOT NULL
);

-- Time entries.
CREATE TABLE IF NOT EXISTS entries (
  id          TEXT PRIMARY KEY,
  description TEXT    NOT NULL DEFAULT '',
  started_at  INTEGER NOT NULL,
  ended_at    INTEGER,              -- NULL means the timer is still running
  created_at  INTEGER NOT NULL,
  updated_at  INTEGER NOT NULL,
  client_id   TEXT    NOT NULL DEFAULT ''
);

CREATE INDEX IF NOT EXISTS idx_entries_started_at ON entries (started_at DESC);
-- Partial index so "is a timer running?" stays a point lookup.
CREATE INDEX IF NOT EXISTS idx_entries_running ON entries (ended_at) WHERE ended_at IS NULL;
CREATE INDEX IF NOT EXISTS idx_entries_client_started ON entries (client_id, started_at DESC);

-- Hand-entered line items belonging to one invoice period: expenses, licences,
-- a fixed-fee item, a discount. Unlike tracked time these are entered directly
-- and are the only thing about an invoice that is stored rather than derived.
--
-- Keyed by period_key ("YYYY-MM"), the same identifier the invoice URL uses.
-- That key's meaning depends on the period day and naming convention, so
-- changing either re-points existing items at a different date range — the same
-- caveat that already applies to invoice numbering.
CREATE TABLE IF NOT EXISTS invoice_extras (
  id          TEXT    PRIMARY KEY,
  period_key  TEXT    NOT NULL,
  description TEXT    NOT NULL,
  amount      REAL    NOT NULL,
  created_at  INTEGER NOT NULL,
  updated_at  INTEGER NOT NULL,
  client_id   TEXT    NOT NULL DEFAULT ''
);

CREATE INDEX IF NOT EXISTS idx_invoice_extras_period
  ON invoice_extras (period_key, created_at);
CREATE INDEX IF NOT EXISTS idx_invoice_extras_client_period
  ON invoice_extras (client_id, period_key);

-- A fresh instance starts with the settings row and one unnamed client, which is
-- the default. Name it on the Clients page. The id is a fixed literal because
-- SQLite cannot generate one; later clients get a crypto.randomUUID().
INSERT OR IGNORE INTO clients (
  id, slug, name, currency, created_at, updated_at
) VALUES (
  '00000000-0000-4000-8000-000000000001', 'client', '', 'USD', 0, 0
);

INSERT OR IGNORE INTO settings (id, updated_at, default_client_id)
VALUES (1, 0, '00000000-0000-4000-8000-000000000001');
