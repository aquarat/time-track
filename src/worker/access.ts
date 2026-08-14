/**
 * Cloudflare Access JWT verification.
 *
 * Access already blocks unauthenticated requests at the edge, but only for the
 * hostname the Access application covers. Verifying the assertion here as well
 * means the Worker refuses to serve data to anything that reached it by another
 * route, so a misconfigured route or a re-enabled workers.dev subdomain cannot
 * quietly expose the database.
 */

interface Jwk {
  kid: string;
  kty: string;
  alg?: string;
  n: string;
  e: string;
}

interface KeyCache {
  keys: Map<string, CryptoKey>;
  fetchedAt: number;
}

const CACHE_TTL_MS = 60 * 60 * 1000;
const cacheByTeam = new Map<string, KeyCache>();

export interface AccessIdentity {
  email: string;
  subject: string;
}

async function loadKeys(teamDomain: string, now: number): Promise<Map<string, CryptoKey>> {
  const cached = cacheByTeam.get(teamDomain);
  if (cached && now - cached.fetchedAt < CACHE_TTL_MS) return cached.keys;

  const res = await fetch(`https://${teamDomain}/cdn-cgi/access/certs`);
  if (!res.ok) throw new Error(`Access certs fetch failed: ${res.status}`);
  const body = (await res.json()) as { keys?: Jwk[] };

  const keys = new Map<string, CryptoKey>();
  for (const jwk of body.keys ?? []) {
    if (jwk.kty !== 'RSA') continue;
    const key = await crypto.subtle.importKey(
      'jwk',
      { kty: jwk.kty, n: jwk.n, e: jwk.e, alg: 'RS256', ext: true },
      { name: 'RSASSA-PKCS1-v1_5', hash: 'SHA-256' },
      false,
      ['verify'],
    );
    keys.set(jwk.kid, key);
  }

  cacheByTeam.set(teamDomain, { keys, fetchedAt: now });
  return keys;
}

function base64UrlToBytes(input: string): Uint8Array {
  const padded = input.replace(/-/g, '+').replace(/_/g, '/').padEnd(Math.ceil(input.length / 4) * 4, '=');
  const binary = atob(padded);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
  return bytes;
}

function decodeJson(segment: string): Record<string, unknown> {
  return JSON.parse(new TextDecoder().decode(base64UrlToBytes(segment)));
}

/**
 * Verify the assertion on a request.
 *
 * Returns the identity on success, or null when the token is missing or invalid.
 * Callers decide what an absent identity means — see `requireAccess`.
 */
export async function verifyAccessJwt(
  request: Request,
  teamDomain: string,
  expectedAud: string,
  now: number,
): Promise<AccessIdentity | null> {
  const token =
    request.headers.get('Cf-Access-Jwt-Assertion') ??
    readCookie(request.headers.get('Cookie'), 'CF_Authorization');
  if (!token) return null;

  const segments = token.split('.');
  if (segments.length !== 3) return null;
  const [headerB64, payloadB64, signatureB64] = segments;

  let header: Record<string, unknown>;
  let payload: Record<string, unknown>;
  try {
    header = decodeJson(headerB64);
    payload = decodeJson(payloadB64);
  } catch {
    return null;
  }

  if (header.alg !== 'RS256' || typeof header.kid !== 'string') return null;

  const keys = await loadKeys(teamDomain, now);
  const key = keys.get(header.kid);
  if (!key) return null;

  const verified = await crypto.subtle.verify(
    'RSASSA-PKCS1-v1_5',
    key,
    base64UrlToBytes(signatureB64),
    new TextEncoder().encode(`${headerB64}.${payloadB64}`),
  );
  if (!verified) return null;

  const nowSeconds = Math.floor(now / 1000);
  if (typeof payload.exp === 'number' && payload.exp < nowSeconds) return null;
  if (typeof payload.nbf === 'number' && payload.nbf > nowSeconds + 60) return null;
  if (payload.iss !== `https://${teamDomain}`) return null;

  // `aud` pins the token to this specific Access application; without the check
  // any token from the same team would be accepted.
  const aud = payload.aud;
  const audiences = Array.isArray(aud) ? aud : typeof aud === 'string' ? [aud] : [];
  if (!audiences.includes(expectedAud)) return null;

  return {
    email: typeof payload.email === 'string' ? payload.email : '',
    subject: typeof payload.sub === 'string' ? payload.sub : '',
  };
}

function readCookie(header: string | null, name: string): string | null {
  if (!header) return null;
  for (const part of header.split(';')) {
    const [key, ...rest] = part.trim().split('=');
    if (key === name) return rest.join('=');
  }
  return null;
}

/**
 * Gate a request. Returns null to continue, or a Response to short-circuit.
 *
 * When the Access vars are unset, verification is skipped so `wrangler dev` works
 * offline. Deploying without them leaves the app open, which the README calls out.
 */
export async function requireAccess(
  request: Request,
  env: { ACCESS_TEAM_DOMAIN?: string; ACCESS_AUD?: string },
  now: number,
): Promise<Response | null> {
  const teamDomain = (env.ACCESS_TEAM_DOMAIN ?? '').trim();
  const aud = (env.ACCESS_AUD ?? '').trim();
  if (teamDomain === '' || aud === '') return null;

  let identity: AccessIdentity | null = null;
  try {
    identity = await verifyAccessJwt(request, teamDomain, aud, now);
  } catch (err) {
    console.error('Access verification error', err);
    return new Response('Access verification unavailable', { status: 503 });
  }

  if (!identity) {
    return new Response('Unauthorized: valid Cloudflare Access assertion required', {
      status: 401,
      headers: { 'Content-Type': 'text/plain; charset=utf-8' },
    });
  }
  return null;
}
