export type RoundingMode = 'exact' | 'up' | 'down' | 'nearest';
export type PeriodLabelMode = 'start' | 'end';

export interface Entry {
  id: string;
  description: string;
  startedAt: number;
  /** null while the timer is running. */
  endedAt: number | null;
  createdAt: number;
  updatedAt: number;
}

export interface Settings {
  timezone: string;

  invoicePeriodDay: number;
  invoicePrefix: string;
  invoiceStartSeq: number;
  /** "YYYY-MM" */
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
  /** Wording of the single line on a summary invoice. */
  summaryServiceDescription: string;

  roundingMode: RoundingMode;
  roundingIncrement: number;

  /** Starting state of the "Detailed invoice" toggle on the invoice document. */
  defaultDetailedInvoice: boolean;
  /** Starting state of the "Detailed time log" toggle on the invoice document. */
  defaultDetailedTimeLog: boolean;

  updatedAt: number;
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
  settings: Settings;
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
