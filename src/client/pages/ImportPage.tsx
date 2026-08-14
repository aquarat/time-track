import { useRef, useState } from 'react';
import type { Settings } from '../../shared/types';
import type { ImportReport } from '../../shared/togglCsv';
import { formatCompact } from '../../shared/time';
import { api } from '../api';

interface Props {
  settings: Settings;
}

const COMMON_ZONES = ['Etc/UTC', 'Europe/London', 'Africa/Johannesburg'];

export function ImportPage({ settings }: Props) {
  const [csv, setCsv] = useState<string | null>(null);
  const [fileName, setFileName] = useState('');
  const [timezone, setTimezone] = useState(settings.timezone);
  const [skipNonBillable, setSkipNonBillable] = useState(false);
  const [report, setReport] = useState<ImportReport | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const fileRef = useRef<HTMLInputElement>(null);

  const zoneOptions = [...new Set([settings.timezone, ...COMMON_ZONES])];

  const pick = async (file: File | undefined) => {
    if (!file) return;
    setError(null);
    setReport(null);
    setFileName(file.name);
    setCsv(await file.text());
  };

  const run = async (dryRun: boolean) => {
    if (csv === null) return;
    setBusy(true);
    setError(null);
    try {
      const res = await api.importCsv({ csv, timezone, skipNonBillable, dryRun });
      setReport(res.report);
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  };

  const reset = () => {
    setCsv(null);
    setReport(null);
    setFileName('');
    setError(null);
    if (fileRef.current) fileRef.current.value = '';
  };

  return (
    <div className="page settings-page">
      <h1>Import from Toggl</h1>
      <p className="page-intro">
        Takes a Toggl Track detailed CSV export. Everything is previewed before anything is
        written, and re-importing the same file will not duplicate entries.
      </p>

      {error && <div className="banner error">{error}</div>}

      <fieldset>
        <legend>File</legend>

        <label>
          <span>Toggl CSV export</span>
          <input
            ref={fileRef}
            type="file"
            accept=".csv,text/csv"
            onChange={(e) => void pick(e.target.files?.[0])}
          />
          {fileName && (
            <small>
              Loaded <strong>{fileName}</strong> ({Math.round((csv?.length ?? 0) / 1024)}KB)
            </small>
          )}
        </label>

        <label>
          <span>The times in this file are local to</span>
          <select value={timezone} onChange={(e) => setTimezone(e.target.value)}>
            {zoneOptions.map((tz) => (
              <option key={tz} value={tz}>
                {tz}
                {tz === settings.timezone ? ' — this app’s timezone' : ''}
              </option>
            ))}
          </select>
          <small>
            A Toggl export records bare wall-clock times with no offset, so this cannot be
            detected from the file — it has to match the timezone your Toggl workspace was set
            to. Getting it wrong shifts every entry, which can move work across day and invoice
            period boundaries.
          </small>
        </label>

        <label className="checkbox-row">
          <input
            type="checkbox"
            checked={skipNonBillable}
            onChange={(e) => setSkipNonBillable(e.target.checked)}
          />
          <span>Skip rows Toggl marked as not billable</span>
        </label>
        <small className="standalone-hint">
          This app bills everything it tracks, so anything imported will appear on an invoice.
        </small>

        <div className="form-actions">
          <button
            type="button"
            className="primary"
            disabled={csv === null || busy}
            onClick={() => void run(true)}
          >
            {busy ? 'Working…' : 'Preview import'}
          </button>
          {csv !== null && (
            <button type="button" onClick={reset} disabled={busy}>
              Clear
            </button>
          )}
        </div>
      </fieldset>

      {report && <Report report={report} onCommit={() => void run(false)} busy={busy} />}
    </div>
  );
}

function Report({
  report,
  onCommit,
  busy,
}: {
  report: ImportReport;
  onCommit: () => void;
  busy: boolean;
}) {
  if (report.committed) {
    return (
      <fieldset>
        <legend>Done</legend>
        <p className="import-done">
          Imported <strong>{report.imported}</strong> entries totalling{' '}
          <strong>{formatCompact(report.totalSeconds)}</strong>.
        </p>
        <p className="muted">They are on the time tracker and counted on every affected invoice.</p>
      </fieldset>
    );
  }

  const nothingToDo = report.toImport === 0;

  return (
    <fieldset>
      <legend>Preview</legend>

      <div className="stat-grid">
        <Stat label="Rows read" value={String(report.parsed)} />
        <Stat label="Will import" value={String(report.toImport)} strong />
        <Stat label="Already present" value={String(report.duplicates)} />
        <Stat label="Total time" value={formatCompact(report.totalSeconds)} />
      </div>

      <table className="detail-table">
        <tbody>
          {report.firstDate && (
            <tr>
              <td>Date range</td>
              <td>
                {report.firstDate} → {report.lastDate}
              </td>
            </tr>
          )}
          <tr>
            <td>Distinct descriptions</td>
            <td>{report.distinctDescriptions}</td>
          </tr>
          <tr>
            <td>Read as local to</td>
            <td className="mono">{report.timezone}</td>
          </tr>
          {report.nonBillableIncluded > 0 && (
            <tr>
              <td>Marked non-billable</td>
              <td>{report.nonBillableIncluded} included — they will be billed</td>
            </tr>
          )}
          {report.nonBillableSkipped > 0 && (
            <tr>
              <td>Marked non-billable</td>
              <td>{report.nonBillableSkipped} skipped</td>
            </tr>
          )}
          {report.blankDescriptions > 0 && (
            <tr>
              <td>Blank descriptions</td>
              <td>{report.blankDescriptions} — these group as “(no description)” on invoices</td>
            </tr>
          )}
          {report.overlaps > 0 && (
            <tr>
              <td>Overlapping entries</td>
              <td>{report.overlaps} — the same clock time is counted twice</td>
            </tr>
          )}
        </tbody>
      </table>

      {report.periods.length > 0 && (
        <>
          <h3 className="subhead">How this lands on your invoices</h3>
          <div className="table-scroll">
          <table className="invoice-table compact">
            <thead>
              <tr>
                <th>Invoice</th>
                <th>Period</th>
                <th className="num">Entries</th>
                <th className="num">Time</th>
              </tr>
            </thead>
            <tbody>
              {report.periods.map((p) => (
                <tr key={p.key}>
                  <td className="mono">{p.invoiceNumber}</td>
                  <td>{p.label}</td>
                  <td className="num">{p.entries}</td>
                  <td className="num">{formatCompact(p.seconds)}</td>
                </tr>
              ))}
            </tbody>
          </table>
          </div>
        </>
      )}

      {report.problems.length > 0 && (
        <>
          <h3 className="subhead">Rows that could not be read ({report.problems.length})</h3>
          <ul className="problem-list">
            {report.problems.map((p) => (
              <li key={p.line}>
                <span className="mono">line {p.line}</span> — {p.reason}
              </li>
            ))}
          </ul>
        </>
      )}

      <div className="form-actions">
        <button type="button" className="primary" onClick={onCommit} disabled={busy || nothingToDo}>
          {busy ? 'Importing…' : `Import ${report.toImport} entries`}
        </button>
        {nothingToDo && <span className="muted">Nothing new to import.</span>}
      </div>
    </fieldset>
  );
}

function Stat({ label, value, strong }: { label: string; value: string; strong?: boolean }) {
  return (
    <div className={strong ? 'stat strong-stat' : 'stat'}>
      <div className="stat-value">{value}</div>
      <div className="stat-label">{label}</div>
    </div>
  );
}
