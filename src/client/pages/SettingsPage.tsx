import { useRef, useState } from 'react';
import type { Client, Settings } from '../../shared/types';
import { api } from '../api';

interface Props {
  settings: Settings;
  clients: Client[];
  onSaved: (settings: Settings) => void;
  onNavigate: (path: string) => void;
}

const TIMEZONES: string[] = (() => {
  const supported = (Intl as unknown as { supportedValuesOf?: (k: string) => string[] }).supportedValuesOf;
  if (typeof supported === 'function') {
    try {
      return supported('timeZone');
    } catch {
      /* fall through */
    }
  }
  return ['UTC', 'Europe/London', 'Africa/Johannesburg', 'America/New_York'];
})();

/**
 * Settings that belong to you rather than to any one client.
 *
 * Everything invoice-shaped moved to the Clients page when multiple clients were
 * added; what is left is your identity, the timezone all calendar and period
 * boundaries are measured in, and which client the app starts on.
 */
export function SettingsPage({ settings, clients, onSaved, onNavigate }: Props) {
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
      <h1>Settings</h1>
      <p className="page-intro">
        Your details and the defaults that apply everywhere. Rates, invoice numbering and payment
        terms live on{' '}
        <a
          href="/clients"
          onClick={(e) => {
            e.preventDefault();
            onNavigate('/clients');
          }}
        >
          each client
        </a>
        .
      </p>

      {error && <div className="banner error">{error}</div>}

      <form onSubmit={save}>
        <fieldset>
          <legend>General</legend>

          <label>
            <span>Timezone</span>
            <select value={draft.timezone} onChange={(e) => set('timezone', e.target.value)}>
              {TIMEZONES.includes(draft.timezone) ? null : (
                <option value={draft.timezone}>{draft.timezone}</option>
              )}
              {TIMEZONES.map((tz) => (
                <option key={tz} value={tz}>
                  {tz}
                </option>
              ))}
            </select>
            <small>
              Day boundaries and every client's invoice period boundaries are midnight in this zone.
              Your browser reports <code>{Intl.DateTimeFormat().resolvedOptions().timeZone}</code>.
            </small>
          </label>

          <label>
            <span>Default client</span>
            <select
              value={draft.defaultClientId}
              onChange={(e) => set('defaultClientId', e.target.value)}
            >
              {clients.map((c) => (
                <option key={c.id} value={c.id}>
                  {c.name}
                </option>
              ))}
            </select>
            <small>
              New time entries are attributed here, and the invoice list opens here. You can change
              the client on any individual entry.
            </small>
          </label>
        </fieldset>

        <fieldset>
          <legend>Your details</legend>
          <p className="fieldset-intro">These appear as the “From” side of every invoice.</p>

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
            <input
              type="text"
              value={draft.companyName}
              onChange={(e) => set('companyName', e.target.value)}
            />
          </label>

          <label>
            <span>Your address</span>
            <textarea
              rows={4}
              value={draft.companyAddress}
              onChange={(e) => set('companyAddress', e.target.value)}
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
