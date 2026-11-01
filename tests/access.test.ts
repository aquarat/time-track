import { describe, expect, test } from 'bun:test';
import { requireAccess } from '../src/worker/access';

const NOW = Date.UTC(2026, 10, 1);
const get = (url: string) => new Request(url);

describe('requireAccess when Access is not configured', () => {
  test('refuses every request by default', async () => {
    for (const env of [{}, { ACCESS_TEAM_DOMAIN: '', ACCESS_AUD: '' }, { ACCESS_TEAM_DOMAIN: 'team.cloudflareaccess.com' }]) {
      const res = await requireAccess(get('https://time-track.example.com/'), env, NOW);
      expect(res?.status).toBe(503);
    }
  });

  test('ALLOW_UNAUTHENTICATED=true opts out', async () => {
    const env = { ALLOW_UNAUTHENTICATED: 'true' };
    expect(await requireAccess(get('http://localhost:8787/api/state'), env, NOW)).toBeNull();
  });

  test('only the exact value "true" opts out', async () => {
    for (const value of ['', '1', 'yes', 'TRUE', 'false']) {
      const res = await requireAccess(get('http://localhost:8787/'), { ALLOW_UNAUTHENTICATED: value }, NOW);
      expect(res?.status).toBe(503);
    }
  });
});

describe('requireAccess when Access is configured', () => {
  test('a request without an assertion is unauthorised, even with the opt-out set', async () => {
    const env = {
      ACCESS_TEAM_DOMAIN: 'team.cloudflareaccess.com',
      ACCESS_AUD: 'aud',
      ALLOW_UNAUTHENTICATED: 'true',
    };
    const res = await requireAccess(get('http://localhost:8787/'), env, NOW);
    expect(res?.status).toBe(401);
  });
});
