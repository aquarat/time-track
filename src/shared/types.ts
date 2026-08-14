export type RoundingMode = 'exact' | 'up' | 'down' | 'nearest';
export type PeriodLabelMode = 'start' | 'end';

export interface Entry {
  id: string;
  clientId: string;
  description: string;
  startedAt: number;
  /** null while the timer is running. */
  endedAt: number | null;
  createdAt: number;
  updatedAt: number;
}

/**
 * One billable client: who they are, how their invoices are numbered, and on
 * what terms. Each client's invoice series is independent of every other.
 */
export interface Client {
  id: string;
  /** URL segment. Editable, but changing it breaks links to sent invoices. */
  slug: string;
  name: string;
  address: string;
  /** Distinguishes this client's blocks in the calendar. */
  colour: string;

  invoicePeriodDay: number;
  invoicePrefix: string;
  invoiceStartSeq: number;
  /** "YYYY-MM" */
  invoiceStartMonth: string;
  periodLabelMode: PeriodLabelMode;

  currency: string;
  hourlyRate: number;
  roundingMode: RoundingMode;
  roundingIncrement: number;

  invoiceFooter: string;
  /** Wording of the single line on a summary invoice. */
  summaryServiceDescription: string;
  /** Starting state of the "Detailed invoice" toggle on the invoice document. */
  defaultDetailedInvoice: boolean;
  /** Starting state of the "Detailed time log" toggle on the invoice document. */
  defaultDetailedTimeLog: boolean;

  createdAt: number;
  updatedAt: number;
}

/** Settings that belong to you rather than to any one client. */
export interface Settings {
  timezone: string;
  logoDataUrl: string;
  companyName: string;
  companyAddress: string;
  /** Which client new time entries and the invoice list default to. */
  defaultClientId: string;
  updatedAt: number;
}

/**
 * Everything one invoice needs, assembled from the global settings plus one
 * client.
 *
 * A flat merge rather than passing both objects around: the field names are the
 * ones the invoice maths and the document renderer already used when there was a
 * single client, so those modules did not have to be rewritten to gain clients.
 * Build it with `invoiceConfig()` — never by hand.
 */
export interface InvoiceConfig {
  timezone: string;

  invoicePeriodDay: number;
  invoicePrefix: string;
  invoiceStartSeq: number;
  invoiceStartMonth: string;
  periodLabelMode: PeriodLabelMode;

  logoDataUrl: string;
  companyName: string;
  companyAddress: string;
  clientName: string;
  clientAddress: string;

  currency: string;
  hourlyRate: number;
  invoiceFooter: string;
  summaryServiceDescription: string;

  roundingMode: RoundingMode;
  roundingIncrement: number;

  defaultDetailedInvoice: boolean;
  defaultDetailedTimeLog: boolean;

  /** Carried through so a rendered invoice can link back to its client. */
  clientId: string;
  clientSlug: string;
}

/**
 * How one rendering of an invoice is laid out.
 *
 * Chosen per render and never stored — the document is always reproducible from
 * the settings plus the URL that produced it.
 */
export interface InvoiceLayout {
  /** false collapses every line item into a single summary line. */
  detailedInvoice: boolean;
  /** false omits the day-by-day log entirely. */
  detailedTimeLog: boolean;
}

export interface Period {
  /** Stable identifier used in URLs, e.g. "2026-01". */
  key: string;
  /** e.g. "January 2026" */
  label: string;
  /** Inclusive, UTC epoch ms. */
  startUtc: number;
  /** Exclusive, UTC epoch ms. */
  endUtc: number;
  sequence: number;
  invoiceNumber: string;
}

/**
 * A line entered by hand against one invoice period.
 *
 * The only part of an invoice that is stored rather than derived from tracked
 * time, so it carries its own amount and no hours.
 */
export interface InvoiceExtra {
  id: string;
  clientId: string;
  periodKey: string;
  description: string;
  amount: number;
  createdAt: number;
  updatedAt: number;
}

export interface InvoiceLine {
  description: string;
  /** Sum of raw tracked seconds before rounding. */
  rawSeconds: number;
  /** Seconds after the configured rounding rule is applied. */
  billedSeconds: number;
  billedHours: number;
  amount: number;
}

export interface InvoiceDayDetail {
  /** "YYYY-MM-DD" in the configured timezone. */
  date: string;
  entries: { description: string; startedAt: number; endedAt: number; seconds: number }[];
  seconds: number;
}

export interface Invoice {
  period: Period;
  config: InvoiceConfig;
  lines: InvoiceLine[];
  details: InvoiceDayDetail[];
  extras: InvoiceExtra[];
  rawSeconds: number;
  billedSeconds: number;
  billedHours: number;
  /** Time-based lines only. */
  total: number;
  extrasTotal: number;
  /** What is actually owed: time plus extras. */
  grandTotal: number;
  /** True when the period has not finished yet. */
  inProgress: boolean;
  /** True when a timer is still running inside this period. */
  hasRunningEntry: boolean;
}

export interface PeriodSummary extends Period {
  rawSeconds: number;
  billedSeconds: number;
  billedHours: number;
  /** Time-based lines only. */
  total: number;
  extrasTotal: number;
  extrasCount: number;
  /** What is actually owed: time plus extras. */
  grandTotal: number;
  inProgress: boolean;
  entryCount: number;
}
