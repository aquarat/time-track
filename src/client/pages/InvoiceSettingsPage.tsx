import { useMemo, useRef, useState } from 'react';
import type { RoundingMode, Settings } from '../../shared/types';
import { MONTH_NAMES, monthKey, parseMonthKey, toZonedParts } from '../../shared/time';
import { describeRounding, listPeriods, periodAt, roundSeconds } from '../../shared/invoice';
import { api } from '../api';

interface Props {
  settings: Settings;
  onSaved: (settings: Settings) => void;
}

const TIMEZONES: string[] = (() => {
  // Modern runtimes expose the full IANA list; older ones get a small fallback.
  const supported = (Intl as unknown as { supportedValuesOf?: (k: string) => string[] }).supportedValuesOf;
  if (typeof supported === 'function') {
    try {
      return supported('timeZone');
    } catch {
      /* fall through */
    }
  }
  return ['UTC', 'Africa/Johannesburg', 'Europe/London', 'America/New_York'];
})();

export function InvoiceSettingsPage({ settings, onSaved }: Props) {
  const [draft, setDraft] = useState<Settings>(settings);
  const [busy, setBusy] = useState(false);
  const [status, setStatus] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const fileRef = useRef<HTMLInputElement>(null);

  const set = <K extends keyof Settings>(key: K, value: Settings[K]) => {
    setDraft((d) => ({ ...d, [key]: value }));
    setStatus(null);
  };

  const save = async (event: React.FormEvent) => {
    event.preventDefault();
    setBusy(true);
    setError(null);
    try {
      const { settings: saved } = await api.saveSettings(draft);
      setDraft(saved);
      onSaved(saved);
      setStatus('Saved');
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  };

  const onLogo = async (file: File | undefined) => {
    if (!file) return;
    if (file.size > 350 * 1024) {
      setError('Logo must be under 350KB — it only needs to print at about 20mm tall.');
      return;
    }
    const reader = new FileReader();
    reader.onload = () => {
      set('logoDataUrl', String(reader.result));
      setError(null);
    };
    reader.onerror = () => setError('Could not read that file');
    reader.readAsDataURL(file);
  };

  return (
    <div className="page settings-page">
      <h1>Invoice settings</h1>
      <p className="page-intro">
        Everything an invoice needs lives here. Periods, sequence numbers and totals are derived from
        these values, so generating an invoice never asks you another question.
      </p>

      {error && <div className="banner error">{error}</div>}

      <form onSubmit={save}>
        <fieldset>
          <legend>Period &amp; numbering</legend>

          <label>
            <span>Timezone</span>
            <select value={draft.timezone} onChange={(e) => set('timezone', e.target.value)}>
              {TIMEZONES.includes(draft.timezone) ? null : <option value={draft.timezone}>{draft.timezone}</option>}
              {TIMEZONES.map((tz) => (
                <option key={tz} value={tz}>
                  {tz}
                </option>
              ))}
            </select>
            <small>
              Day boundaries and invoice period boundaries are midnight in this zone. Your browser
              reports <code>{Intl.DateTimeFormat().resolvedOptions().timeZone}</code>.
            </small>
          </label>

          <label>
            <span>Invoice period day</span>
            <input
              type="number"
              min={1}
              max={31}
              value={draft.invoicePeriodDay}
              onChange={(e) => set('invoicePeriodDay', Number(e.target.value))}
            />
            <small>
              Each period runs from this day of the month to the same day of the next. A day past the
              end of a short month falls back to that month's last day.
            </small>
          </label>

          <label>
            <span>Invoice prefix</span>
            <input
              type="text"
              value={draft.invoicePrefix}
              onChange={(e) => set('invoicePrefix', e.target.value)}
              placeholder="TDC-TT-G2A-"
            />
          </label>

          <label>
            <span>Starting sequence number</span>
            <input
              type="number"
              min={0}
              value={draft.invoiceStartSeq}
              onChange={(e) => set('invoiceStartSeq', Number(e.target.value))}
            />
            <small>The number given to the first period. Every later period increments by one.</small>
          </label>

          <label>
            <span>Starting month</span>
            <MonthPicker value={draft.invoiceStartMonth} onChange={(v) => set('invoiceStartMonth', v)} />
            <small>No invoices are listed before this month.</small>
          </label>

          <label>
            <span>Period naming</span>
            <select
              value={draft.periodLabelMode}
              onChange={(e) => set('periodLabelMode', e.target.value as Settings['periodLabelMode'])}
            >
              <option value="start">Named for the month it starts in</option>
              <option value="end">Named for the month it ends in</option>
            </select>
            <small>
              With a cut-over on the {ordinal(draft.invoicePeriodDay)},{' '}
              {draft.periodLabelMode === 'start'
                ? `"January 2026" runs ${draft.invoicePeriodDay} Jan → ${draft.invoicePeriodDay} Feb.`
                : `"January 2026" runs ${draft.invoicePeriodDay} Dec → ${draft.invoicePeriodDay} Jan.`}
            </small>
          </label>

          <SequencePreview settings={draft} />
        </fieldset>

        <fieldset>
          <legend>Parties</legend>

          <label>
            <span>Your logo</span>
            <div className="logo-field">
              {draft.logoDataUrl ? (
                <img className="logo-preview" src={draft.logoDataUrl} alt="Invoice logo" />
              ) : (
                <div className="logo-preview empty">No logo</div>
              )}
              <div className="logo-actions">
                <input
                  ref={fileRef}
                  type="file"
                  accept="image/png,image/jpeg,image/svg+xml,image/webp,image/gif"
                  onChange={(e) => void onLogo(e.target.files?.[0])}
                />
                {draft.logoDataUrl && (
                  <button
                    type="button"
                    onClick={() => {
                      set('logoDataUrl', '');
                      if (fileRef.current) fileRef.current.value = '';
                    }}
                  >
                    Remove
                  </button>
                )}
              </div>
            </div>
            <small>Stored inline in the database as a data URL. Keep it under 350KB.</small>
          </label>

          <label>
            <span>Your name</span>
            <input type="text" value={draft.companyName} onChange={(e) => set('companyName', e.target.value)} />
          </label>
          <label>
            <span>Your address</span>
            <textarea
              rows={4}
              value={draft.companyAddress}
              onChange={(e) => set('companyAddress', e.target.value)}
            />
          </label>
          <label>
            <span>Client name</span>
            <input type="text" value={draft.clientName} onChange={(e) => set('clientName', e.target.value)} />
          </label>
          <label>
            <span>Client address</span>
            <textarea
              rows={4}
              value={draft.clientAddress}
              onChange={(e) => set('clientAddress', e.target.value)}
            />
          </label>
        </fieldset>

        <fieldset>
          <legend>Billing</legend>

          <label>
            <span>Currency</span>
            <input
              type="text"
              value={draft.currency}
              onChange={(e) => set('currency', e.target.value)}
              placeholder="ZAR"
            />
            <small>A three-letter ISO code gets proper currency formatting.</small>
          </label>

          <label>
            <span>Hourly rate</span>
            <input
              type="number"
              min={0}
              step="0.01"
              value={draft.hourlyRate}
              onChange={(e) => set('hourlyRate', Number(e.target.value))}
            />
            <small>Set to 0 to produce a timesheet with no amounts.</small>
          </label>

          <label>
            <span>Rounding</span>
            <div className="inline-fields">
              <select
                value={draft.roundingMode}
                onChange={(e) => set('roundingMode', e.target.value as RoundingMode)}
              >
                <option value="exact">Exact time</option>
                <option value="up">Round up</option>
                <option value="down">Round down</option>
                <option value="nearest">Round to nearest</option>
              </select>
              <select
                value={draft.roundingIncrement}
                disabled={draft.roundingMode === 'exact'}
                onChange={(e) => set('roundingIncrement', Number(e.target.value))}
              >
                <option value={15}>15 minutes</option>
                <option value={30}>30 minutes</option>
                <option value={60}>1 hour</option>
              </select>
            </div>
            <small>
              Applied to each line item — that is, once per distinct task description — not to each
              timer run and not to the grand total. <RoundingExample settings={draft} />
            </small>
          </label>

          <label>
            <span>Invoice footer</span>
            <textarea
              rows={5}
              value={draft.invoiceFooter}
              onChange={(e) => set('invoiceFooter', e.target.value)}
              placeholder={'Thank you for your business.\n\nBank: …\nAccount: …\nPayable within 30 days.'}
            />
          </label>
        </fieldset>

        <div className="form-actions">
          <button type="submit" className="primary" disabled={busy}>
            {busy ? 'Saving…' : 'Save settings'}
          </button>
          {status && <span className="status-ok">{status}</span>}
        </div>
      </form>
    </div>
  );
}

/* -------------------------------------------------------------------------- */

function MonthPicker({ value, onChange }: { value: string; onChange: (v: string) => void }) {
  const { year, month } = parseMonthKey(value);
  const thisYear = new Date().getUTCFullYear();
  const years = Array.from({ length: 12 }, (_, i) => thisYear - 6 + i);

  return (
    <div className="inline-fields">
      <select value={month} onChange={(e) => onChange(monthKey(year, Number(e.target.value)))}>
        {MONTH_NAMES.map((name, i) => (
          <option key={name} value={i + 1}>
            {name}
          </option>
        ))}
      </select>
      <select value={year} onChange={(e) => onChange(monthKey(Number(e.target.value), month))}>
        {(years.includes(year) ? years : [year, ...years]).map((y) => (
          <option key={y} value={y}>
            {y}
          </option>
        ))}
      </select>
    </div>
  );
}

/** Shows exactly what the configuration will generate, before it is saved. */
function SequencePreview({ settings }: { settings: Settings }) {
  const rows = useMemo(() => {
    const now = Date.now();
    const total = listPeriods(settings, now).length;
    const first = [0, 1, 2].map((i) => periodAt(settings, i));
    const current = total > 0 ? periodAt(settings, total - 1) : null;
    // Only show the ellipsis row when the current period is not already listed.
    const showCurrent = current !== null && total > 4;
    return { first, current: showCurrent ? current : null, total };
  }, [settings]);

  const fmt = (ms: number) => {
    const p = toZonedParts(ms, settings.timezone);
    return `${p.day} ${MONTH_NAMES[p.month - 1].slice(0, 3)} ${p.year}`;
  };

  return (
    <div className="preview">
      <div className="preview-title">This produces</div>
      <table>
        <tbody>
          {rows.first.map((p) => (
            <tr key={p.key}>
              <td className="mono">{p.invoiceNumber || <span className="muted">(no prefix)</span>}</td>
              <td>{p.label}</td>
              <td className="muted">
                {fmt(p.startUtc)} → {fmt(p.endUtc)}
              </td>
            </tr>
          ))}
          {rows.current && (
            <>
              <tr>
                <td className="muted" colSpan={3}>
                  …
                </td>
              </tr>
              <tr>
                <td className="mono">{rows.current.invoiceNumber}</td>
                <td>{rows.current.label}</td>
                <td className="muted">
                  {fmt(rows.current.startUtc)} → {fmt(rows.current.endUtc)}
                </td>
              </tr>
            </>
          )}
        </tbody>
      </table>
      <div className="preview-foot">
        {rows.total} invoice{rows.total === 1 ? '' : 's'} available today.
      </div>
    </div>
  );
}

function RoundingExample({ settings }: { settings: Settings }) {
  if (settings.roundingMode === 'exact') return <>Time is billed exactly as tracked.</>;
  const sample = 2 * 3600 + 7 * 60; // 2h 07m
  const billed = roundSeconds(sample, settings.roundingMode, settings.roundingIncrement);
  return (
    <>
      {describeRounding(settings)}: 2h 07m of tracked time bills as {(billed / 3600).toFixed(2)} hours.
    </>
  );
}

function ordinal(n: number): string {
  const suffix = n % 100 >= 11 && n % 100 <= 13 ? 'th' : ['th', 'st', 'nd', 'rd'][n % 10] ?? 'th';
  return `${n}${suffix}`;
}
