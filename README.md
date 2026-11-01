# Time Track

A small, self-hosted time tracker with deterministic invoicing, running entirely on
Cloudflare (one Worker, one D1 database, Cloudflare Access in front).

Most time trackers make you re-specify a date range and report options every time you
invoice. Here the invoice period, sequence number, rate, rounding rule and footer are
configured once per client; every invoice after that is a pure function of those settings
and your tracked time. Opening an invoice is one click and asks no questions, and nothing
about an invoice is stored, so numbering cannot drift, skip or double-issue.

It is single-tenant: one instance per person, with Cloudflare Access deciding who that is.

## Features

- **Timer** with a description box that stays editable while it runs, most-recently-used
  autocomplete, and a live clock.
- **Calendar** in day, week and month views: hour gridlines, a now-line, side-by-side lanes
  for overlapping entries, a month heatmap, and untracked gaps of five minutes or more.
  Click a block to edit it; drag its edges in the day view.
- **Multiple clients**, each with its own invoice series, rate, currency, period day,
  rounding, payment terms and calendar colour.
- **Invoices** as print-ready A4 HTML (print or save as PDF from the browser), with
  detailed or summary layouts, an optional day-by-day time log, and hand-entered line items
  for expenses, fixed fees or discounts.
- **Toggl Track import** from a detailed CSV export, previewed before anything is written.
- **Export** as a Toggl-compatible CSV or a complete JSON backup.
- Works on phones, and the tab icon shows whether a timer is running.

## Stack

- **One Cloudflare Worker** serving both the API and the React SPA via Static Assets.
- **D1** for all storage.
- **Cloudflare Access** for authentication, verified again inside the Worker.
- **Bun** for installing, building and testing; **Vite + React + TypeScript** for the
  client.

```
src/shared/    time.ts (timezone maths), invoice.ts (periods + rounding), types.ts
src/worker/    index.ts (router), db.ts (D1), access.ts (JWT), invoiceHtml.ts (print doc)
src/client/    App.tsx, pages/, components/
migrations/    D1 schema
scripts/       configure.ts (fills wrangler.jsonc), seed-dev.ts (local sample data)
tests/         invoice, calendar, import/export and access-gate tests
```

`src/shared` is imported by both the Worker and the browser, so what you see in the app
is computed by exactly the same code that renders the final invoice.

## Deploying your own instance

You need a Cloudflare account with a zone (domain) on it, and [Bun](https://bun.sh).
Cloudflare Access is part of Zero Trust, whose free plan covers this.

### 1. Database

```bash
bun install
bunx wrangler login
bunx wrangler d1 create time-track    # note the database_id it prints
```

### 2. Cloudflare Access

1. Zero Trust → Access → Applications → **Add a self-hosted application**.
2. Domain: the hostname you will serve the app on, e.g. `time.example.org`. Leave the path
   blank so everything is protected.
3. Add exactly one policy: Action **Allow**, rule `Emails` → the addresses that should get
   in. Don't add a second policy that includes `everyone`: a permissive policy at any
   precedence supersedes the restrictive one.
4. Copy the **Application Audience (AUD) tag** from the application's overview, and note
   your team domain (`<team>.cloudflareaccess.com`).

### 3. Configure

`wrangler.jsonc` has four `CONFIGURE-ME` placeholders. Edit them by hand, or let the
script fill them in:

```bash
TIME_TRACK_DOMAIN=time.example.org \
TIME_TRACK_D1_DATABASE_ID=<database_id from step 1> \
TIME_TRACK_ACCESS_TEAM_DOMAIN=<team>.cloudflareaccess.com \
TIME_TRACK_ACCESS_AUD=<AUD tag from step 2> \
bun run configure
```

If you deploy from a fork of this repository, keep that configured `wrangler.jsonc` out of
any public branch, or use CI as described below.

### 4. Migrate and deploy

```bash
bun run db:migrate    # applies migrations/ to the remote database
bun run deploy        # builds, then deploys the Worker and claims the custom domain
```

The custom domain route makes `wrangler deploy` create the DNS record and certificate,
provided the zone is on the same account. Open the domain, sign in through Access, and
start with **Settings** (your timezone, name, address and logo) and **Clients**.

### Deploying from CI

`.forgejo/workflows/deploy.yml` runs the typecheck, tests and build on every push and pull
request. On `main` it also deploys, provided the repository defines:

| Kind | Name | Value |
|---|---|---|
| Variable | `TIME_TRACK_DOMAIN`, `TIME_TRACK_D1_DATABASE_ID`, `TIME_TRACK_ACCESS_TEAM_DOMAIN`, `TIME_TRACK_ACCESS_AUD` | As in step 3 |
| Variable | `CLOUDFLARE_ACCOUNT_ID` | Your account id |
| Secret | `CLOUDFLARE_API_TOKEN` | A token with Workers Scripts Edit, D1 Edit and Account Settings Read on the account, plus Workers Routes Edit and Zone Read on the zone |

It configures `wrangler.jsonc` on the runner, applies any new migrations, deploys, and then
checks that an unauthenticated request is still redirected to Access. Without those
variables, only the checks run. The workflow is written for Forgejo Actions, but the steps
carry over to GitHub Actions with the `forgejo.` contexts renamed to `github.`.

`.forgejo/workflows/mirror.yml` optionally mirrors `main` and tags to a GitHub repository
(variable `GITHUB_MIRROR_REPO`, secret `MIRROR_SSH_KEY`).

## How the Access gate works

Access blocks unauthenticated requests at the edge, and the Worker independently verifies
the signed `Cf-Access-Jwt-Assertion` (issuer, audience, expiry, and RS256 signature
against the team's rotating public keys, cached for an hour). Either alone would do;
together, a routing mistake can't quietly expose the database.

Three settings in `wrangler.jsonc` close the remaining gaps:

- `workers_dev: false`: a live `*.workers.dev` hostname would be a second front door that
  the Access application, bound to your domain, does not cover.
- `assets.run_worker_first: true`: every request enters the Worker, so the check covers the
  SPA shell as well as `/api/*`.
- `ACCESS_AUD`: without the audience check, any valid token from the same Zero Trust team
  would be accepted, including tokens for unrelated applications.

The team domain and audience are not secrets (both are in the JWT the browser holds), so
they live in `vars` rather than in `wrangler secret`.

The Worker fails closed. With either value blank it refuses every request (`503`); with a
value that doesn't match a real assertion it returns `401`. The only way to run it without
Access is `ALLOW_UNAUTHENTICATED=true`, which belongs in `.dev.vars` for local development
and nowhere else.

## Local development

```bash
cp .dev.vars.example .dev.vars   # turns the Access gate off locally
bun run db:migrate:local
bun run build                    # wrangler dev serves the SPA from dist/client
bunx wrangler dev                # API + assets on :8787
bun run dev                      # optional: Vite with HMR on :5173, proxying to :8787
bun run seed:dev                 # optional: fill the local database with sample time
bun test
```

`.dev.vars` is gitignored and never uploaded by `wrangler deploy`.

## How invoicing works

**Periods.** With a period day of 26, each period runs from midnight on the 26th to
midnight on the 26th of the next month, *in your configured timezone*. Instants are stored
in UTC, so in a UTC+2 zone "26 January 2026 00:00" is stored as `2026-01-25T22:00Z`.
Consecutive periods abut exactly, so no tracked minute can fall between two invoices or
into both. A period day past the end of a short month clamps to that month's last day.

**Numbering.** Sequence numbers come from position, not a counter: the starting month
gets the starting sequence, and each later period increments by one.

**Period naming.** A period that runs 26 January → 26 February can be named for either
month, and both conventions are offered:

| Mode | "January 2026" covers | Latest period on 14 Aug 2026 |
|---|---|---|
| **Named for the month it starts in** (default) | 26 Jan → 26 Feb | July 2026 |
| **Named for the month it ends in** | 26 Dec → 26 Jan | August 2026 |

The boundaries are identical either way; only the labels move. Pick the one that matches
invoices you've already sent, because changing it later renumbers everything.

**Rounding** is applied per line item (once per distinct task description), not to each
timer run and not to the grand total. Rounding each run would inflate a day of short
check-ins; rounding only the total would leave the printed lines not adding up to the
amount charged.

**The open period** is always listed and billable to date, with a running timer counted
up to the moment you open the document. Client clocks are never trusted: `now` always
comes from the Worker.

### The invoice document

`/invoice/<client>/<period>` is server-rendered HTML laid out for A4. It carries your logo,
both addresses, line items, totals, an optional day-by-day time log, and your footer. Two
toolbar checkboxes, neither of which prints, change the layout:

| | On | Off |
|---|---|---|
| **Detailed invoice** | One line per task description, with tracked time beside billed hours | A single summary line, e.g. *Software development services - 26 January 2026 to 26 February 2026* |
| **Detailed time log** | Day-by-day breakdown on its own page | Omitted |

The amount due is identical either way: the summary line is the sum of the
already-rounded lines, never a re-rounding of the raw total. Defaults are set per client;
a per-invoice choice lives only in the query string (`?detailed=0&timelog=1`), so any
rendering is reproducible from its URL. The toolbar is a plain GET form and works without
JavaScript.

**Additional line items** (expenses, licences, a fixed fee, or a discount, since negative
amounts are allowed) belong to one client's period and appear beneath the time lines with
the hours and rate left blank. Adding and removing them are plain form posts that redirect
back, so a refresh never re-submits.

## Clients

Each client has its own invoice series and terms. Every place that creates or edits an
entry has a client selector, which hides itself while only one client exists. `Settings →
Default client` decides where new entries go and which client the invoice list opens on.
There is no delete: a client with invoices behind it should not vanish.

A client's slug forms its invoice URLs. It is editable, but changing it breaks links to
invoices already sent. The older `/invoice/<period>` form redirects to the default client.

## Editing time

- **Click a block in the calendar** to edit its description and times in a modal.
  Dismissing the modal saves rather than discards; a toast confirms the write. Invalid
  input keeps it open with the error.
- **Drag the top or bottom edge of a block** in the day view. Boundaries snap to 15
  minutes. Edges are only draggable where they are the entry's real ones, so not on a slice
  of an entry that spans midnight, and not on the end of a running timer.
- **Click a row in the entries list** to edit it inline.

The description box stays editable while a timer runs: it *is* that entry's description.
Edits save shortly after you stop typing, and immediately on blur, Enter, or Stop. Enter
never stops the timer. Starting a timer while another runs stops the first.

## Importing from Toggl

The **Import** page takes a Toggl Track *detailed* CSV export. Nothing is written until a
preview has been shown, and the preview runs the same code as the commit.

**Get the timezone right.** Toggl exports bare wall-clock times with no offset, so the
importer asks which zone they were read in. Use the same zone as the app and every entry
keeps the calendar day it had in Toggl.

- **Duplicates** (same start, end and description) are skipped, so re-importing a file is
  a no-op. Re-importing under a *different* timezone is not a duplicate, since those are
  different instants; delete the first attempt before retrying.
- Client, project, task and tag columns are ignored; choose the client on the Import page.
- Non-billable rows are imported by default (the app bills what it tracks); a checkbox
  skips them.
- The `Duration` column is cross-checked against the timestamps, and disagreements are
  reported rather than guessed at.
- Bad rows are listed with line numbers and never block the good ones.
- The preview breaks the import down per invoice period, so you can see which invoices it
  will change.

## Export and backup

Two download links on the **Settings** page:

- **`/api/export/entries.csv`**: every completed entry, in exactly the columns the Toggl
  importer reads, so the file round-trips through the Import page.
- **`/api/export/backup.json`**: settings, clients, all entries (including a running one)
  and line items, as `{ format: "time-track-backup", version: 1, exportedAt, ... }`.

For a restorable server-side snapshot, `bunx wrangler d1 export time-track --remote
--output backup.sql` produces SQL that `wrangler d1 execute` can replay.

## Data model

Four tables, created by `migrations/0001_init.sql`.

- **`entries`**: one row per tracked block. Instants are UTC epoch **milliseconds**;
  `ended_at` is `NULL` while the timer runs. A partial index keeps "is a timer running?" a
  point lookup, and at most one row is open at a time.
- **`clients`**: identity (`slug`, `name`, `address`, `colour`), invoice series, terms
  (`currency`, `hourly_rate`, rounding) and document defaults.
- **`settings`**: a single row (`CHECK (id = 1)`) holding what belongs to you rather than a
  client: timezone, logo, name, address and `default_client_id`. It also carries a few
  unused columns from before clients had their own table.
- **`invoice_extras`**: hand-entered line items, keyed by client and `period_key`
  (`YYYY-MM`, the identifier the invoice URL uses).

Nothing else about an invoice is stored. Because a period key's meaning depends on the
period day and naming mode, changing either re-points existing line items, the same caveat
that applies to invoice numbering. Changing the timezone re-buckets the calendar and moves
period boundaries, but never rewrites stored entries.

Schema changes go in new numbered files (`bunx wrangler d1 migrations create time-track
<name>`). Never edit a migration a database has already applied: wrangler records them by
filename and won't re-run them.

The logo is stored as a data URL in the settings row (capped at about 350KB), which avoids
needing R2 for one small image.

## API

All routes sit behind the Access check. Everything under `/api` is JSON, apart from the two
export downloads.

| Method | Route | Purpose |
|---|---|---|
| `GET` | `/api/state` | Settings, clients, the running entry (if any), and server time |
| `GET` · `PUT` | `/api/settings` | Read / update the settings row |
| `GET` · `POST` | `/api/clients` | List / create clients |
| `PATCH` | `/api/clients/:id` | Update a client |
| `POST` | `/api/timer/start` | Stop any running timer and start a new one |
| `POST` | `/api/timer/stop` | Stop the running timer |
| `GET` | `/api/entries?from=&to=[&clientId=]` | Entries overlapping a UTC-ms window |
| `POST` | `/api/entries` | Create a completed entry |
| `PATCH` · `DELETE` | `/api/entries/:id` | Edit or remove an entry |
| `GET` | `/api/suggestions?q=` | Past descriptions, most recently used first |
| `POST` | `/api/import` | Preview or commit a Toggl CSV import |
| `GET` | `/api/export/entries.csv` | Toggl-compatible CSV download |
| `GET` | `/api/export/backup.json` | Full JSON backup download |
| `GET` | `/api/invoices[?client=]` | Every period that has begun, with totals (default client if omitted) |
| `GET` | `/api/invoices/:client/:period` | One invoice as JSON (`:client` is the slug, `:period` is `YYYY-MM`) |
| `GET` | `/invoice/:client/:period` | The invoice as print-ready HTML |
| `POST` | `/invoice/:client/:period/extras` | Add a line item (form post, redirects back) |
| `POST` | `/invoice/:client/:period/extras/:id/delete` | Remove one (form post, redirects back) |

## Mobile notes

The layout works down to a 390px phone viewport. On touch devices controls are 16px
(smaller ones make iOS Safari zoom on focus), drag grips grow from 9px to 22px, wide tables
scroll within their own container, and safe-area insets apply with `viewport-fit=cover`.
The desktop full-height layout deliberately uses `vh` rather than `dvh`, because iOS
resizes `dvh` as its toolbars collapse, which made the top of the page unreachable.

This was checked in Chromium under iPhone emulation, not on real WebKit.

## Licence

Copyright © 2026 Aaron.

Time Track is free software: you can redistribute it and/or modify it under the terms of
the GNU Affero General Public License as published by the Free Software Foundation, either
version 3 of the License, or (at your option) any later version. See [LICENSE](LICENSE).

In short: you can run, study, change and share it, but if you distribute a modified
version, or let other people use one over a network, you must make its source available
under the same licence.
