/**
 * Toggl Track CSV export parsing.
 *
 * A Toggl export records naive wall-clock times with no offset — "2026-08-13",
 * "14:42:09" and nothing else — so the file cannot be interpreted without being
 * told which timezone those clocks were read in. Every function here takes that
 * zone explicitly rather than assuming the server's or the browser's.
 */

import { fromZonedParts } from './time';

export interface TogglRow {
  /** 1-based line number in the source file, for error reporting. */
  line: number;
  description: string;
  client: string;
  project: string;
  billable: boolean;
  startedAt: number;
  endedAt: number;
  /** Seconds, as stated by the file's own Duration column. */
  statedSeconds: number;
}

export interface RowProblem {
  line: number;
  reason: string;
  raw: string;
}

export interface ParseResult {
  rows: TogglRow[];
  problems: RowProblem[];
  /** Header names as they appeared, for diagnostics. */
  columns: string[];
}

/**
 * RFC 4180 CSV reader.
 *
 * Written out rather than split(',') because Toggl descriptions routinely
 * contain commas ("Payment gateway work, testing, TICKET-122") and may contain
 * escaped quotes or newlines.
 */
export function parseCsv(text: string): string[][] {
  // Strip a UTF-8 BOM; Toggl prefixes one and it otherwise corrupts the first header.
  const input = text.charCodeAt(0) === 0xfeff ? text.slice(1) : text;

  const rows: string[][] = [];
  let row: string[] = [];
  let field = '';
  let quoted = false;
  let i = 0;

  const endField = () => {
    row.push(field);
    field = '';
  };
  const endRow = () => {
    endField();
    // Ignore the blank row a trailing newline produces.
    if (!(row.length === 1 && row[0] === '')) rows.push(row);
    row = [];
  };

  while (i < input.length) {
    const c = input[i];

    if (quoted) {
      if (c === '"') {
        if (input[i + 1] === '"') {
          field += '"';
          i += 2;
          continue;
        }
        quoted = false;
        i++;
        continue;
      }
      field += c;
      i++;
      continue;
    }

    if (c === '"') {
      quoted = true;
      i++;
    } else if (c === ',') {
      endField();
      i++;
    } else if (c === '\r') {
      // Swallow CRLF as a single terminator.
      if (input[i + 1] === '\n') i++;
      endRow();
      i++;
    } else if (c === '\n') {
      endRow();
      i++;
    } else {
      field += c;
      i++;
    }
  }

  if (field !== '' || row.length > 0) endRow();
  return rows;
}

/** Find a column by any of several accepted header spellings. */
function columnIndex(header: string[], ...names: string[]): number {
  const normalised = header.map((h) => h.trim().toLowerCase());
  for (const name of names) {
    const i = normalised.indexOf(name.toLowerCase());
    if (i !== -1) return i;
  }
  return -1;
}

const DATE_RE = /^(\d{4})-(\d{2})-(\d{2})$/;
const TIME_RE = /^(\d{1,2}):(\d{2})(?::(\d{2}))?$/;
const DURATION_RE = /^(\d+):(\d{2}):(\d{2})$/;

function parseDateTime(date: string, time: string, tz: string): number | null {
  const d = DATE_RE.exec(date.trim());
  const t = TIME_RE.exec(time.trim());
  if (!d || !t) return null;
  const hour = Number(t[1]);
  const minute = Number(t[2]);
  const second = t[3] ? Number(t[3]) : 0;
  if (hour > 23 || minute > 59 || second > 59) return null;
  return fromZonedParts(Number(d[1]), Number(d[2]), Number(d[3]), hour, minute, second, tz);
}

/** "03:36:55" → 13015 seconds. Hours may exceed 24. */
function parseDuration(value: string): number | null {
  const m = DURATION_RE.exec(value.trim());
  if (!m) return null;
  return Number(m[1]) * 3600 + Number(m[2]) * 60 + Number(m[3]);
}

/**
 * Parse a Toggl export into entry drafts.
 *
 * Rows that cannot be understood are collected as problems rather than throwing,
 * so one malformed line never costs the user the rest of the file.
 */
export function parseTogglCsv(text: string, timezone: string): ParseResult {
  const table = parseCsv(text);
  if (table.length === 0) {
    return { rows: [], problems: [{ line: 0, reason: 'File is empty', raw: '' }], columns: [] };
  }

  const header = table[0];
  const iDesc = columnIndex(header, 'Description');
  const iStartDate = columnIndex(header, 'Start date');
  const iStartTime = columnIndex(header, 'Start time');
  const iEndDate = columnIndex(header, 'End date');
  const iEndTime = columnIndex(header, 'End time');
  const iDuration = columnIndex(header, 'Duration');
  const iBillable = columnIndex(header, 'Billable');
  const iClient = columnIndex(header, 'Client');
  const iProject = columnIndex(header, 'Project');

  const missing: string[] = [];
  if (iStartDate === -1) missing.push('Start date');
  if (iStartTime === -1) missing.push('Start time');
  if (iEndDate === -1) missing.push('End date');
  if (iEndTime === -1) missing.push('End time');
  if (missing.length > 0) {
    return {
      rows: [],
      problems: [
        {
          line: 1,
          reason: `Not a recognised Toggl export — missing column(s): ${missing.join(', ')}`,
          raw: header.join(','),
        },
      ],
      columns: header,
    };
  }

  const rows: TogglRow[] = [];
  const problems: RowProblem[] = [];

  for (let r = 1; r < table.length; r++) {
    const cells = table[r];
    const line = r + 1;
    const raw = cells.join(',');

    // A short row is usually a stray newline rather than real data.
    if (cells.length < header.length && cells.every((c) => c.trim() === '')) continue;

    const startedAt = parseDateTime(cells[iStartDate] ?? '', cells[iStartTime] ?? '', timezone);
    const endedAt = parseDateTime(cells[iEndDate] ?? '', cells[iEndTime] ?? '', timezone);

    if (startedAt === null) {
      problems.push({ line, reason: 'Unreadable start date/time', raw });
      continue;
    }
    if (endedAt === null) {
      problems.push({ line, reason: 'Unreadable end date/time', raw });
      continue;
    }
    if (endedAt < startedAt) {
      problems.push({ line, reason: 'Entry ends before it starts', raw });
      continue;
    }

    const stated = iDuration === -1 ? null : parseDuration(cells[iDuration] ?? '');
    const measured = Math.round((endedAt - startedAt) / 1000);

    // A disagreement means the row's clocks and its own duration describe
    // different things — most often an export made across a DST change.
    if (stated !== null && Math.abs(stated - measured) > 1) {
      problems.push({
        line,
        reason: `Duration column says ${stated}s but the timestamps span ${measured}s`,
        raw,
      });
      continue;
    }

    rows.push({
      line,
      description: (cells[iDesc] ?? '').trim(),
      client: iClient === -1 ? '' : (cells[iClient] ?? '').trim(),
      project: iProject === -1 ? '' : (cells[iProject] ?? '').trim(),
      // Anything other than an explicit "No" counts as billable.
      billable: iBillable === -1 ? true : (cells[iBillable] ?? '').trim().toLowerCase() !== 'no',
      startedAt,
      endedAt,
      statedSeconds: stated ?? measured,
    });
  }

  return { rows, problems, columns: header };
}

/** How an import distributes across one invoice period. */
export interface PeriodImpact {
  key: string;
  label: string;
  invoiceNumber: string;
  seconds: number;
  entries: number;
}

/**
 * The outcome of an import, whether previewed or committed.
 *
 * Lives in shared rather than in the Worker so the client renders the exact
 * shape the server produces.
 */
export interface ImportReport {
  timezone: string;
  parsed: number;
  /** Rows that would be written. */
  toImport: number;
  duplicates: number;
  nonBillableSkipped: number;
  nonBillableIncluded: number;
  blankDescriptions: number;
  problems: RowProblem[];
  totalSeconds: number;
  firstDate: string | null;
  lastDate: string | null;
  distinctDescriptions: number;
  /** Imported entries overlapping another entry, existing or incoming. */
  overlaps: number;
  periods: PeriodImpact[];
  sample: { description: string; startedAt: number; endedAt: number }[];
  committed: boolean;
  imported: number;
}

/**
 * Identity of a time entry for duplicate detection.
 *
 * Start instant, end instant and description together. Toggl start times carry
 * second precision, so collisions between genuinely distinct entries are
 * effectively impossible, while re-importing the same file matches exactly.
 */
export function entryFingerprint(startedAt: number, endedAt: number | null, description: string): string {
  return `${startedAt}|${endedAt ?? 'running'}|${description.trim()}`;
}
