import { useCallback, useEffect, useState } from 'react';
import type { Settings } from '../shared/types';
import { api } from './api';
import { useRoute } from './router';
import { TimerPage } from './pages/TimerPage';
import { InvoiceSettingsPage } from './pages/InvoiceSettingsPage';
import { InvoicesPage } from './pages/InvoicesPage';
import { ImportPage } from './pages/ImportPage';
import { ClockIcon, DocumentIcon, GearIcon, UploadIcon } from './components/Icons';

const NAV = [
  { path: '/', label: 'Time tracker', Icon: ClockIcon },
  { path: '/invoices', label: 'Invoices', Icon: DocumentIcon },
  { path: '/settings', label: 'Invoice settings', Icon: GearIcon },
  { path: '/import', label: 'Import', Icon: UploadIcon },
];

export function App() {
  const [path, navigate] = useRoute();
  const [settings, setSettings] = useState<Settings | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    api
      .state()
      .then((s) => setSettings(s.settings))
      .catch((e: Error) => setError(e.message));
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
        {settings && path === '/' && <TimerPage settings={settings} />}
        {settings && path === '/invoices' && <InvoicesPage onNavigate={navigate} />}
        {settings && path === '/settings' && (
          <InvoiceSettingsPage settings={settings} onSaved={setSettings} />
        )}
        {settings && path === '/import' && <ImportPage settings={settings} />}
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
