/**
 * Invoice derivation.
 *
 * The whole point of this app: an invoice is a pure function of (config, entries).
 * Nothing about an invoice is stored or chosen per-run — the period boundaries, the
 * sequence number and the rounding all fall out of the config, so the same month
 * always produces the same document.
 */

import type {
  Client,
  Entry,
  Invoice,
  InvoiceConfig,
  InvoiceDayDetail,
  InvoiceExtra,
  InvoiceLine,
  Period,
  PeriodSummary,
  RoundingMode,
  Settings,
} from './types';
import {
  addMonths,
  dateKey,
  daysInMonth,
  formatLongDate,
  fromZonedParts,
  monthKey,
  monthLabel,
  parseMonthKey,
} from './time';

/**
 * Merge the global settings with one client into the flat shape the invoice
 * maths and the document renderer consume.
 */
export function invoiceConfig(settings: Settings, client: Client): InvoiceConfig {
  return {
    timezone: settings.timezone,

    invoicePeriodDay: client.invoicePeriodDay,
    invoicePrefix: client.invoicePrefix,
    invoiceStartSeq: client.invoiceStartSeq,
    invoiceStartMonth: client.invoiceStartMonth,
    periodLabelMode: client.periodLabelMode,

    logoDataUrl: settings.logoDataUrl,
    companyName: settings.companyName,
    companyAddress: settings.companyAddress,
    clientName: client.name,
    clientAddress: client.address,

    currency: client.currency,
    hourlyRate: client.hourlyRate,
    invoiceFooter: client.invoiceFooter,
    summaryServiceDescription: client.summaryServiceDescription,

    roundingMode: client.roundingMode,
    roundingIncrement: client.roundingIncrement,

    defaultDetailedInvoice: client.defaultDetailedInvoice,
    defaultDetailedTimeLog: client.defaultDetailedTimeLog,

    clientId: client.id,
    clientSlug: client.slug,
  };
}

export const NO_DESCRIPTION = '(no description)';

/**
 * Midnight on the invoice cut-over day of a given month, in `tz`.
 *
 * A period day past the end of a short month clamps to that month's last day, so
 * a cut-over of the 31st still produces exactly one period per month.
 */
function cutover(year: number, month: number, periodDay: number, tz: string): number {
  const day = Math.min(Math.max(1, periodDay), daysInMonth(year, month));
  return fromZonedParts(year, month, day, 0, 0, 0, tz);
}

/**
 * The period at index `i`, counting from the configured starting month.
 *
 * `periodLabelMode` decides which month names a period. Under 'start' (the
 * default) "January 2026" runs 26 Jan → 26 Feb; under 'end' it runs 26 Dec →
 * 26 Jan. Both produce the same set of boundaries, only the labels shift.
 */
export function periodAt(config: InvoiceConfig, i: number): Period {
  const start = parseMonthKey(config.invoiceStartMonth);
  const labelMonth = addMonths(start.year, start.month, i);
  const day = config.invoicePeriodDay;
  const tz = config.timezone;

  const startsAt = config.periodLabelMode === 'end' ? addMonths(labelMonth.year, labelMonth.month, -1) : labelMonth;
  const endsAt = addMonths(startsAt.year, startsAt.month, 1);

  const sequence = config.invoiceStartSeq + i;
  return {
    key: monthKey(labelMonth.year, labelMonth.month),
    label: monthLabel(labelMonth.year, labelMonth.month),
    startUtc: cutover(startsAt.year, startsAt.month, day, tz),
    endUtc: cutover(endsAt.year, endsAt.month, day, tz),
    sequence,
    invoiceNumber: `${config.invoicePrefix}${sequence}`,
  };
}

/**
 * Every period that has begun as of `now`, newest first.
 *
 * A period appears the moment it starts, so the current in-flight period is
 * always listed and always billable-to-date. Capped so a misconfigured start
 * month can't spin.
 */
export function listPeriods(config: InvoiceConfig, now: number): Period[] {
  const out: Period[] = [];
  for (let i = 0; i < 600; i++) {
    const p = periodAt(config, i);
    if (p.startUtc > now) break;
    out.push(p);
  }
  return out.reverse();
}

/** Find a period by its "YYYY-MM" key, or null if it is outside the configured range. */
export function findPeriod(config: InvoiceConfig, key: string, now: number): Period | null {
  const start = parseMonthKey(config.invoiceStartMonth);
  const target = parseMonthKey(key);
  const i = (target.year * 12 + target.month) - (start.year * 12 + start.month);
  if (i < 0) return null;
  const p = periodAt(config, i);
  return p.key === key && p.startUtc <= now ? p : null;
}

export function roundSeconds(seconds: number, mode: RoundingMode, incrementMinutes: number): number {
  if (mode === 'exact') return seconds;
  const step = Math.max(1, Math.round(incrementMinutes)) * 60;
  switch (mode) {
    case 'up':
      return Math.ceil(seconds / step) * step;
    case 'down':
      return Math.floor(seconds / step) * step;
    case 'nearest':
      return Math.round(seconds / step) * step;
  }
}

/** Seconds of an entry that fall inside [from, to). Clips partial overlaps. */
export function secondsInWindow(entry: Entry, from: number, to: number, now: number): number {
  const end = entry.endedAt ?? now;
  const overlap = Math.min(end, to) - Math.max(entry.startedAt, from);
  return overlap > 0 ? overlap / 1000 : 0;
}

function normaliseDescription(description: string): string {
  const trimmed = description.trim();
  return trimmed === '' ? NO_DESCRIPTION : trimmed;
}

/**
 * Build the invoice for a period from the entries that overlap it.
 *
 * Rounding is applied per line item — that is, once per distinct task
 * description — rather than to each individual timer run or to the grand total.
 * Rounding each run would inflate a day of short check-ins; rounding only the
 * total would make the line items fail to add up to the amount charged.
 */
export function buildInvoice(
  period: Period,
  config: InvoiceConfig,
  entries: Entry[],
  now: number,
  extras: InvoiceExtra[] = [],
): Invoice {
  const tz = config.timezone;
  const relevant = entries.filter((e) => secondsInWindow(e, period.startUtc, period.endUtc, now) > 0);

  const byDescription = new Map<string, number>();
  const byDate = new Map<string, InvoiceDayDetail>();
  let hasRunningEntry = false;

  for (const entry of relevant) {
    const seconds = secondsInWindow(entry, period.startUtc, period.endUtc, now);
    const description = normaliseDescription(entry.description);
    byDescription.set(description, (byDescription.get(description) ?? 0) + seconds);

    if (entry.endedAt === null) hasRunningEntry = true;

    const key = dateKey(entry.startedAt, tz);
    let day = byDate.get(key);
    if (!day) {
      day = { date: key, entries: [], seconds: 0 };
      byDate.set(key, day);
    }
    day.entries.push({
      description,
      startedAt: entry.startedAt,
      endedAt: entry.endedAt ?? now,
      seconds,
    });
    day.seconds += seconds;
  }

  const lines: InvoiceLine[] = [...byDescription.entries()]
    .map(([description, rawSeconds]) => {
      const billedSeconds = roundSeconds(rawSeconds, config.roundingMode, config.roundingIncrement);
      const billedHours = billedSeconds / 3600;
      return {
        description,
        rawSeconds,
        billedSeconds,
        billedHours,
        amount: round2(billedHours * config.hourlyRate),
      };
    })
    .sort((a, b) => b.billedSeconds - a.billedSeconds || a.description.localeCompare(b.description));

  const details = [...byDate.values()].sort((a, b) => a.date.localeCompare(b.date));
  for (const day of details) day.entries.sort((a, b) => a.startedAt - b.startedAt);

  const rawSeconds = lines.reduce((sum, l) => sum + l.rawSeconds, 0);
  const billedSeconds = lines.reduce((sum, l) => sum + l.billedSeconds, 0);
  // Summing the line amounts (rather than re-deriving from the total hours)
  // guarantees the printed column adds up to the printed total.
  const total = round2(lines.reduce((sum, l) => sum + l.amount, 0));
  const extrasTotal = round2(extras.reduce((sum, e) => sum + e.amount, 0));

  return {
    period,
    config,
    lines,
    details,
    extras,
    rawSeconds,
    billedSeconds,
    billedHours: billedSeconds / 3600,
    total,
    extrasTotal,
    grandTotal: round2(total + extrasTotal),
    inProgress: period.endUtc > now,
    hasRunningEntry,
  };
}

export function summarisePeriod(
  period: Period,
  config: InvoiceConfig,
  entries: Entry[],
  now: number,
  extras: InvoiceExtra[] = [],
): PeriodSummary {
  const invoice = buildInvoice(period, config, entries, now, extras);
  return {
    ...period,
    rawSeconds: invoice.rawSeconds,
    billedSeconds: invoice.billedSeconds,
    billedHours: invoice.billedHours,
    total: invoice.total,
    extrasTotal: invoice.extrasTotal,
    extrasCount: invoice.extras.length,
    grandTotal: invoice.grandTotal,
    inProgress: invoice.inProgress,
    entryCount: invoice.details.reduce((sum, d) => sum + d.entries.length, 0),
  };
}

/** Fallback wording when the setting has been cleared. */
export const DEFAULT_SUMMARY_SERVICE_DESCRIPTION = 'Software development services';

/**
 * The description on a summary invoice's single line.
 *
 * Uses the period's own boundaries — "26 January 2026 to 26 February 2026" —
 * where the end is the exclusive cut-over, matching how the period is defined
 * rather than the inclusive last day shown in the document header.
 */
export function summaryLineDescription(period: Period, config: InvoiceConfig): string {
  const service = config.summaryServiceDescription.trim() || DEFAULT_SUMMARY_SERVICE_DESCRIPTION;
  const tz = config.timezone;
  return `${service} - ${formatLongDate(period.startUtc, tz)} to ${formatLongDate(period.endUtc, tz)}`;
}

/**
 * Collapse an invoice to one line.
 *
 * Deliberately reuses the already-computed totals rather than re-rounding the
 * raw seconds: rounding is applied per description, so re-rounding the sum here
 * would make the same period bill a different amount depending on nothing more
 * than a display toggle.
 */
export function summaryLine(invoice: Invoice): InvoiceLine {
  return {
    description: summaryLineDescription(invoice.period, invoice.config),
    rawSeconds: invoice.rawSeconds,
    billedSeconds: invoice.billedSeconds,
    billedHours: invoice.billedHours,
    amount: invoice.total,
  };
}

export function round2(n: number): number {
  return Math.round((n + Number.EPSILON) * 100) / 100;
}

/** Format an amount for display. Falls back to a plain suffix for non-ISO currency codes. */
export function formatMoney(amount: number, currency: string): string {
  const code = currency.trim().toUpperCase();
  if (/^[A-Z]{3}$/.test(code)) {
    try {
      return new Intl.NumberFormat('en-GB', { style: 'currency', currency: code }).format(amount);
    } catch {
      /* fall through to the plain format below */
    }
  }
  const fixed = amount.toFixed(2);
  return currency.trim() === '' ? fixed : `${currency.trim()} ${fixed}`;
}

/** Hours rendered to two decimals, the convention on a consulting invoice. */
export function formatHours(seconds: number): string {
  return (seconds / 3600).toFixed(2);
}

export function describeRounding(config: InvoiceConfig): string {
  if (config.roundingMode === 'exact') return 'Exact time, no rounding';
  const unit =
    config.roundingIncrement === 60
      ? 'hour'
      : config.roundingIncrement === 30
        ? 'half hour'
        : `${config.roundingIncrement} minutes`;
  const verb = { up: 'Rounded up', down: 'Rounded down', nearest: 'Rounded to the nearest' }[config.roundingMode];
  return config.roundingMode === 'nearest' ? `${verb} ${unit}` : `${verb} to the nearest ${unit}`;
}
