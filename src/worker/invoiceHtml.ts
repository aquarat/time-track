/**
 * Server-rendered invoice document, laid out for A4 print / "Save as PDF".
 *
 * Rendered as plain HTML with no client JavaScript so that printing is
 * deterministic and the page can be handed to any headless renderer later.
 */

import type { Invoice, InvoiceLayout, InvoiceLine } from '../shared/types';
import { formatHours, formatMoney, summaryLine } from '../shared/invoice';
import { formatClock, formatCompact, formatLongDate } from '../shared/time';

function esc(value: string): string {
  return value
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

/** Preserve the line breaks a user typed into an address or footer textarea. */
function multiline(value: string): string {
  return esc(value).replace(/\r?\n/g, '<br>');
}

/** The last instant covered by a period, since the stored end bound is exclusive. */
function inclusiveEnd(utcMs: number, tz: string): string {
  return formatLongDate(utcMs - 1, tz);
}

function weekday(dateKey: string): string {
  const [y, m, d] = dateKey.split('-').map(Number);
  return new Date(Date.UTC(y, m - 1, d)).toLocaleDateString('en-GB', { weekday: 'short', timeZone: 'UTC' });
}

export function renderInvoiceHtml(invoice: Invoice, layout: InvoiceLayout): string {
  const { period, config: s, details } = invoice;
  const currency = s.currency;
  const showRates = s.hourlyRate > 0;

  // A summary invoice is the same money, presented as one line — never a
  // different total. See summaryLine() for why it must not re-round.
  const lines: InvoiceLine[] = layout.detailedInvoice ? invoice.lines : [summaryLine(invoice)];
  const showLog = layout.detailedTimeLog && details.length > 0;

  // Raw tracked time is context for a per-task breakdown; against a single
  // summary line it just invites the client to query the difference.
  const showTracked = layout.detailedInvoice;
  const columnCount = 2 + (showTracked ? 1 : 0) + (showRates ? 2 : 0);

  const noticeBanner = invoice.inProgress
    ? `<div class="notice">This period is still open — it ends on ${esc(inclusiveEnd(period.endUtc, s.timezone))}.${
        invoice.hasRunningEntry ? ' A timer is currently running and is billed up to the moment this page was generated.' : ''
      }</div>`
    : '';

  const lineRows = lines
    .map(
      (l) => `<tr>
      <td class="desc">${esc(l.description)}</td>
      ${showTracked ? `<td class="num tracked">${esc(formatCompact(l.rawSeconds))}</td>` : ''}
      <td class="num">${esc(formatHours(l.billedSeconds))}</td>
      ${showRates ? `<td class="num">${esc(formatMoney(s.hourlyRate, currency))}</td>` : ''}
      ${showRates ? `<td class="num">${esc(formatMoney(l.amount, currency))}</td>` : ''}
    </tr>`,
    )
    .join('\n');

  const emptyRow = `<tr><td class="desc empty" colspan="${columnCount}">No time tracked in this period.</td></tr>`;

  // Extras carry an amount but no hours, so the time columns are left blank
  // rather than filled with a zero that would read as "no work done".
  const extraRows = invoice.extras
    .map(
      (e) => `<tr class="extra-row">
      <td class="desc">${esc(e.description)}</td>
      ${showTracked ? '<td class="num tracked"></td>' : ''}
      <td class="num"></td>
      ${showRates ? '<td class="num"></td>' : ''}
      ${showRates ? `<td class="num">${esc(formatMoney(e.amount, currency))}</td>` : ''}
    </tr>`,
    )
    .join('\n');

  const detailRows = details
    .map((day) => {
      const entries = day.entries
        .map(
          (e) => `<tr>
          <td class="detail-time">${esc(formatClock(e.startedAt, s.timezone))}–${esc(formatClock(e.endedAt, s.timezone))}</td>
          <td class="detail-desc">${esc(e.description)}</td>
          <td class="num detail-dur">${esc(formatCompact(e.seconds))}</td>
        </tr>`,
        )
        .join('\n');
      return `<tr class="detail-day">
        <td colspan="2">${esc(weekday(day.date))} ${esc(day.date)}</td>
        <td class="num">${esc(formatCompact(day.seconds))}</td>
      </tr>
      ${entries}`;
    })
    .join('\n');

  const layoutInputs = `<input type="hidden" name="detailed" value="${layout.detailedInvoice ? 1 : 0}">
      <input type="hidden" name="timelog" value="${layout.detailedTimeLog ? 1 : 0}">`;

  const extraEditor = `<section class="extras-editor">
  <h2>Additional line items</h2>
  ${
    invoice.extras.length > 0
      ? `<ul class="extras-list">
    ${invoice.extras
      .map(
        (e) => `<li>
      <span class="extras-desc">${esc(e.description)}</span>
      <span class="extras-amount">${esc(formatMoney(e.amount, currency))}</span>
      <form method="post" action="/invoice/${esc(period.key)}/extras/${esc(e.id)}/delete">
        ${layoutInputs}
        <button type="submit" class="extras-remove" aria-label="Remove line item">Remove</button>
      </form>
    </li>`,
      )
      .join('\n')}
  </ul>`
      : '<p class="extras-empty">None yet. Anything added here appears on this invoice only.</p>'
  }
  <form class="extras-form" method="post" action="/invoice/${esc(period.key)}/extras">
    ${layoutInputs}
    <input type="text" name="description" placeholder="Description" maxlength="300" required>
    <input type="number" name="amount" step="0.01" placeholder="Amount" required>
    <button type="submit">Add line item</button>
  </form>
</section>`;

  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<link rel="icon" type="image/svg+xml" href="/favicon.svg">
<link rel="icon" type="image/png" sizes="32x32" href="/favicon-32.png">
<link rel="apple-touch-icon" href="/apple-touch-icon.png">
<title>${esc(period.invoiceNumber)} — ${esc(period.label)}</title>
<style>
  @page { size: A4; margin: 16mm 14mm; }

  :root {
    --ink: #14171a;
    --muted: #6b7280;
    --rule: #d9dde2;
    --accent: #1f2937;
  }

  * { box-sizing: border-box; }

  html {
    /* Stops iOS Safari inflating text when a phone is rotated to landscape. */
    -webkit-text-size-adjust: 100%;
    text-size-adjust: 100%;
  }

  body {
    margin: 0;
    padding: 24px;
    background: #f3f4f6;
    color: var(--ink);
    font: 13px/1.5 -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, Helvetica, Arial, sans-serif;
    font-variant-numeric: tabular-nums;
  }

  .sheet {
    max-width: 190mm;
    margin: 0 auto;
    background: #fff;
    padding: 18mm 16mm;
    box-shadow: 0 1px 3px rgba(0,0,0,.12), 0 8px 24px rgba(0,0,0,.08);
  }

  .toolbar {
    max-width: 190mm; margin: 0 auto 16px; display: flex; gap: 8px;
    align-items: center; flex-wrap: wrap;
  }
  .toolbar a, .toolbar button {
    font: inherit; padding: 8px 14px; border-radius: 6px; border: 1px solid var(--rule);
    background: #fff; color: var(--ink); cursor: pointer; text-decoration: none;
  }
  .toolbar button.print { background: var(--accent); color: #fff; border-color: var(--accent); }

  .layout-form { display: flex; gap: 6px; align-items: center; flex-wrap: wrap; }
  .layout-form label {
    display: flex; align-items: center; gap: 7px; cursor: pointer;
    padding: 8px 13px; border: 1px solid var(--rule); border-radius: 6px;
    background: #fff; font-size: 12.5px; white-space: nowrap;
  }
  .layout-form label:hover { border-color: var(--accent); }
  .layout-form input[type="checkbox"] { margin: 0; cursor: pointer; }

  /* Editing surface, not part of the document — hidden when printing. */
  .extras-editor {
    max-width: 190mm; margin: 0 auto 16px; padding: 14px 16px;
    background: #fff; border: 1px solid var(--rule); border-radius: 8px;
  }
  .extras-editor h2 {
    margin: 0 0 10px; font-size: 10px; letter-spacing: .12em;
    text-transform: uppercase; color: var(--muted); font-weight: 600;
  }
  .extras-empty { margin: 0 0 12px; color: var(--muted); font-size: 12.5px; }
  .extras-list { list-style: none; margin: 0 0 12px; padding: 0; }
  .extras-list li {
    display: flex; align-items: center; gap: 12px;
    padding: 6px 0; border-bottom: 1px solid var(--rule);
  }
  .extras-desc { flex: 1; min-width: 0; overflow-wrap: anywhere; }
  .extras-amount { font-weight: 600; white-space: nowrap; }
  .extras-list form { margin: 0; }
  .extras-remove {
    font: inherit; font-size: 12px; padding: 3px 10px; border-radius: 5px;
    border: 1px solid var(--rule); background: #fff; color: var(--muted); cursor: pointer;
  }
  .extras-remove:hover { color: #b91c1c; border-color: #b91c1c; }

  .extras-form { display: flex; gap: 8px; flex-wrap: wrap; }
  .extras-form input {
    font: inherit; padding: 7px 10px; border: 1px solid var(--rule); border-radius: 6px;
  }
  .extras-form input[name="description"] { flex: 1; min-width: 220px; }
  .extras-form input[name="amount"] { width: 130px; text-align: right; }
  .extras-form button {
    font: inherit; padding: 7px 16px; border-radius: 6px; cursor: pointer;
    background: var(--accent); color: #fff; border: 1px solid var(--accent);
  }

  tr.extra-row td.desc { font-style: italic; }

  header.masthead { display: flex; justify-content: space-between; align-items: flex-start; gap: 24px; }
  .logo img { max-height: 64px; max-width: 220px; object-fit: contain; }
  .title { text-align: right; }
  .title h1 { margin: 0; font-size: 26px; letter-spacing: .14em; text-transform: uppercase; font-weight: 600; }
  .title .number { margin-top: 4px; font-size: 15px; font-weight: 600; }
  .title .meta { margin-top: 6px; color: var(--muted); font-size: 12px; }

  .parties { display: flex; gap: 32px; margin-top: 28px; }
  .parties section { flex: 1; }
  .parties h2 {
    margin: 0 0 6px; font-size: 10px; letter-spacing: .12em; text-transform: uppercase; color: var(--muted); font-weight: 600;
  }
  .parties .name { font-weight: 600; }
  .parties .addr { color: #374151; }

  .notice {
    margin-top: 20px; padding: 8px 12px; border-left: 3px solid #9ca3af;
    background: #f9fafb; color: #4b5563; font-size: 12px;
  }

  table { width: 100%; border-collapse: collapse; margin-top: 24px; }
  thead th {
    text-align: left; font-size: 10px; letter-spacing: .1em; text-transform: uppercase;
    color: var(--muted); font-weight: 600; padding: 0 0 6px; border-bottom: 1px solid var(--accent);
  }
  tbody td { padding: 9px 0; border-bottom: 1px solid var(--rule); vertical-align: top; }
  th.num, td.num { text-align: right; padding-left: 14px; white-space: nowrap; }
  td.tracked { color: var(--muted); }
  td.empty { color: var(--muted); font-style: italic; text-align: center; padding: 18px 0; }

  .table-scroll { overflow-x: auto; -webkit-overflow-scrolling: touch; }

  .totals { margin-top: 14px; display: flex; justify-content: flex-end; }
  .totals table { width: auto; min-width: 240px; margin: 0; }
  .totals td { border: none; padding: 3px 0 3px 24px; }
  .totals td:first-child { color: var(--muted); }
  .totals td:last-child { text-align: right; white-space: nowrap; }
  .totals tr.grand td { padding-top: 8px; border-top: 1px solid var(--accent); font-weight: 700; font-size: 15px; }
  .totals tr.grand td:first-child { color: var(--ink); }


  /* The log lives on its own sheet so it always starts a fresh page. */
  .detail-sheet { margin-top: 24px; }
  .detail h2 { font-size: 11px; letter-spacing: .12em; text-transform: uppercase; color: var(--muted); margin: 0; }
  .detail-meta { margin-top: 4px; color: var(--muted); font-size: 12px; }
  .detail table { margin-top: 8px; font-size: 11.5px; }
  .detail tbody td { padding: 4px 0; border-bottom: none; }
  tr.detail-day td { padding-top: 12px; font-weight: 600; border-bottom: 1px solid var(--rule); }
  td.detail-time { color: var(--muted); white-space: nowrap; width: 90px; }
  td.detail-dur { color: var(--muted); }
  tr.detail-day, tr.detail-day + tr { page-break-after: avoid; }

  footer.pay {
    margin-top: 36px; padding-top: 14px; border-top: 1px solid var(--rule);
    color: #374151; font-size: 12px; white-space: normal;
  }

  @media (max-width: 640px) {
    body { padding: 12px; padding-left: max(12px, env(safe-area-inset-left)); padding-right: max(12px, env(safe-area-inset-right)); }
    .sheet { padding: 20px 16px; }
    .toolbar, .extras-editor { max-width: none; }
    header.masthead { flex-direction: column; gap: 14px; }
    .title { text-align: left; }
    .parties { flex-direction: column; gap: 18px; }
    /* Description takes its own row; amount and the button share the next. */
    .extras-form input[name="description"] { flex-basis: 100%; min-width: 0; }
    .extras-form input[name="amount"] { flex: 1; width: auto; }
  }

  /* iOS Safari zooms the page when a sub-16px control takes focus. */
  @media (pointer: coarse) {
    .layout-form input[type="checkbox"] { width: 18px; height: 18px; }
    .extras-form input { font-size: 16px; }
    .extras-remove { padding: 8px 14px; }
  }

  @media print {
    body { background: #fff; padding: 0; }
    .sheet { max-width: none; padding: 0; box-shadow: none; }
    .toolbar, .extras-editor { display: none; }
    .table-scroll { overflow: visible; }
    thead { display: table-header-group; }
    tr { page-break-inside: avoid; }
    /* Requested: the time log always starts on a new page. */
    .detail-sheet { margin-top: 0; break-before: page; page-break-before: always; }
  }
</style>
</head>
<body>
<div class="toolbar">
  <button type="button" class="print" onclick="window.print()">Print / Save as PDF</button>
  <!--
    Layout is a GET form rather than a script so the document stays reproducible
    from its URL alone: /invoice/KEY?detailed=0&timelog=1 renders identically in a
    headless renderer with JavaScript disabled.

    The hidden input before each checkbox supplies the "0" that an unchecked box
    would otherwise not submit. Disabling it when the box is ticked keeps exactly
    one value per name in the resulting URL, so the address stays clean enough to
    bookmark or paste. Without scripting both are submitted instead and the server
    takes the last value, which resolves the same way.
  -->
  <form class="layout-form" method="get">
    <label>
      <input type="hidden" name="detailed" value="0"${layout.detailedInvoice ? ' disabled' : ''}>
      <input type="checkbox" name="detailed" value="1"${layout.detailedInvoice ? ' checked' : ''}
             onchange="this.previousElementSibling.disabled = this.checked; this.form.submit()">
      Detailed invoice
    </label>
    <label>
      <input type="hidden" name="timelog" value="0"${layout.detailedTimeLog ? ' disabled' : ''}>
      <input type="checkbox" name="timelog" value="1"${layout.detailedTimeLog ? ' checked' : ''}
             onchange="this.previousElementSibling.disabled = this.checked; this.form.submit()">
      Detailed time log
    </label>
    <noscript><button type="submit">Apply</button></noscript>
  </form>
  <a href="/invoices">Back to invoices</a>
</div>

${extraEditor}

<div class="sheet">
  <header class="masthead">
    <div class="logo">${s.logoDataUrl ? `<img src="${esc(s.logoDataUrl)}" alt="${esc(s.companyName || 'Logo')}">` : `<strong>${esc(s.companyName)}</strong>`}</div>
    <div class="title">
      <h1>Invoice</h1>
      <div class="number">${esc(period.invoiceNumber)}</div>
      <div class="meta">
        ${esc(formatLongDate(period.startUtc, s.timezone))} &ndash; ${esc(inclusiveEnd(period.endUtc, s.timezone))}<br>
        ${esc(period.label)} &middot; ${esc(s.timezone)}
      </div>
    </div>
  </header>

  <div class="parties">
    <section>
      <h2>From</h2>
      <div class="name">${esc(s.companyName)}</div>
      <div class="addr">${multiline(s.companyAddress)}</div>
    </section>
    <section>
      <h2>Bill to</h2>
      <div class="name">${esc(s.clientName)}</div>
      <div class="addr">${multiline(s.clientAddress)}</div>
    </section>
  </div>

  ${noticeBanner}

  <div class="table-scroll">
  <table>
    <thead>
      <tr>
        <th>Description</th>
        ${showTracked ? '<th class="num">Tracked</th>' : ''}
        <th class="num">Hours</th>
        ${showRates ? '<th class="num">Rate</th>' : ''}
        ${showRates ? '<th class="num">Amount</th>' : ''}
      </tr>
    </thead>
    <tbody>
      ${lines.length > 0 ? lineRows : emptyRow}
      ${extraRows}
    </tbody>
  </table>
  </div>

  <div class="totals">
    <table>
      <tbody>
        ${showTracked ? `<tr><td>Tracked</td><td>${esc(formatCompact(invoice.rawSeconds))}</td></tr>` : ''}
        <tr><td>Billable hours</td><td>${esc(formatHours(invoice.billedSeconds))}</td></tr>
        ${showRates ? `<tr><td>Rate</td><td>${esc(formatMoney(s.hourlyRate, currency))} / hour</td></tr>` : ''}
        ${
          showRates && invoice.extras.length > 0
            ? `<tr><td>Time subtotal</td><td>${esc(formatMoney(invoice.total, currency))}</td></tr>
               <tr><td>Additional items</td><td>${esc(formatMoney(invoice.extrasTotal, currency))}</td></tr>`
            : ''
        }
        ${showRates ? `<tr class="grand"><td>Total due</td><td>${esc(formatMoney(invoice.grandTotal, currency))}</td></tr>` : ''}
      </tbody>
    </table>
  </div>


  ${s.invoiceFooter ? `<footer class="pay">${multiline(s.invoiceFooter)}</footer>` : ''}
</div>

${
  showLog
    ? `<div class="sheet detail-sheet">
  <div class="detail">
    <h2>Detailed time log</h2>
    <div class="detail-meta">${esc(period.invoiceNumber)} &middot; ${esc(formatLongDate(period.startUtc, s.timezone))} &ndash; ${esc(inclusiveEnd(period.endUtc, s.timezone))}</div>
    <table>
      <tbody>
        ${detailRows}
      </tbody>
    </table>
  </div>
</div>`
    : ''
}
</body>
</html>`;
}
