import { useEffect, useState } from 'react';
import type { PeriodSummary, Settings } from '../../shared/types';
import { MONTH_NAMES, formatCompact, toZonedParts } from '../../shared/time';
import { formatHours, formatMoney } from '../../shared/invoice';
import { api } from '../api';

interface Props {
  onNavigate: (path: string) => void;
}

export function InvoicesPage({ onNavigate }: Props) {
  const [data, setData] = useState<{ settings: Settings; periods: PeriodSummary[] } | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    api
      .invoices()
      .then(setData)
      .catch((e: Error) => setError(e.message));
  }, []);

  if (error) return <div className="banner error">{error}</div>;
  if (!data) return <div className="loading">Loading…</div>;

  const { settings, periods } = data;
  const tz = settings.timezone;
  const fmtDate = (ms: number) => {
    const p = toZonedParts(ms, tz);
    return `${p.day} ${MONTH_NAMES[p.month - 1].slice(0, 3)} ${p.year}`;
  };

  return (
    <div className="page">
      <h1>Invoices</h1>
      <p className="page-intro">
        Every period since {MONTH_NAMES[Number(settings.invoiceStartMonth.slice(5, 7)) - 1]}{' '}
        {settings.invoiceStartMonth.slice(0, 4)}. Open one to get a print-ready document — there is
        nothing to configure per invoice.
      </p>

      {periods.length === 0 && (
        <div className="empty-state">
          <p>
            No periods yet. Check the starting month on the{' '}
            <a
              href="/settings"
              onClick={(e) => {
                e.preventDefault();
                onNavigate('/settings');
              }}
            >
              invoice settings
            </a>{' '}
            page.
          </p>
        </div>
      )}

      {periods.length > 0 && (
        <div className="table-scroll">
        <table className="invoice-table">
          <thead>
            <tr>
              <th>Invoice</th>
              <th>Period</th>
              <th>Dates</th>
              <th className="num">Tracked</th>
              <th className="num">Billable</th>
              {settings.hourlyRate > 0 && <th className="num">Amount</th>}
              <th />
            </tr>
          </thead>
          <tbody>
            {periods.map((p) => (
              <tr key={p.key} className={p.inProgress ? 'in-progress' : ''}>
                <td className="mono">{p.invoiceNumber}</td>
                <td>
                  {p.label}
                  {p.inProgress && <span className="pill">Open</span>}
                </td>
                <td className="muted">
                  {fmtDate(p.startUtc)} → {fmtDate(p.endUtc - 1)}
                </td>
                <td className="num muted">{formatCompact(p.rawSeconds)}</td>
                <td className="num">{formatHours(p.billedSeconds)} h</td>
                {settings.hourlyRate > 0 && (
                  <td className="num strong">
                    {formatMoney(p.grandTotal, settings.currency)}
                    {p.extrasCount > 0 && (
                      <span
                        className="extras-note"
                        title={`Includes ${formatMoney(p.extrasTotal, settings.currency)} of additional line items`}
                      >
                        +{p.extrasCount}
                      </span>
                    )}
                  </td>
                )}
                <td className="num">
                  {/* A normal link: the document is rendered by the Worker, not the SPA. */}
                  <a className="button-link" href={`/invoice/${p.key}`} target="_blank" rel="noreferrer">
                    Open ↗
                  </a>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
        </div>
      )}
    </div>
  );
}
