/**
 * Fill a local dev instance with plausible tracked time so the calendar and
 * invoice pages have something to show.
 *
 *   bunx wrangler dev            # in one terminal
 *   bun scripts/seed-dev.ts      # in another
 *
 * Points at localhost by default. Never run this against production.
 */

const BASE = process.env.SEED_BASE ?? 'http://localhost:8787';
const TZ_OFFSET_HOURS = 2; // Africa/Johannesburg

const TASKS = [
  'Kubernetes cluster migration',
  'Terraform module refactor',
  'Client sync + planning',
  'CI pipeline debugging',
  'Incident response — payments',
  'Postgres index tuning',
];

// A fixed seed keeps reruns comparable.
let state = 42;
const rnd = () => ((state = (state * 1103515245 + 12345) % 2147483648) / 2147483648);

const localToUtc = (y: number, m: number, d: number, h: number, min: number) =>
  Date.UTC(y, m - 1, d, h - TZ_OFFSET_HOURS, min);

const now = new Date();
const year = now.getUTCFullYear();
const untilMonth = now.getUTCMonth() + 1;
const untilDay = now.getUTCDate();

let created = 0;
for (let month = 1; month <= untilMonth; month++) {
  const lastDay = new Date(Date.UTC(year, month, 0)).getUTCDate();
  for (let day = 1; day <= lastDay; day++) {
    if (month === untilMonth && day > untilDay) break;
    const weekday = new Date(Date.UTC(year, month - 1, day)).getUTCDay();
    if (weekday === 0 || weekday === 6) continue; // weekends off
    if (rnd() < 0.12) continue; // the occasional day off

    let hour = 8 + Math.floor(rnd() * 2);
    const blocks = 2 + Math.floor(rnd() * 3);
    for (let b = 0; b < blocks; b++) {
      const minutes = 35 + Math.floor(rnd() * 130);
      const startedAt = localToUtc(year, month, day, hour, Math.floor(rnd() * 4) * 15);
      const res = await fetch(`${BASE}/api/entries`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          description: TASKS[Math.floor(rnd() * TASKS.length)],
          startedAt,
          endedAt: startedAt + minutes * 60_000,
        }),
      });
      if (!res.ok) throw new Error(`${res.status}: ${await res.text()}`);
      created++;
      hour += Math.ceil(minutes / 60) + (rnd() < 0.3 ? 1 : 0);
      if (hour > 17) break;
    }
  }
}

console.log(`Seeded ${created} entries into ${BASE}`);
