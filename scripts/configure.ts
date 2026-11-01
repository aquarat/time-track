/**
 * Fill wrangler.jsonc's CONFIGURE-ME placeholders from environment variables.
 *
 *   TIME_TRACK_DOMAIN=time.example.org \
 *   TIME_TRACK_D1_DATABASE_ID=<uuid> \
 *   TIME_TRACK_ACCESS_TEAM_DOMAIN=yourteam.cloudflareaccess.com \
 *   TIME_TRACK_ACCESS_AUD=<audience tag> \
 *   bun run configure
 *
 * Rewrites wrangler.jsonc in place. CI runs it on a fresh checkout before
 * deploying, so the real values never need to be committed. Run locally, it
 * leaves a modified wrangler.jsonc that should not be committed back to a public
 * repository. Every placeholder must be present exactly once and every variable
 * set, or nothing is written.
 */
import { readFileSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

const CONFIG = fileURLToPath(new URL('../wrangler.jsonc', import.meta.url));

const FIELDS = [
  { env: 'TIME_TRACK_DOMAIN', placeholder: 'CONFIGURE-ME.example.com', valid: /^[a-z0-9.-]+\.[a-z]{2,}$/i },
  { env: 'TIME_TRACK_D1_DATABASE_ID', placeholder: 'CONFIGURE-ME-D1-DATABASE-ID', valid: /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i },
  { env: 'TIME_TRACK_ACCESS_TEAM_DOMAIN', placeholder: 'CONFIGURE-ME.cloudflareaccess.com', valid: /^[a-z0-9-]+\.cloudflareaccess\.com$/i },
  { env: 'TIME_TRACK_ACCESS_AUD', placeholder: 'CONFIGURE-ME-ACCESS-AUD', valid: /^[0-9a-f]{64}$/i },
];

let text = readFileSync(CONFIG, 'utf8');
const problems: string[] = [];

for (const { env, placeholder, valid } of FIELDS) {
  const value = (process.env[env] ?? '').trim();
  const count = text.split(`"${placeholder}"`).length - 1;
  if (value === '') problems.push(`${env} is not set`);
  else if (!valid.test(value)) problems.push(`${env} does not look right: ${JSON.stringify(value)}`);
  if (count !== 1) problems.push(`expected "${placeholder}" once in wrangler.jsonc, found it ${count} times`);
  if (problems.length === 0) text = text.replace(`"${placeholder}"`, JSON.stringify(value));
}

if (problems.length > 0) {
  console.error(`wrangler.jsonc not changed:\n- ${problems.join('\n- ')}`);
  process.exit(1);
}

writeFileSync(CONFIG, text);
console.log('wrangler.jsonc configured.');
