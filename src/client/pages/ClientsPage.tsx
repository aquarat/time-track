import { useEffect, useMemo, useState } from 'react';
import type { Client, RoundingMode, Settings } from '../../shared/types';
import { MONTH_NAMES, formatLongDate, monthKey, parseMonthKey, toZonedParts } from '../../shared/time';
import {
  DEFAULT_SUMMARY_SERVICE_DESCRIPTION,
  describeRounding,
  invoiceConfig,
  listPeriods,
  periodAt,
  roundSeconds,
} from '../../shared/invoice';
import { formatMoney } from '../../shared/invoice';
import { api } from '../api';

interface Props {
  settings: Settings;
  clients: Client[];
  onClientsChanged: (clients: Client[]) => void;
}

const PALETTE = ['#2563eb', '#059669', '#d97706', '#7c3aed', '#db2777', '#0891b2', '#65a30d', '#e11d48'];

export function ClientsPage({ settings, clients, onClientsChanged }: Props) {
  const [editingId, setEditingId] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [creating, setCreating] = useState(false);

  const editing = clients.find((c) => c.id === editingId) ?? null;

  const addClient = async () => {
    setCreating(true);
    setError(null);
    try {
      const { client } = await api.createClient({ name: 'New client' });
      const { clients: fresh } = await api.clients();
      onClientsChanged(fresh);
      setEditingId(client.id);
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setCreating(false);
    }
  };

  if (editing) {
    return (
      <ClientEditor
        client={editing}
        settings={settings}
        isDefault={editing.id === settings.defaultClientId}
        onDone={async () => {
          const { clients: fresh } = await api.clients();
          onClientsChanged(fresh);
          setEditingId(null);
        }}
        onCancel={() => setEditingId(null)}
      />
    );
  }

  return (
    <div className="page">
      <h1>Clients</h1>
      <p className="page-intro">
        Each client has its own invoice series, rate and terms. Time entries belong to one
        client, and invoices are generated per client.
      </p>

      {error && <div className="banner error">{error}</div>}

      <div className="table-scroll">
        <table className="invoice-table">
          <thead>
            <tr>
              <th>Client</th>
              <th>Slug</th>
              <th className="num">Rate</th>
              <th>Invoices</th>
              <th />
            </tr>
          </thead>
          <tbody>
            {clients.map((c) => (
              <tr key={c.id}>
                <td>
                  <span className="client-dot" style={{ background: c.colour }} />
                  <strong>{c.name}</strong>
                  {c.id === settings.defaultClientId && <span className="pill">Default</span>}
                </td>
                <td className="mono muted">{c.slug}</td>
                <td className="num">
                  {c.hourlyRate > 0 ? `${formatMoney(c.hourlyRate, c.currency)} / h` : <span className="muted">—</span>}
                </td>
                <td className="muted mono">{c.invoicePrefix || <span className="muted">(no prefix)</span>}</td>
                <td className="num">
                  <button type="button" className="button-link" onClick={() => setEditingId(c.id)}>
                    Edit
                  </button>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>

      <div className="form-actions" style={{ marginTop: 16 }}>
        <button type="button" className="primary" onClick={() => void addClient()} disabled={creating}>
          {creating ? 'Adding…' : 'Add client'}
        </button>
        <span className="muted">
          New clients copy their period day, currency and terms from your default client.
        </span>
      </div>
    </div>
  );
}

/* -------------------------------------------------------------------------- */

function ClientEditor({
  client,
  settings,
  isDefault,
  onDone,
  onCancel,
}: {
  client: Client;
  settings: Settings;
  isDefault: boolean;
  onDone: () => Promise<void>;
  onCancel: () => void;
}) {
  const [draft, setDraft] = useState<Client>(client);
  const [busy, setBusy] = useState(false);
  const [status, setStatus] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => setDraft(client), [client]);

  const set = <K extends keyof Client>(key: K, value: Client[K]) => {
    setDraft((d) => ({ ...d, [key]: value }));
    setStatus(null);
  };

  const save = async (event: React.FormEvent) => {
    event.preventDefault();
    setBusy(true);
    setError(null);
    try {
      await api.updateClient(client.id, draft);
      setStatus('Saved');
      await onDone();
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  };

  const config = useMemo(() => invoiceConfig(settings, draft), [settings, draft]);

  return (
    <div className="page settings-page">
      <div className="page-head">
        <button type="button" className="button-link" onClick={onCancel}>
          ‹ All clients
        </button>
      </div>
      <h1>{draft.name || 'Client'}</h1>
      <p className="page-intro">
        Everything on this client's invoices. {isDefault && 'This is your default client — new time entries and the invoice list start here.'}
      </p>

      {error && <div className="banner error">{error}</div>}

      <form onSubmit={save}>
        <fieldset>
          <legend>Identity</legend>

          <label>
            <span>Name</span>
            <input type="text" value={draft.name} onChange={(e) => set('name', e.target.value)} />
          </label>

          <label>
            <span>Address</span>
            <textarea rows={4} value={draft.address} onChange={(e) => set('address', e.target.value)} />
          </label>

          <label>
            <span>URL slug</span>
            <input type="text" value={draft.slug} onChange={(e) => set('slug', e.target.value)} />
            <small>
              Used in invoice links: <code>/invoice/{draft.slug || '…'}/2026-05</code>. Changing it
              breaks links to invoices you have already sent.
            </small>
          </label>

          <label>
            <span>Calendar colour</span>
            <div className="colour-row">
              {PALETTE.map((c) => (
                <button
                  key={c}
                  type="button"
                  className={c === draft.colour ? 'swatch selected' : 'swatch'}
                  style={{ background: c }}
                  aria-label={`Use ${c}`}
                  onClick={() => set('colour', c)}
                />
              ))}
            </div>
            <small>Distinguishes this client's blocks in the tracker calendar.</small>
          </label>
        </fieldset>

        <fieldset>
          <legend>Period &amp; numbering</legend>

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
              Each period runs from this day of the month to the same day of the next. A day past
              the end of a short month falls back to that month's last day.
            </small>
          </label>

          <label>
            <span>Invoice prefix</span>
            <input
              type="text"
              value={draft.invoicePrefix}
              onChange={(e) => set('invoicePrefix', e.target.value)}
              placeholder="ACME-"
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
              onChange={(e) => set('periodLabelMode', e.target.value as Client['periodLabelMode'])}
            >
              <option value="start">Named for the month it starts in</option>
              <option value="end">Named for the month it ends in</option>
            </select>
          </label>

          <SequencePreview config={config} />
        </fieldset>

        <fieldset>
          <legend>Billing</legend>

          <label>
            <span>Currency</span>
            <input type="text" value={draft.currency} onChange={(e) => set('currency', e.target.value)} />
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
              Applied to each line item — once per distinct task description — not to each timer
              run and not to the grand total. <RoundingExample config={config} />
            </small>
          </label>

          <label>
            <span>Invoice footer</span>
            <textarea
              rows={5}
              value={draft.invoiceFooter}
              onChange={(e) => set('invoiceFooter', e.target.value)}
              placeholder={'Thank you.\nBank: …\nPayable within 30 days.'}
            />
          </label>
        </fieldset>

        <fieldset>
          <legend>Invoice layout</legend>
          <p className="fieldset-intro">
            How this client's invoices open. Both can be toggled on the invoice itself without
            changing these defaults.
          </p>

          <label>
            <span>Summary line wording</span>
            <input
              type="text"
              value={draft.summaryServiceDescription}
              onChange={(e) => set('summaryServiceDescription', e.target.value)}
              placeholder={DEFAULT_SUMMARY_SERVICE_DESCRIPTION}
            />
            <small>
              Used when “Detailed invoice” is off. The period dates are appended automatically:
              “{draft.summaryServiceDescription.trim() || DEFAULT_SUMMARY_SERVICE_DESCRIPTION} -{' '}
              {periodExample(config)}”.
            </small>
          </label>

          <label className="checkbox-row">
            <input
              type="checkbox"
              checked={draft.defaultDetailedInvoice}
              onChange={(e) => set('defaultDetailedInvoice', e.target.checked)}
            />
            <span>Detailed invoice</span>
          </label>
          <small className="standalone-hint">One line per task, rather than a single summary line.</small>

          <label className="checkbox-row">
            <input
              type="checkbox"
              checked={draft.defaultDetailedTimeLog}
              onChange={(e) => set('defaultDetailedTimeLog', e.target.checked)}
            />
            <span>Detailed time log</span>
          </label>
          <small className="standalone-hint">Appends the day-by-day breakdown on its own page.</small>
        </fieldset>

        <div className="form-actions">
          <button type="submit" className="primary" disabled={busy}>
            {busy ? 'Saving…' : 'Save client'}
          </button>
          <button type="button" onClick={onCancel} disabled={busy}>
            Back
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

function SequencePreview({ config }: { config: ReturnType<typeof invoiceConfig> }) {
  const rows = useMemo(() => {
    const now = Date.now();
    const total = listPeriods(config, now).length;
    const first = [0, 1, 2].map((i) => periodAt(config, i));
    const current = total > 0 ? periodAt(config, total - 1) : null;
    return { first, current: total > 4 ? current : null, total };
  }, [config]);

  const fmt = (ms: number) => {
    const p = toZonedParts(ms, config.timezone);
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

function RoundingExample({ config }: { config: ReturnType<typeof invoiceConfig> }) {
  if (config.roundingMode === 'exact') return <>Time is billed exactly as tracked.</>;
  const sample = 2 * 3600 + 7 * 60;
  const billed = roundSeconds(sample, config.roundingMode, config.roundingIncrement);
  return (
    <>
      {describeRounding(config)}: 2h 07m of tracked time bills as {(billed / 3600).toFixed(2)} hours.
    </>
  );
}

function periodExample(config: ReturnType<typeof invoiceConfig>): string {
  const p = periodAt(config, 0);
  const fmt = (ms: number) => formatLongDate(ms, config.timezone);
  return `${fmt(p.startUtc)} to ${fmt(p.endUtc)}`;
}
