import type { Client, Entry, Invoice, InvoiceConfig, PeriodSummary, Settings } from '../shared/types';
import type { ImportReport } from '../shared/togglCsv';

async function request<T>(path: string, init?: RequestInit): Promise<T> {
  const res = await fetch(path, {
    ...init,
    headers: init?.body ? { 'Content-Type': 'application/json', ...init?.headers } : init?.headers,
  });
  if (!res.ok) {
    let message = `${res.status} ${res.statusText}`;
    try {
      const body = (await res.json()) as { error?: string };
      if (body.error) message = body.error;
    } catch {
      /* non-JSON error body; the status line is the best we have */
    }
    throw new Error(message);
  }
  return (await res.json()) as T;
}

export const api = {
  state: () =>
    request<{ settings: Settings; clients: Client[]; running: Entry | null; now: number }>('/api/state'),

  clients: () => request<{ clients: Client[] }>('/api/clients'),

  createClient: (patch: Partial<Client>) =>
    request<{ client: Client }>('/api/clients', { method: 'POST', body: JSON.stringify(patch) }),

  updateClient: (id: string, patch: Partial<Client>) =>
    request<{ client: Client }>(`/api/clients/${id}`, { method: 'PATCH', body: JSON.stringify(patch) }),

  entries: (from: number, to: number) =>
    request<{ entries: Entry[]; now: number }>(`/api/entries?from=${from}&to=${to}`),

  startTimer: (description: string, clientId: string) =>
    request<{ entry: Entry }>('/api/timer/start', {
      method: 'POST',
      body: JSON.stringify({ description, clientId }),
    }),

  stopTimer: () => request<{ entry: Entry | null }>('/api/timer/stop', { method: 'POST' }),

  createEntry: (input: { clientId: string; description: string; startedAt: number; endedAt: number }) =>
    request<{ entry: Entry }>('/api/entries', { method: 'POST', body: JSON.stringify(input) }),

  updateEntry: (
    id: string,
    patch: { clientId?: string; description?: string; startedAt?: number; endedAt?: number | null },
  ) => request<{ entry: Entry }>(`/api/entries/${id}`, { method: 'PATCH', body: JSON.stringify(patch) }),

  deleteEntry: (id: string) => request<{ ok: true }>(`/api/entries/${id}`, { method: 'DELETE' }),

  suggestions: (q: string, clientId?: string) =>
    request<{ suggestions: string[] }>(
      `/api/suggestions?q=${encodeURIComponent(q)}${clientId ? `&clientId=${clientId}` : ''}`,
    ),

  settings: () => request<{ settings: Settings }>('/api/settings'),

  saveSettings: (patch: Partial<Settings>) =>
    request<{ settings: Settings }>('/api/settings', { method: 'PUT', body: JSON.stringify(patch) }),

  invoices: (clientSlug?: string) =>
    request<{ config: InvoiceConfig; client: Client; periods: PeriodSummary[]; now: number }>(
      `/api/invoices${clientSlug ? `?client=${encodeURIComponent(clientSlug)}` : ''}`,
    ),

  invoice: (clientSlug: string, key: string) =>
    request<{ invoice: Invoice }>(`/api/invoices/${clientSlug}/${key}`),

  importCsv: (input: {
    csv: string;
    clientId: string;
    timezone: string;
    skipNonBillable: boolean;
    dryRun: boolean;
  }) => request<{ report: ImportReport }>('/api/import', { method: 'POST', body: JSON.stringify(input) }),
};
