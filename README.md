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

**`invoice_extras`** — hand-entered line items, keyed by `period_key` (`"YYYY-MM"`, the same
identifier the invoice URL uses). Amounts may be negative, which is how a discount or credit
is expressed.

Nothing else about an invoice is stored. The rest is derived on read from `settings` +
`entries`, which is what makes numbering impossible to corrupt. Note that a period key's
meaning depends on the period day and the naming convention, so changing either re-points
existing extras at a different date range — the same caveat that already applies to invoice
numbering.

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
| `POST` | `/invoice/:period/extras` | Add a line item (form post, redirects back) |
| `POST` | `/invoice/:period/extras/:id/delete` | Remove one (form post, redirects back) |

Client clocks are never trusted for billing: `now` always comes from the Worker, so a
running timer is valued against server time.

## First-time setup (from scratch)

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

`wrangler.jsonc` declares `time-track.example.com` as a custom domain route, so
`bun run deploy` claims it — including the DNS record and certificate — provided the zone
is on the account. `workers_dev` is deliberately `false`, because a live `*.workers.dev`
hostname would sit outside the Access policy below.

## Cloudflare Access

To set it up, or to change who gets in:

1. Zero Trust → Access → Applications → **Add a self-hosted application**.
2. Domain `time-track.example.com`, path blank (protect everything).
3. Add exactly one policy: Action **Allow**, rule `Emails` → the addresses that should get
   in. Resist adding a second policy that includes `everyone` — a permissive policy at any
   precedence supersedes the restrictive one.
4. Copy the **Application Audience (AUD) tag** from the app's Overview tab.
5. Put the team domain and that AUD into `wrangler.jsonc` `vars`:

```jsonc
"vars": {
  "ACCESS_TEAM_DOMAIN": "yourteam.cloudflareaccess.com",
  "ACCESS_AUD": "<the AUD tag>"
}
```

6. `bun run deploy`.

Neither value is a secret — both are already in the JWT the browser holds — so they live in
`wrangler.jsonc` rather than in `wrangler secret`.

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
cp .dev.vars.example .dev.vars   # blanks the Access vars for localhost
bun run db:migrate:local
bunx wrangler dev            # API + assets on :8787
bun run dev                  # optional: Vite with HMR on :5173, proxying to :8787
bun run seed:dev             # fill the local DB with plausible tracked time
bun test                     # invoice and calendar maths
```

`bun run build` must have run at least once before `wrangler dev`, since the Worker
serves the SPA out of `dist/client`.

`.dev.vars` is required locally: `wrangler dev` inherits the production Access values from
`wrangler.jsonc`, and with no Zero Trust session in front of localhost the Worker would
reject every request. The local D1 copy is keyed by database id, so it needs its own
`db:migrate:local` run.

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

## Tab icon

A clock that carries the timer's state: the Start button's blue when idle, the Stop
button's red while a timer runs, so a glance at the tab is enough.

`public/favicon.svg` is the source of truth and what shows before the app loads. The two
PNGs beside it are rendered from it (`favicon-32.png` for browsers that don't take SVG
favicons, `apple-touch-icon.png` full-bleed for the iOS home screen — iOS masks it into a
rounded square, so a disc on a tile would read as a sticker). Regenerating them is a
headless render of the SVG; there is no build step, they are committed.

At runtime `src/client/favicon.ts` draws the same geometry to a canvas and swaps in a PNG
data URL. Canvas rather than an SVG data URL because SVG favicon support is uneven, and the
colours are read from the live CSS custom properties, so the icon follows the light/dark
palette and any change to `--accent` or `--danger`.

State is owned by `App`, not the tracker page, so the icon stays correct while you are on
Invoices or Settings. The tracker updates it immediately on start/stop; a 60-second poll and
a refresh on window focus catch a timer started on another device.

## Mobile / iOS

The layout is responsive down to a 390px phone viewport, and a few things are deliberate
rather than incidental:

- **Controls are 16px on touch devices.** iOS Safari zooms the whole page when a control
  smaller than 16px takes focus, which leaves the layout shifted afterwards. A
  `pointer: coarse` rule lifts every input, select and textarea.
- **`100dvh` with a `100vh` fallback**, because `vh` on iOS measures the viewport with the
  browser chrome collapsed and overshoots while it is expanded.
- **`env(safe-area-inset-*)` padding** so nothing hides under the notch or home indicator
  in landscape.
- **`-webkit-text-size-adjust: 100%`**, or Safari inflates body text on rotation.
- **Nothing scrolls the page sideways.** The sidebar becomes a top bar whose nav scrolls
  within itself, and wide tables sit in their own `overflow-x` container. Verified at 390px
  on all five pages, and in landscape.
- Drag grips grow from 9px to 22px on touch, which is the difference between usable and not.

Caveat on how this was checked: it was measured in Chromium under iPhone emulation
(viewport, device pixel ratio, touch, iOS user agent). **It has not been run against real
WebKit** — the engine could not be installed on the development machine. The fixes above
target documented Safari behaviours, but if something looks wrong on an actual device,
that gap is the reason.

## Editing time

Three ways in, all writing the same `PATCH /api/entries/:id`:

- **Click a block in the calendar** to open a modal for its description and times.
- **Drag the top or bottom edge of a block** in the day view. Boundaries snap to the
  nearest 15 minutes, and the new times are shown on the block as you drag. Handles are
  offered only in the day view, where blocks are wide enough to grab.
- **Click a row in the entries list** for the same edit inline.

The description box at the top stays editable while a timer runs — it *is* that entry's
description at that point. Edits save shortly after typing stops, and immediately on blur,
on Enter, or when the timer is stopped. Enter deliberately does not stop the timer while one
is running; losing a timer to a keystroke meant for the text would be a poor trade.

Dismissing the modal — backdrop, `Escape` — **saves** rather than discards. Losing a
correction to a stray click is the worse failure, and a toast confirms the write. Two
deliberate exceptions: if nothing changed, nothing is written and no toast appears; and if
the input is invalid the modal stays open with the error, since neither saving nor silently
dropping it would be right.

A block is only resizable when its drawn boundaries are the entry's real ones. A slice of
an entry that spans midnight is shown on both days but carries neither true edge, and a
running timer has no end — so those grips are withheld rather than allowed to corrupt the
entry.

### Additional line items

The invoice page carries a small form under the toolbar for expenses, licences, a fixed fee
or a discount. Items belong to one period and appear only on that invoice.

They land as italic rows beneath the time lines, with the hours and rate columns left blank
rather than zeroed, and the totals block splits into *Time subtotal*, *Additional items* and
*Total due*. Negative amounts are accepted deliberately. The editor is part of the page
furniture, not the document, so it does not print.

Adding and removing are plain form posts that redirect back to the document, so a refresh
never re-submits and the whole thing works without JavaScript. Deletes are scoped by period
as well as id, so a stale form cannot reach another invoice's items.

## Importing from Toggl

The **Import** page takes a Toggl Track detailed CSV export. Nothing is written until a
preview has been shown, and the preview is produced by the same code path as the commit,
so the two cannot disagree.

**Timezone is the one thing you must get right.** A Toggl export records bare wall-clock
times — `"2026-08-13","14:42:09"` — with no offset anywhere in the file, so it is literally
impossible to infer. The importer asks which zone those clocks were read in and defaults to
this app's timezone. Set the two to the same value and every entry keeps the calendar day
it had in Toggl.

Other behaviour worth knowing:

- **Duplicates** are matched on start instant + end instant + description. Re-importing the
  same file imports nothing. Note that re-importing under a *different* timezone is
  deliberately not treated as a duplicate — those are genuinely different instants, so a
  corrected re-import is not silently swallowed. Delete the first attempt before retrying.
- **Client, project, task and tag columns are ignored.** Everything belongs to the single
  implicit project for now.
- **Non-billable rows are imported by default**, since this app has no billable flag and
  bills whatever it tracks. The preview states the count, and a checkbox skips them.
- **The `Duration` column is cross-checked** against the timestamps; a row whose stated
  duration disagrees with its own clocks is reported rather than guessed at.
- **Bad rows never cost you the good ones** — each is listed with its line number.
- The preview breaks the import down **per invoice period**, so you can see exactly which
  invoices it will change before committing.

## The invoice document

`/invoice/2026-06` is server-rendered HTML laid out for A4. Print or Save-as-PDF from the
browser. It carries the logo, both addresses, line items, totals, an optional day-by-day
time log, and your footer.

### Layout toggles

Two checkboxes in the document's toolbar (neither prints):

| | On | Off |
|---|---|---|
| **Detailed invoice** | One line per task description, with a raw *Tracked* column and total alongside the billed hours | A single line — *Software development services - 26 January 2026 to 26 February 2026* — and no *Tracked* figures |
| **Detailed time log** | Day-by-day breakdown, starting on its own page | Omitted entirely |

**The amount due is identical either way.** Rounding is applied per task description, and
the summary line reports the sum of those already-rounded lines rather than re-rounding the
raw total — otherwise a presentation choice would change what you charge. There is a test
covering every rounding mode and increment for exactly this.

The summary line's wording is configurable on the invoice settings page — the period dates
are appended automatically, and clearing the field falls back to "Software development
services" rather than leaving a dangling dash.

Defaults live on the invoice settings page. A per-invoice choice is **not** persisted: it
lives in the URL as `?detailed=0&timelog=1`, so a particular rendering is reproducible and
can be bookmarked or handed to a headless renderer. Only `1/true/on/yes` and
`0/false/off/no` are recognised; anything absent or unrecognised falls back to the
configured default rather than silently rendering the wrong document.

The toolbar is a plain GET form, so the toggles work with JavaScript disabled. Scripting
only tidies the resulting query string.

## Notes

- Everything belongs to one implicit project. The schema keeps `entries` free of a project
  column for now; adding one later is an additive migration.
- The logo is stored as a data URL in the settings row, capped at ~350KB — this avoids
  adding R2 for a single small image.
- Starting a timer while another runs stops the previous one, as Toggl does.
- Time entries store UTC instants. Changing the timezone setting re-buckets the calendar
  and moves period boundaries; it never rewrites stored entries.
