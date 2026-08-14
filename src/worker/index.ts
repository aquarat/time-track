import type { Entry, Settings } from '../shared/types';
import { buildInvoice, findPeriod, listPeriods, summarisePeriod } from '../shared/invoice';
import { renderInvoiceHtml } from './invoiceHtml';
import { requireAccess } from './access';
import { runImport } from './import';
import type { ImportOptions } from './import';
import {
  HttpError,
  deleteEntry,
  getRunningEntry,
  getSettings,
  insertEntry,
  listEntries,
  saveSettings,
  startEntry,
  stopRunningEntries,
  suggestDescriptions,
  updateEntry,
} from './db';

export interface Env {
  DB: D1Database;
  ASSETS: Fetcher;
  ACCESS_TEAM_DOMAIN?: string;
  ACCESS_AUD?: string;
}

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    const now = Date.now();

    const denied = await requireAccess(request, env, now);
    if (denied) return denied;

    const url = new URL(request.url);
    try {
      if (url.pathname.startsWith('/api/')) {
        return json(await handleApi(request, env, url, now));
      }
      if (url.pathname.startsWith('/invoice/')) {
        return await handleInvoicePage(env, url, now);
      }
    } catch (err) {
      if (err instanceof HttpError) {
        return url.pathname.startsWith('/api/')
          ? json({ error: err.message }, err.status)
          : new Response(err.message, { status: err.status });
      }
      console.error('Unhandled error', err);
      return json({ error: 'Internal error' }, 500);
    }

    // Everything else is the SPA, served by the assets binding.
    return env.ASSETS.fetch(request);
  },
} satisfies ExportedHandler<Env>;

async function handleApi(request: Request, env: Env, url: URL, now: number): Promise<unknown> {
  const db = env.DB;
  const path = url.pathname.slice('/api'.length);
  const method = request.method.toUpperCase();

  // --- settings -----------------------------------------------------------
  if (path === '/settings') {
    if (method === 'GET') return { settings: await getSettings(db) };
    if (method === 'PUT') {
      const patch = (await readJson(request)) as Partial<Settings>;
      return { settings: await saveSettings(db, patch, now) };
    }
    throw new HttpError(405, 'Method not allowed');
  }

  // --- timer state --------------------------------------------------------
  if (path === '/state' && method === 'GET') {
    const settings = await getSettings(db);
    return { settings, running: await getRunningEntry(db), now };
  }

  if (path === '/timer/start' && method === 'POST') {
    const body = (await readJson(request)) as { description?: string };
    return { entry: await startEntry(db, body.description ?? '', now) };
  }

  if (path === '/timer/stop' && method === 'POST') {
    return { entry: await stopRunningEntries(db, now) };
  }

  // --- entries ------------------------------------------------------------
  if (path === '/entries') {
    if (method === 'GET') {
      const from = numberParam(url, 'from');
      const to = numberParam(url, 'to');
      if (from === null || to === null) throw new HttpError(400, 'from and to query params are required');
      return { entries: await listEntries(db, from, to), now };
    }
    if (method === 'POST') {
      // Manual entry: a completed block of time added after the fact.
      const body = (await readJson(request)) as {
        description?: string;
        startedAt?: number;
        endedAt?: number;
      };
      if (!Number.isFinite(body.startedAt) || !Number.isFinite(body.endedAt)) {
        throw new HttpError(400, 'startedAt and endedAt are required');
      }
      const startedAt = body.startedAt as number;
      const endedAt = body.endedAt as number;
      if (endedAt < startedAt) throw new HttpError(400, 'Entry cannot end before it starts');
      const entry: Entry = {
        id: crypto.randomUUID(),
        description: (body.description ?? '').trim(),
        startedAt,
        endedAt,
        createdAt: now,
        updatedAt: now,
      };
      await insertEntry(db, entry);
      return { entry };
    }
    throw new HttpError(405, 'Method not allowed');
  }

  const entryMatch = /^\/entries\/([A-Za-z0-9-]+)$/.exec(path);
  if (entryMatch) {
    const id = entryMatch[1];
    if (method === 'PATCH') {
      const patch = (await readJson(request)) as {
        description?: string;
        startedAt?: number;
        endedAt?: number | null;
      };
      return { entry: await updateEntry(db, id, patch, now) };
    }
    if (method === 'DELETE') {
      if (!(await deleteEntry(db, id))) throw new HttpError(404, 'Entry not found');
      return { ok: true };
    }
    throw new HttpError(405, 'Method not allowed');
  }

  // --- import ------------------------------------------------------------
  if (path === '/import' && method === 'POST') {
    const body = (await readJson(request)) as Partial<ImportOptions>;
    const settings = await getSettings(db);
    return {
      report: await runImport(
        db,
        settings,
        {
          csv: typeof body.csv === 'string' ? body.csv : '',
          timezone: typeof body.timezone === 'string' ? body.timezone : settings.timezone,
          skipNonBillable: body.skipNonBillable === true,
          // Committing must be asked for explicitly; anything else previews.
          dryRun: body.dryRun !== false,
        },
        now,
      ),
    };
  }

  if (path === '/suggestions' && method === 'GET') {
    return { suggestions: await suggestDescriptions(db, url.searchParams.get('q') ?? '') };
  }

  // --- invoices -----------------------------------------------------------
  if (path === '/invoices' && method === 'GET') {
    const settings = await getSettings(db);
    const periods = listPeriods(settings, now);
    if (periods.length === 0) return { settings, periods: [], now };

    // One query spanning every period, then summarise in memory — cheaper than
    // a round trip per month and the dataset is a personal-scale time log.
    const earliest = periods[periods.length - 1].startUtc;
    const latest = periods[0].endUtc;
    const entries = await listEntries(db, earliest, latest);

    return {
      settings,
      periods: periods.map((p) => summarisePeriod(p, settings, entries, now)),
      now,
    };
  }

  const invoiceMatch = /^\/invoices\/(\d{4}-\d{2})$/.exec(path);
  if (invoiceMatch && method === 'GET') {
    return { invoice: await loadInvoice(env, invoiceMatch[1], now) };
  }

  throw new HttpError(404, 'Not found');
}

async function loadInvoice(env: Env, key: string, now: number) {
  const settings = await getSettings(env.DB);
  const period = findPeriod(settings, key, now);
  if (!period) throw new HttpError(404, `No invoice period ${key}`);
  const entries = await listEntries(env.DB, period.startUtc, period.endUtc);
  return buildInvoice(period, settings, entries, now);
}

async function handleInvoicePage(env: Env, url: URL, now: number): Promise<Response> {
  const match = /^\/invoice\/(\d{4}-\d{2})$/.exec(url.pathname);
  if (!match) return new Response('Not found', { status: 404 });
  const invoice = await loadInvoice(env, match[1], now);
  return new Response(renderInvoiceHtml(invoice), {
    headers: {
      'Content-Type': 'text/html; charset=utf-8',
      // The document reflects live tracked time; never let it be cached.
      'Cache-Control': 'no-store',
    },
  });
}

async function readJson(request: Request): Promise<unknown> {
  try {
    return await request.json();
  } catch {
    throw new HttpError(400, 'Invalid JSON body');
  }
}

function numberParam(url: URL, name: string): number | null {
  const raw = url.searchParams.get(name);
  if (raw === null) return null;
  const n = Number(raw);
  return Number.isFinite(n) ? n : null;
}

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' },
  });
}
