import type { Entry, InvoiceLayout, Settings } from '../shared/types';
import { buildInvoice, findPeriod, listPeriods, summarisePeriod } from '../shared/invoice';
import { renderInvoiceHtml } from './invoiceHtml';
import { requireAccess } from './access';
import { runImport } from './import';
import type { ImportOptions } from './import';
import {
  HttpError,
  addExtra,
  deleteEntry,
  deleteExtra,
  listAllExtras,
  listExtras,
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
        return await handleInvoiceRoutes(request, env, url, now);
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
    const [entries, extrasByPeriod] = await Promise.all([
      listEntries(db, earliest, latest),
      listAllExtras(db),
    ]);

    return {
      settings,
      periods: periods.map((p) =>
        summarisePeriod(p, settings, entries, now, extrasByPeriod.get(p.key) ?? []),
      ),
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
  const [entries, extras] = await Promise.all([
    listEntries(env.DB, period.startUtc, period.endUtc),
    listExtras(env.DB, key),
  ]);
  return buildInvoice(period, settings, entries, now, extras);
}

const TRUE_TOKENS = new Set(['1', 'true', 'on', 'yes']);
const FALSE_TOKENS = new Set(['0', 'false', 'off', 'no']);

/**
 * Read a layout toggle from the query string.
 *
 * The toolbar form submits a hidden "0" ahead of each checkbox so an unchecked
 * box still sends a value, which means the *last* occurrence is authoritative.
 *
 * Only explicitly recognised tokens decide anything; an absent, empty or
 * unrecognised value falls back to the configured default. Treating a typo as
 * "off" would quietly hand back a summary invoice when a detailed one was
 * meant, and these URLs are documented for headless rendering where nobody is
 * looking at the checkboxes.
 */
function layoutFlag(url: URL, name: string, fallback: boolean): boolean {
  const values = url.searchParams.getAll(name);
  for (let i = values.length - 1; i >= 0; i--) {
    const token = values[i].trim().toLowerCase();
    if (TRUE_TOKENS.has(token)) return true;
    if (FALSE_TOKENS.has(token)) return false;
  }
  return fallback;
}

/**
 * The invoice document, plus the form posts that manage its extra line items.
 *
 * Those posts redirect back to the document (303) rather than answering with it,
 * so a refresh after adding a line does not re-submit the form. The layout query
 * string is carried through so the view the user was in survives the round trip.
 */
async function handleInvoiceRoutes(
  request: Request,
  env: Env,
  url: URL,
  now: number,
): Promise<Response> {
  const method = request.method.toUpperCase();

  const addMatch = /^\/invoice\/(\d{4}-\d{2})\/extras$/.exec(url.pathname);
  if (addMatch && method === 'POST') {
    const key = addMatch[1];
    // Reject a post against a period that does not exist before writing anything.
    await loadInvoice(env, key, now);
    const form = await request.formData();
    const amountText = String(form.get('amount') ?? '').trim();
    const amount = Number(amountText);
    if (amountText === '' || !Number.isFinite(amount)) {
      throw new HttpError(400, 'Amount must be a number');
    }
    await addExtra(env.DB, key, String(form.get('description') ?? ''), amount, now);
    return redirectToInvoice(key, form);
  }

  const deleteMatch = /^\/invoice\/(\d{4}-\d{2})\/extras\/([A-Za-z0-9-]+)\/delete$/.exec(url.pathname);
  if (deleteMatch && method === 'POST') {
    const [, key, id] = deleteMatch;
    const form = await request.formData();
    if (!(await deleteExtra(env.DB, key, id))) throw new HttpError(404, 'Line item not found');
    return redirectToInvoice(key, form);
  }

  const pageMatch = /^\/invoice\/(\d{4}-\d{2})$/.exec(url.pathname);
  if (!pageMatch || method !== 'GET') return new Response('Not found', { status: 404 });

  const invoice = await loadInvoice(env, pageMatch[1], now);
  const layout: InvoiceLayout = {
    detailedInvoice: layoutFlag(url, 'detailed', invoice.settings.defaultDetailedInvoice),
    detailedTimeLog: layoutFlag(url, 'timelog', invoice.settings.defaultDetailedTimeLog),
  };
  return new Response(renderInvoiceHtml(invoice, layout), {
    headers: {
      'Content-Type': 'text/html; charset=utf-8',
      // The document reflects live tracked time; never let it be cached.
      'Cache-Control': 'no-store',
    },
  });
}

function redirectToInvoice(key: string, form: FormData): Response {
  const params = new URLSearchParams();
  for (const name of ['detailed', 'timelog']) {
    const value = form.get(name);
    if (typeof value === 'string' && value !== '') params.set(name, value);
  }
  const query = params.toString();
  return new Response(null, {
    status: 303,
    headers: { Location: `/invoice/${key}${query ? `?${query}` : ''}` },
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
