-- Default layout for the rendered invoice document. Both are overridable per
-- invoice via query parameters, which are deliberately not persisted.
ALTER TABLE settings ADD COLUMN default_detailed_invoice INTEGER NOT NULL DEFAULT 1;
ALTER TABLE settings ADD COLUMN default_detailed_time_log INTEGER NOT NULL DEFAULT 1;
