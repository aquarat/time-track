-- Multiple clients.
--
-- Deliberately additive: no column is dropped and no existing row is rewritten
-- beyond the client_id backfill. The client-specific columns on `settings`
-- (client_name, hourly_rate, invoice_prefix, …) are left in place, unread by the
-- new code, so the previous Worker version keeps working against this schema.
-- That makes `wrangler rollback` a complete rollback and leaves no schema change
-- to undo. A later migration can drop them once this has proven itself.

CREATE TABLE IF NOT EXISTS clients (
  id                          TEXT PRIMARY KEY,
  -- URL segment: /invoice/<slug>/2026-05. Editable, but changing it breaks
  -- links to invoices already sent.
  slug                        TEXT    NOT NULL UNIQUE,
  name                        TEXT    NOT NULL,
  address                     TEXT    NOT NULL DEFAULT '',
  -- Distinguishes this client's blocks in the calendar.
  colour                      TEXT    NOT NULL DEFAULT '#2563eb',

  -- Invoice series. Each client numbers independently.
  invoice_period_day          INTEGER NOT NULL DEFAULT 26,
  invoice_prefix              TEXT    NOT NULL DEFAULT '',
  invoice_start_seq           INTEGER NOT NULL DEFAULT 1,
  invoice_start_month         TEXT    NOT NULL DEFAULT '2026-01',
  period_label_mode           TEXT    NOT NULL DEFAULT 'start',

  -- Billing terms.
  currency                    TEXT    NOT NULL DEFAULT 'GBP',
  hourly_rate                 REAL    NOT NULL DEFAULT 0,
  rounding_mode               TEXT    NOT NULL DEFAULT 'exact',
  rounding_increment          INTEGER NOT NULL DEFAULT 15,

  -- Document.
  invoice_footer              TEXT    NOT NULL DEFAULT '',
  summary_service_description TEXT    NOT NULL DEFAULT 'Software development services',
  default_detailed_invoice    INTEGER NOT NULL DEFAULT 1,
  default_detailed_time_log   INTEGER NOT NULL DEFAULT 1,

  created_at                  INTEGER NOT NULL,
  updated_at                  INTEGER NOT NULL
);

-- Seed the existing client from the current settings row so nothing about the
-- live invoice series changes: same name, prefix, sequence, start month, rate,
-- currency and rounding. The id is a fixed literal because SQLite cannot
-- generate one; later clients get a crypto.randomUUID() from the Worker.
INSERT OR IGNORE INTO clients (
  id, slug, name, address, colour,
  invoice_period_day, invoice_prefix, invoice_start_seq, invoice_start_month, period_label_mode,
  currency, hourly_rate, rounding_mode, rounding_increment,
  invoice_footer, summary_service_description,
  default_detailed_invoice, default_detailed_time_log,
  created_at, updated_at
)
SELECT
  '00000000-0000-4000-8000-000000000001',
  -- "Acme Widgets (Pty) Ltd." -> "acme-widgets-pty-ltd". Crude, and meant to be
  -- tidied by hand on the Clients page; a bad auto-slug should not be permanent.
  CASE
    WHEN trim(name_slug) = '' THEN 'client'
    ELSE trim(name_slug, '-')
  END,
  client_name,
  client_address,
  '#2563eb',
  invoice_period_day, invoice_prefix, invoice_start_seq, invoice_start_month, period_label_mode,
  currency, hourly_rate, rounding_mode, rounding_increment,
  invoice_footer, summary_service_description,
  default_detailed_invoice, default_detailed_time_log,
  updated_at, updated_at
FROM (
  SELECT
    *,
    replace(replace(replace(replace(replace(replace(replace(
      lower(client_name),
      '.', ''), ',', ''), '(', ''), ')', ''), '/', '-'), ' ', '-'), '--', '-') AS name_slug
  FROM settings WHERE id = 1
);

-- Which client new time entries and the invoice list default to.
ALTER TABLE settings ADD COLUMN default_client_id TEXT NOT NULL DEFAULT '';
UPDATE settings SET default_client_id = '00000000-0000-4000-8000-000000000001' WHERE id = 1;

-- SQLite cannot add a NOT NULL column with a computed default, so add with a
-- blank default and backfill. Every existing entry belongs to the seeded client.
ALTER TABLE entries ADD COLUMN client_id TEXT NOT NULL DEFAULT '';
UPDATE entries SET client_id = '00000000-0000-4000-8000-000000000001' WHERE client_id = '';

ALTER TABLE invoice_extras ADD COLUMN client_id TEXT NOT NULL DEFAULT '';
UPDATE invoice_extras SET client_id = '00000000-0000-4000-8000-000000000001' WHERE client_id = '';

CREATE INDEX IF NOT EXISTS idx_entries_client_started ON entries (client_id, started_at DESC);
CREATE INDEX IF NOT EXISTS idx_invoice_extras_client_period ON invoice_extras (client_id, period_key);
