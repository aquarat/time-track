-- Wording of the single line on a summary invoice.
ALTER TABLE settings ADD COLUMN summary_service_description TEXT NOT NULL
  DEFAULT 'Software development services';

-- Ad-hoc line items belonging to one invoice period: expenses, licences, a
-- fixed-fee item, a discount. Unlike tracked time these are entered directly and
-- are the only thing about an invoice that is stored rather than derived.
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
  updated_at  INTEGER NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_invoice_extras_period
  ON invoice_extras (period_key, created_at);
