import type { Client, Entry, InvoiceLayout, Settings } from '../shared/types';
import { buildInvoice, findPeriod, invoiceConfig, listPeriods, summarisePeriod } from '../shared/invoice';
import { renderInvoiceHtml } from './invoiceHtml';
import { requireAccess } from './access';
import { runImport } from './import';
import type { ImportOptions } from './import';
import {
  HttpError,
  addExtra,
  createClient,
  getClient,
  listClients,
  resolveClient,
  updateClient,
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
    const [settings, clients, running] = await Promise.all([
      getSettings(db),
      listClients(db),
      getRunningEntry(db),
    ]);
    return { settings, clients, running, now };
  }

  // --- clients ------------------------------------------------------------
  if (path === '/clients') {
    if (method === 'GET') return { clients: await listClients(db) };
    if (method === 'POST') {
      const body = (await readJson(request)) as Partial<Client>;
      return { client: await createClient(db, body, now) };
    }
    throw new HttpError(405, 'Method not allowed');
  }

  const clientMatch = /^\/clients\/([A-Za-z0-9-]+)$/.exec(path);
  if (clientMatch && method === 'PATCH') {
    const body = (await readJson(request)) as Partial<Client>;
    return { client: await updateClient(db, clientMatch[1], body, now) };
  }

  if (path === '/timer/start' && method === 'POST') {
    const body = (await readJson(request)) as { description?: string; clientId?: string };
    const settings = await getSettings(db);
    const clientId = body.clientId ?? settings.defaultClientId;
    if (!(await getClient(db, clientId))) throw new HttpError(400, 'Unknown client');
    return { entry: await startEntry(db, clientId, body.description ?? '', now) };
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
      // No client filter by default: the calendar shows every client's day.
      const clientId = url.searchParams.get('clientId') ?? undefined;
      return { entries: await listEntries(db, from, to, clientId), now };
    }
    if (method === 'POST') {
      // Manual entry: a completed block of time added after the fact.
      const body = (await readJson(request)) as {
        clientId?: string;
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
      const settings = await getSettings(db);
      const clientId = body.clientId ?? settings.defaultClientId;
      if (!(await getClient(db, clientId))) throw new HttpError(400, 'Unknown client');
      const entry: Entry = {
        id: crypto.randomUUID(),
        clientId,
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
        clientId?: string;
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
    const body = (await readJson(request)) as Partial<ImportOptions> & { clientId?: string };
    const settings = await getSettings(db);
    const client = body.clientId
      ? await getClient(db, body.clientId)
      : await getClient(db, settings.defaultClientId);
    if (!client) throw new HttpError(400, 'Unknown client');
    const config = invoiceConfig(settings, client);
    return {
      report: await runImport(
        db,
        config,
        client,
        {
          csv: typeof body.csv === 'string' ? body.csv : '',
          timezone: typeof body.timezone === 'string' ? body.timezone : config.timezone,
          skipNonBillable: body.skipNonBillable === true,
          // Committing must be asked for explicitly; anything else previews.
          dryRun: body.dryRun !== false,
        },
        now,
      ),
    };
  }

  if (path === '/suggestions' && method === 'GET') {
    return {
      suggestions: await suggestDescriptions(
        db,
        url.searchParams.get('q') ?? '',
        url.searchParams.get('clientId'),
      ),
    };
  }

  // --- invoices -----------------------------------------------------------
  if (path === '/invoices' && method === 'GET') {
    const settings = await getSettings(db);
    const client = await resolveClient(db, url.searchParams.get('client'), settings);
    const config = invoiceConfig(settings, client);
    const periods = listPeriods(config, now);
    if (periods.length === 0) return { config, client, periods: [], now };

    // One query spanning every period, then summarise in memory — cheaper than
    // a round trip per month and the dataset is a personal-scale time log.
    const earliest = periods[periods.length - 1].startUtc;
    const latest = periods[0].endUtc;
    const [entries, extrasByPeriod] = await Promise.all([
      listEntries(db, earliest, latest, client.id),
      listAllExtras(db, client.id),
    ]);

    return {
      config,
      client,
      periods: periods.map((p) =>
        summarisePeriod(p, config, entries, now, extrasByPeriod.get(p.key) ?? []),
      ),
      now,
    };
  }

  const invoiceMatch = /^\/invoices\/([a-z0-9-]+)\/(\d{4}-\d{2})$/.exec(path);
  if (invoiceMatch && method === 'GET') {
    return { invoice: await loadInvoice(env, invoiceMatch[1], invoiceMatch[2], now) };
  }

  throw new HttpError(404, 'Not found');
}

async function loadInvoice(env: Env, clientSlug: string, key: string, now: number) {
  const settings = await getSettings(env.DB);
  const client = await resolveClient(env.DB, clientSlug, settings);
  const config = invoiceConfig(settings, client);
  const period = findPeriod(config, key, now);
  if (!period) throw new HttpError(404, `No invoice period ${key} for ${client.name}`);
  const [entries, extras] = await Promise.all([
    listEntries(env.DB, period.startUtc, period.endUtc, client.id),
    listExtras(env.DB, client.id, key),
  ]);
  return buildInvoice(period, config, entries, now, extras);
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

  // Old single-client URLs. Kept working by sending them to the default client,
  // so invoices bookmarked before clients existed still resolve.
  const legacy = /^\/invoice\/(\d{4}-\d{2})$/.exec(url.pathname);
  if (legacy && method === 'GET') {
    const settings = await getSettings(env.DB);
    const client = await resolveClient(env.DB, null, settings);
    return new Response(null, {
      status: 301,
      headers: { Location: `/invoice/${client.slug}/${legacy[1]}${url.search}` },
    });
  }

  const addMatch = /^\/invoice\/([a-z0-9-]+)\/(\d{4}-\d{2})\/extras$/.exec(url.pathname);
  if (addMatch && method === 'POST') {
    const [, clientSlug, key] = addMatch;
    // Reject a post against a period that does not exist before writing anything.
    const invoice = await loadInvoice(env, clientSlug, key, now);
    const form = await request.formData();
    const amountText = String(form.get('amount') ?? '').trim();
    const amount = Number(amountText);
    if (amountText === '' || !Number.isFinite(amount)) {
      throw new HttpError(400, 'Amount must be a number');
    }
    await addExtra(env.DB, invoice.config.clientId, key, String(form.get('description') ?? ''), amount, now);
    return redirectToInvoice(clientSlug, key, form);
  }

  const deleteMatch = /^\/invoice\/([a-z0-9-]+)\/(\d{4}-\d{2})\/extras\/([A-Za-z0-9-]+)\/delete$/.exec(
    url.pathname,
  );
  if (deleteMatch && method === 'POST') {
    const [, clientSlug, key, id] = deleteMatch;
    const invoice = await loadInvoice(env, clientSlug, key, now);
    const form = await request.formData();
    if (!(await deleteExtra(env.DB, invoice.config.clientId, key, id))) {
      throw new HttpError(404, 'Line item not found');
    }
    return redirectToInvoice(clientSlug, key, form);
  }

  const pageMatch = /^\/invoice\/([a-z0-9-]+)\/(\d{4}-\d{2})$/.exec(url.pathname);
  if (!pageMatch || method !== 'GET') return new Response('Not found', { status: 404 });

  const invoice = await loadInvoice(env, pageMatch[1], pageMatch[2], now);
  const layout: InvoiceLayout = {
    detailedInvoice: layoutFlag(url, 'detailed', invoice.config.defaultDetailedInvoice),
    detailedTimeLog: layoutFlag(url, 'timelog', invoice.config.defaultDetailedTimeLog),
  };
  return new Response(renderInvoiceHtml(invoice, layout), {
    headers: {
      'Content-Type': 'text/html; charset=utf-8',
      // The document reflects live tracked time; never let it be cached.
      'Cache-Control': 'no-store',
    },
  });
}

function redirectToInvoice(clientSlug: string, key: string, form: FormData): Response {
  const params = new URLSearchParams();
  for (const name of ['detailed', 'timelog']) {
    const value = form.get(name);
    if (typeof value === 'string' && value !== '') params.set(name, value);
  }
  const query = params.toString();
  return new Response(null, {
    status: 303,
    headers: { Location: `/invoice/${clientSlug}/${key}${query ? `?${query}` : ''}` },
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
