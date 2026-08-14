import { useCallback, useEffect, useState } from 'react';
import type { Client, Settings } from '../shared/types';
import { api } from './api';
import { useRoute } from './router';
import { TimerPage } from './pages/TimerPage';
import { SettingsPage } from './pages/SettingsPage';
import { ClientsPage } from './pages/ClientsPage';
import { InvoicesPage } from './pages/InvoicesPage';
import { ImportPage } from './pages/ImportPage';
import { ClockIcon, DocumentIcon, GearIcon, UploadIcon, UsersIcon } from './components/Icons';
import { applyTimerFavicon, watchColourScheme } from './favicon';

const NAV = [
  { path: '/', label: 'Time tracker', Icon: ClockIcon },
  { path: '/invoices', label: 'Invoices', Icon: DocumentIcon },
  { path: '/clients', label: 'Clients', Icon: UsersIcon },
  { path: '/settings', label: 'Settings', Icon: GearIcon },
  { path: '/import', label: 'Import', Icon: UploadIcon },
];

export function App() {
  const [path, navigate] = useRoute();
  const [settings, setSettings] = useState<Settings | null>(null);
  const [clients, setClients] = useState<Client[]>([]);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    const check = () =>
      api
        .state()
        .then((s) => {
          if (cancelled) return;
          setSettings(s.settings);
          setClients(s.clients);
          applyTimerFavicon(s.running !== null);
        })
        .catch((e: Error) => {
          if (!cancelled) setError(e.message);
        });

    void check();

    // The tab icon has to be right on every page, not just the tracker, and the
    // timer may have been started on another device. A slow poll plus a refresh
    // on focus keeps it honest without another live connection; the tracker page
    // updates it immediately on start/stop, so this never lags where it matters.
    const id = window.setInterval(() => {
      if (!document.hidden) void check();
    }, 60_000);
    const onFocus = () => void check();
    window.addEventListener('focus', onFocus);
    const stopWatchingScheme = watchColourScheme();

    return () => {
      cancelled = true;
      window.clearInterval(id);
      window.removeEventListener('focus', onFocus);
      stopWatchingScheme();
    };
  }, []);

  // Intercept in-app links so the sidebar navigates without a full reload,
  // while the invoice documents (rendered by the Worker) still load normally.
  const onNavClick = useCallback(
    (event: React.MouseEvent, target: string) => {
      event.preventDefault();
      navigate(target);
    },
    [navigate],
  );

  return (
    <div className="app">
      <aside className="sidebar">
        <div className="brand">
          <span className="brand-mark">
            <ClockIcon size={20} />
          </span>
          <span className="brand-name">Time Track</span>
        </div>
        <nav>
          {NAV.map((item) => (
            <a
              key={item.path}
              href={item.path}
              className={path === item.path ? 'nav-item active' : 'nav-item'}
              onClick={(e) => onNavClick(e, item.path)}
            >
              <span className="nav-icon">
                <item.Icon size={17} />
              </span>
              {item.label}
            </a>
          ))}
        </nav>
        {settings && <div className="sidebar-foot">{settings.timezone}</div>}
      </aside>

      <main className="content">
        {error && <div className="banner error">{error}</div>}
        {!settings && !error && <div className="loading">Loading…</div>}
        {settings && path === '/' && <TimerPage settings={settings} clients={clients} />}
        {settings && path === '/invoices' && (
          <InvoicesPage
            clients={clients}
            defaultClientId={settings.defaultClientId}
            onNavigate={navigate}
          />
        )}
        {settings && path === '/clients' && (
          <ClientsPage settings={settings} clients={clients} onClientsChanged={setClients} />
        )}
        {settings && path === '/settings' && (
          <SettingsPage
            settings={settings}
            clients={clients}
            onSaved={setSettings}
            onNavigate={navigate}
          />
        )}
        {settings && path === '/import' && <ImportPage settings={settings} clients={clients} />}
        {settings && !NAV.some((n) => n.path === path) && (
          <div className="empty-state">
            <h1>Nothing here</h1>
            <p>
              <a href="/" onClick={(e) => onNavClick(e, '/')}>
                Back to the time tracker
              </a>
            </p>
          </div>
        )}
      </main>
    </div>
  );
}
