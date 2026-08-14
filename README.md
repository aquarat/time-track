# Time Track

A small time tracker with deterministic invoicing.

Toggl's invoicing asks you to re-specify a date range and report options every single
time. Here the invoice period, sequence number, rounding rule and footer are configured
once; every invoice after that is a pure function of those settings and your tracked time.
Opening an invoice is one click and asks no questions.

## Stack

- **One Cloudflare Worker** serving both the API and the React SPA via Static Assets.
  (Cloudflare recommends this over Pages for new projects; Pages no longer gets new features.)
- **D1** for all storage — time entries and the single settings row.
- **Cloudflare Access** for authentication, verified again inside the Worker.
- **Bun** for installing, building and testing. **Vite + React + TypeScript** for the client.

## Layout

```
src/shared/    time.ts (timezone maths), invoice.ts (period + rounding), types.ts
src/worker/    index.ts (router), db.ts (D1), access.ts (JWT), invoiceHtml.ts (print doc)
src/client/    App.tsx, pages/, components/
migrations/    D1 schema
tests/         invoice + calendar maths
```

`src/shared` is imported by both the Worker and the browser, so the invoice you see in the
settings preview is computed by exactly the same code that renders the final document.

## Data model

Two tables, both in D1 (`migrations/0001_init.sql`).

**`entries`** — one row per tracked block.

| Column | Notes |
|---|---|
| `id` | UUID |
| `description` | Free text, `''` allowed |
| `started_at` | UTC epoch **milliseconds** |
| `ended_at` | UTC epoch ms, or `NULL` while the timer runs |
| `created_at`, `updated_at` | UTC epoch ms |

A partial index on `ended_at WHERE ended_at IS NULL` keeps "is a timer running?" a point
lookup. At most one row may have `ended_at IS NULL`; starting a timer, or reopening an
entry via `PATCH`, closes any other open row first.

**`settings`** — a single row pinned by `CHECK (id = 1)`, holding everything on the invoice
settings page. There is no users table: the app is single-tenant by construction, and
identity is handled entirely by Cloudflare Access.

No invoice is ever stored. Invoices are derived on read from `settings` + `entries`, which
is what makes numbering impossible to corrupt.

## API

All routes are JSON except `/invoice/:period`, and all sit behind the Access check.

| Method | Route | Purpose |
|---|---|---|
| `GET` | `/api/state` | Settings, the running entry (if any), and server time |
| `GET` | `/api/entries?from=&to=` | Entries overlapping a UTC-ms window |
| `POST` | `/api/entries` | Create a completed entry (manual logging) |
| `PATCH` | `/api/entries/:id` | Edit description, `startedAt`, `endedAt` |
| `DELETE` | `/api/entries/:id` | Remove an entry |
| `POST` | `/api/timer/start` | Stop any running timer, start a new one |
| `POST` | `/api/timer/stop` | Stop the running timer |
| `GET` | `/api/suggestions?q=` | Past descriptions, most-recently-used first |
| `GET` | `/api/settings` · `PUT` | Read / update the settings row |
| `GET` | `/api/invoices` | All periods that have begun, with totals |
| `GET` | `/api/invoices/:period` | One invoice as JSON (`:period` is `YYYY-MM`) |
| `GET` | `/invoice/:period` | The same invoice as print-ready HTML |

Client clocks are never trusted for billing: `now` always comes from the Worker, so a
running timer is valued against server time.

## First-time setup

```bash
bun install

# 1. Create the database, then paste the returned id into wrangler.jsonc
bunx wrangler d1 create time-track

# 2. Apply the schema
bun run db:migrate            # remote
bun run db:migrate:local      # local dev copy

# 3. Build and deploy
bun run deploy
```

Then attach the custom domain. `wrangler.jsonc` already declares
`time-track.example.com` as a custom domain route, so `bun run deploy` will claim it
provided the zone is on your account. `workers_dev` is deliberately `false` — a live
`*.workers.dev` hostname would sit outside the Access policy below.

## Locking it down with Cloudflare Access

1. Zero Trust → Access → Applications → **Add a self-hosted application**.
2. Domain `time-track.example.com`, path blank (protect everything).
3. Add a policy: Action **Allow**, rule `Emails` → your address.
4. Copy the **Application Audience (AUD) tag** from the app's Overview tab.
5. Put your team domain and that AUD into `wrangler.jsonc` `vars`:

```jsonc
"vars": {
  "ACCESS_TEAM_DOMAIN": "yourteam.cloudflareaccess.com",
  "ACCESS_AUD": "<the AUD tag>"
}
```

6. `bun run deploy`.

Access blocks unauthenticated requests at the edge; the Worker independently verifies the
signed `Cf-Access-Jwt-Assertion` (issuer, audience, expiry, RS256 signature against the
team's rotating public keys, cached for an hour). Either alone would do — together, a
routing mistake can't quietly expose the database.

Three settings make that gate unbypassable, and all three matter:

- `workers_dev: false` — a live `*.workers.dev` hostname would be a second front door that
  the Access application (bound to the custom domain) does not cover.
- `assets.run_worker_first: true` — every request enters the Worker, so the check covers
  the SPA shell as well as `/api/*`. Scoping it to API routes lets the asset worker serve
  HTML without ever consulting the gate.
- Verifying `aud` against the Application Audience tag — without it, any valid token from
  the same Zero Trust team would be accepted, including from unrelated applications.

**While both vars are empty the app is completely open.** That is intentional so
`wrangler dev` works offline. Deployed with a non-empty team domain but no valid token, the
Worker fails closed (`401`), so setting the vars before the Access application exists locks
the app rather than exposing it.

## Local development

```bash
bun run db:migrate:local
bunx wrangler dev            # API + assets on :8787
bun run dev                  # optional: Vite with HMR on :5173, proxying to :8787
bun run seed:dev             # fill the local DB with plausible tracked time
bun test                     # invoice and calendar maths
```

`bun run build` must have run at least once before `wrangler dev`, since the Worker
serves the SPA out of `dist/client`.

## How invoicing works

**Periods.** With a period day of 26, each period runs from midnight on the 26th to
midnight on the 26th of the next month, *in your configured timezone*. Since you're
UTC+2, "26 January 2026 00:00" is stored as `2026-01-25T22:00Z`. Consecutive periods abut
exactly, so no tracked minute can fall between two invoices or into both.

A period day past the end of a short month clamps to that month's last day (a cut-over of
the 31st still yields exactly twelve periods a year).

**Numbering.** Sequence numbers come from position, not from a counter: the starting
month gets the starting sequence, and each later period increments by one. Nothing is
stored per invoice, so numbers can never drift, skip or double-issue.

**Period naming — worth a look.** Your spec said a period runs 26 Jan → 26 Feb *and* that
on 14 August the list should reach August. Those don't quite agree: on 14 August the
period actually in progress is the one that began 26 July. Rather than guess, both
conventions are available under *Period naming*:

| Mode | "January 2026" covers | Latest entry on 14 Aug 2026 |
|---|---|---|
| **Named for the month it starts in** (default, as literally specced) | 26 Jan → 26 Feb | July 2026 |
| **Named for the month it ends in** | 26 Dec → 26 Jan | August 2026 |

The boundaries are identical either way — only the labels and therefore which sequence
number lands on which month shift. Pick whichever matches the invoices you've already
sent, because changing it later renumbers everything.

**Rounding** is applied per line item — once per distinct task description — not to each
timer run and not to the grand total. Rounding each run would inflate a day of short
check-ins; rounding only the total would leave the printed line items not adding up to the
amount charged. Tracked time is always printed alongside the billed hours.

**The open period** is always listed and always billable-to-date, with a running timer
counted up to the moment you open the document.

## The invoice document

`/invoice/2026-06` is server-rendered HTML with no client JavaScript, laid out for A4.
Print or Save-as-PDF from the browser. It carries the logo, both addresses, line items
grouped by task, totals, the rounding note, a day-by-day time log for a client who wants
to check the detail, and your footer.

## Notes

- Everything belongs to one implicit project. The schema keeps `entries` free of a project
  column for now; adding one later is an additive migration.
- The logo is stored as a data URL in the settings row, capped at ~350KB — this avoids
  adding R2 for a single small image.
- Starting a timer while another runs stops the previous one, as Toggl does.
- Time entries store UTC instants. Changing the timezone setting re-buckets the calendar
  and moves period boundaries; it never rewrites stored entries.
