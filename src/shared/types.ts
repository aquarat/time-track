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

  roundingMode: RoundingMode;
  roundingIncrement: number;

  updatedAt: number;
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
  rawSeconds: number;
  billedSeconds: number;
  billedHours: number;
  total: number;
  /** True when the period has not finished yet. */
  inProgress: boolean;
  /** True when a timer is still running inside this period. */
  hasRunningEntry: boolean;
}

export interface PeriodSummary extends Period {
  rawSeconds: number;
  billedSeconds: number;
  billedHours: number;
  total: number;
  inProgress: boolean;
  entryCount: number;
}
