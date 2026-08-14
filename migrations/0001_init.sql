-- Time entries. Instants are stored as UTC epoch milliseconds; all calendar
-- grouping happens at render time in the user's configured timezone.
CREATE TABLE IF NOT EXISTS entries (
  id          TEXT PRIMARY KEY,
  description TEXT    NOT NULL DEFAULT '',
  started_at  INTEGER NOT NULL,
  ended_at    INTEGER,              -- NULL means the timer is still running
  created_at  INTEGER NOT NULL,
  updated_at  INTEGER NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_entries_started_at ON entries (started_at DESC);
-- Partial index so "is a timer running?" stays a point lookup.
CREATE INDEX IF NOT EXISTS idx_entries_running ON entries (ended_at) WHERE ended_at IS NULL;

-- Single-row settings table. The CHECK keeps it a singleton.
CREATE TABLE IF NOT EXISTS settings (
  id                    INTEGER PRIMARY KEY CHECK (id = 1),
  timezone              TEXT    NOT NULL DEFAULT 'UTC',

  invoice_period_day    INTEGER NOT NULL DEFAULT 26,
  invoice_prefix        TEXT    NOT NULL DEFAULT '',
  invoice_start_seq     INTEGER NOT NULL DEFAULT 1,
  invoice_start_month   TEXT    NOT NULL DEFAULT '2026-01',   -- YYYY-MM
  period_label_mode     TEXT    NOT NULL DEFAULT 'start',     -- 'start' | 'end'

  logo_data_url         TEXT    NOT NULL DEFAULT '',
  company_name          TEXT    NOT NULL DEFAULT '',
  company_address       TEXT    NOT NULL DEFAULT '',
  client_name           TEXT    NOT NULL DEFAULT '',
  client_address        TEXT    NOT NULL DEFAULT '',

  currency              TEXT    NOT NULL DEFAULT 'USD',
  hourly_rate           REAL    NOT NULL DEFAULT 0,
  invoice_footer        TEXT    NOT NULL DEFAULT '',

  rounding_mode         TEXT    NOT NULL DEFAULT 'exact',     -- exact|up|down|nearest
  rounding_increment    INTEGER NOT NULL DEFAULT 15,          -- minutes

  updated_at            INTEGER NOT NULL DEFAULT 0
);

INSERT OR IGNORE INTO settings (id, updated_at) VALUES (1, 0);
