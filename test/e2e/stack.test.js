// End-to-end tests against the running docker compose stack (see scripts/test-stack.sh).
//   SITE        https://pbat.test        — through Caddy, like a visitor
//   APP_URL     http://127.0.0.1:3000    — the app's loopback port (used to simulate other IPs)
//   MOCK_URL    http://127.0.0.1:8025    — mock email provider + Firebase JWKS / ID-token mint
//   PHASE       main | after-restart     — after-restart checks state survived a restart/restore
//   STATE_FILE  where phase "main" leaves data for later phases
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import crypto from 'node:crypto';

const SITE = process.env.SITE || 'https://pbat.test';
const WWW = SITE.replace('://', '://www.');
const APP_URL = process.env.APP_URL || 'http://127.0.0.1:3000';
const MOCK_URL = process.env.MOCK_URL || 'http://127.0.0.1:8025';
const PHASE = process.env.PHASE || 'main';
const STATE_FILE = process.env.STATE_FILE || '/tmp/pbat-e2e-state.json';
const IP_LIMIT = Number(process.env.OTP_IP_LIMIT_PER_HOUR || 40);
const PHONE_LIMIT = Number(process.env.OTP_PHONE_LIMIT_PER_DAY || 5);

const rnd = () => crypto.randomBytes(4).toString('hex');
const randomPhone = () => {
  const p = `080${String(crypto.randomInt(10_000_000, 99_999_999))}`;
  return p.endsWith('0000') ? `${p.slice(0, -1)}1` : p;
};
const randomIp = () => `198.51.100.${crypto.randomInt(1, 254)}`;
const toE164 = (p) => `+234${p.slice(1)}`;

/** A browser-like client with its own cookie jar (sid plus the Google OAuth state cookie). */
function client(base = SITE, extraHeaders = {}) {
  const jar = new Map();
  const c = {
    lastSetCookie: null,
    get sid() { return jar.get('sid') || null; },
    set sid(v) { if (v) jar.set('sid', v); else jar.delete('sid'); },
    cookie: (name) => jar.get(name) || null,
    async req(method, path, body, headers = {}) {
      const cookie = [...jar].map(([k, v]) => `${k}=${v}`).join('; ');
      const res = await fetch(base + path, {
        method,
        redirect: 'manual',
        headers: {
          'User-Agent': 'pbat-e2e',
          ...(body !== undefined && !Buffer.isBuffer(body) ? { 'Content-Type': 'application/json' } : {}),
          ...(cookie ? { Cookie: cookie } : {}),
          ...extraHeaders, ...headers,
        },
        body: body === undefined ? undefined : Buffer.isBuffer(body) ? body : typeof body === 'string' ? body : JSON.stringify(body),
      });
      for (const set of res.headers.getSetCookie()) {
        const eq = set.indexOf('=');
        if (eq < 0) continue;
        const name = set.slice(0, eq);
        const value = set.slice(eq + 1, set.indexOf(';') === -1 ? undefined : set.indexOf(';'));
        const expired = /Expires=Thu, 01 Jan 1970/i.test(set) || /Max-Age=0/i.test(set);
        if (name === 'sid') c.lastSetCookie = set;
        if (expired || value === '') jar.delete(name);
        else jar.set(name, value);
      }
      const text = await res.text();
      let data = null;
      try { data = JSON.parse(text); } catch {}
      return { status: res.status, data, text, headers: res.headers };
    },
    get: (p, h) => c.req('GET', p, undefined, h),
    post: (p, b = {}, h) => c.req('POST', p, b, h),
    async getBuf(path, headers = {}) {
      const cookie = [...jar].map(([k, v]) => `${k}=${v}`).join('; ');
      const res = await fetch(base + path, {
        method: 'GET',
        redirect: 'manual',
        headers: {
          'User-Agent': 'pbat-e2e',
          ...(cookie ? { Cookie: cookie } : {}),
          ...extraHeaders, ...headers,
        },
      });
      return { status: res.status, buf: Buffer.from(await res.arrayBuffer()), headers: res.headers };
    },
  };
  return c;
}

const PNG_1x1 = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSjAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==',
  'base64',
);

/** The latest code the mock delivered to `to`, and how: { code, channel: 'email' | 'whatsapp' | 'voice' | 'sms' }. */
async function delivered(to) {
  for (let i = 0; i < 20; i++) {
    const r = await fetch(`${MOCK_URL}/codes?to=${encodeURIComponent(to)}`);
    if (r.ok) return r.json();
    await new Promise((r2) => setTimeout(r2, 100));
  }
  throw new Error(`no code delivered to ${to}`);
}
const codeFor = async (to) => (await delivered(to)).code;

async function signIn(c, identifier, deliveredTo = identifier) {
  const start = await c.post('/api/auth/start', { identifier });
  assert.equal(start.status, 200, start.text);
  const verify = await c.post('/api/auth/verify', { identifier, code: await codeFor(deliveredTo), consent: true });
  assert.equal(verify.status, 200, verify.text);
  return verify.data;
}

async function firebaseToken(phone) {
  const r = await fetch(`${MOCK_URL}/firebase/token`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ phone: phone.startsWith('+') ? phone : toE164(phone) }),
  });
  const text = await r.text();
  assert.equal(r.status, 200, text);
  return JSON.parse(text).idToken;
}

async function signInPhone(c, phone, { consent = true } = {}) {
  const r = await c.post('/api/auth/firebase', { idToken: await firebaseToken(phone), consent });
  assert.equal(r.status, 200, r.text);
  return r.data;
}

const PROFILE = {
  full_name: 'Ada Test Obi', gender: 'Female', date_of_birth: '1990-05-17', state: 'Lagos', lga: 'Ikeja',
  ward: 'Ward A', polling_unit: 'PU 001', address: '1 Test Street', occupation: 'Engineer',
  interests: ['Social media', 'Door-to-door canvassing'], consent: true,
};

if (PHASE === 'main') {
  const state = {};

  test('health and readiness through Caddy', async () => {
    const c = client();
    assert.deepEqual((await c.get('/healthz')).data, { ok: true });
    assert.deepEqual((await c.get('/readyz')).data, { ok: true, db: 'up' });
  });

  test('HTTP redirects to HTTPS, www redirects to the apex', async () => {
    const http = await fetch(SITE.replace('https:', 'http:') + '/login?x=1', { redirect: 'manual' });
    assert.ok([301, 308].includes(http.status), `got ${http.status}`);
    assert.equal(http.headers.get('location'), `${SITE}/login?x=1`);
    const www = await fetch(`${WWW}/account?y=2`, { redirect: 'manual' });
    assert.equal(www.status, 301);
    assert.equal(www.headers.get('location'), `${SITE}/account?y=2`);
  });

  test('pages and legacy redirects', async () => {
    const c = client();
    for (const p of ['/', '/login', '/join', '/signup', '/account', '/contact', '/privacy', '/terms', '/volunteer', '/coordinator', '/offline']) {
      const r = await c.get(p);
      assert.equal(r.status, 200, p);
      assert.match(r.headers.get('content-type'), /text\/html/);
      assert.equal(r.headers.get('cache-control'), 'no-cache');
    }
    const welcome = await c.get('/welcome');
    assert.equal(welcome.status, 302);
    assert.equal(welcome.headers.get('location'), '/account');
    assert.equal((await c.get('/api/nope')).status, 404);
  });

  test('security headers', async () => {
    const r = await client().get('/');
    const csp = r.headers.get('content-security-policy');
    assert.match(csp, /default-src 'self'/);
    assert.match(csp, /script-src 'self' 'sha256-/);
    assert.match(csp, /frame-ancestors 'none'/);
    assert.match(csp, /www\.gstatic\.com/, 'Firebase SDK origin');
    assert.match(csp, /recaptcha\.google\.com/, 'Firebase reCAPTCHA frame');
    assert.match(csp, /identitytoolkit\.googleapis\.com/, 'Firebase Auth API');
    assert.match(csp, /googleusercontent\.com/, 'Google profile photos');
    assert.doesNotMatch(csp, /script-src[^;]*'unsafe-inline'/);
    assert.match(r.headers.get('strict-transport-security'), /max-age=31536000/);
    assert.equal(r.headers.get('x-content-type-options'), 'nosniff');
    assert.match(r.headers.get('permissions-policy'), /geolocation=\(self\)/);
    assert.equal(r.headers.get('x-powered-by'), null);
    assert.equal(r.headers.get('server'), null);
  });

  test('polling-unit JSON is served pre-compressed with long caching', async () => {
    const r = await fetch(`${SITE}/geo/lagos.json`, { headers: { 'Accept-Encoding': 'br, gzip' } });
    assert.equal(r.status, 200);
    assert.equal(r.headers.get('content-encoding'), 'br');
    assert.match(r.headers.get('cache-control'), /max-age=604800/);
    const data = await r.json();
    assert.equal(data.state, 'Lagos');
    const gz = await fetch(`${SITE}/geo/index.json`, { headers: { 'Accept-Encoding': 'gzip' } });
    assert.ok((await gz.json()).Lagos);
  });

  test('options', async () => {
    const { data } = await client().get('/api/options');
    assert.equal(data.states.length, 37);
    assert.equal(data.sms, true);
    assert.equal(data.phoneVia, 'firebase', 'Firebase wins even when Zoho env vars are set');
    assert.equal(data.turnstile, null);
    assert.deepEqual(data.phoneChannels, []);
    assert.equal(data.firebase.projectId, 'pbat-test');
    assert.equal(data.firebase.apiKey, 'test-firebase-key');
    assert.match(data.firebase.sdk, /gstatic\.com\/firebasejs/);
    assert.equal(data.google, true, 'public Google sign-in is advertised when configured');
  });

  test('API input checks', async () => {
    const c = client();
    assert.equal((await c.req('POST', '/api/auth/start', 'identifier=x', { 'Content-Type': 'application/x-www-form-urlencoded' })).status, 415);
    assert.equal((await c.req('POST', '/api/auth/start', '{bad json')).status, 400);
    assert.equal((await c.post('/api/auth/start', { identifier: 'nonsense' })).status, 400);
    assert.equal((await c.get('/api/me')).status, 401);
    assert.equal((await c.post('/api/me', PROFILE)).status, 401);
  });

  const emailA = `ada-${rnd()}@example.com`;
  const phoneB = randomPhone();
  const devA1 = client(), devA2 = client(), devB = client();

  test('email sign-in: send code, cooldown, wrong code, verify, session cookie', async () => {
    const start = await devA1.post('/api/auth/start', { identifier: emailA.toUpperCase() });
    assert.equal(start.status, 200, start.text);
    assert.equal(start.data.identifier, emailA);
    assert.equal(start.data.devCode, undefined, 'production must never reveal codes');
    assert.match(start.data.sentTo, /•/);

    const again = await devA1.post('/api/auth/start', { identifier: emailA });
    assert.equal(again.status, 429);
    assert.ok(again.data.retryAfter > 0);

    const wrong = await devA1.post('/api/auth/verify', { identifier: emailA, code: '000000' === (await codeFor(emailA)) ? '111111' : '000000' });
    assert.equal(wrong.status, 400);
    assert.match(wrong.data.error, /4 attempts left/);

    const need = await devA1.post('/api/auth/verify', { identifier: emailA, code: await codeFor(emailA) });
    assert.equal(need.status, 200, need.text);
    assert.equal(need.data.needsConsent, true);
    assert.ok(need.data.pending);
    assert.equal(devA1.sid, null, 'no session until the new person agrees');

    const ok = await devA1.post('/api/auth/join', { pending: need.data.pending, consent: true });
    assert.equal(ok.status, 200, ok.text);
    assert.equal(ok.data.isNew, true);
    assert.equal(ok.data.needsProfile, true);
    assert.match(devA1.lastSetCookie, /HttpOnly/i);
    assert.match(devA1.lastSetCookie, /Secure/i);
    assert.match(devA1.lastSetCookie, /SameSite=Lax/i);
    assert.match(devA1.lastSetCookie, /Max-Age=34560000/i, '400-day browser cap, in seconds');

    const reuse = await client().post('/api/auth/verify', { identifier: emailA, code: await codeFor(emailA) });
    assert.equal(reuse.status, 400, 'a code is single-use');

    const me = await devA1.get('/api/me');
    assert.equal(me.status, 200);
    assert.equal(me.data.member.email, emailA);
    assert.equal(me.data.member.emailVerified, true);
    assert.equal(me.data.member.profileComplete, false);
    assert.equal(me.data.sessions.length, 1);
    assert.equal(me.data.sessions[0].current, true);
    assert.equal(me.data.sessions[0].userAgent, 'pbat-e2e');
  });

  test('profile save: validation, first save with consent, later edit', async () => {
    const bad = await devA1.post('/api/me', { full_name: 'Ada', state: 'Nowhere', lga: '' });
    assert.equal(bad.status, 400);
    assert.deepEqual(Object.keys(bad.data.fields).sort(), ['consent', 'full_name', 'lga', 'state']);

    const saved = await devA1.post('/api/me', PROFILE);
    assert.equal(saved.status, 200, saved.text);
    assert.equal(saved.data.member.profileComplete, true);
    assert.equal(saved.data.member.full_name, 'Ada Test Obi');
    assert.deepEqual(saved.data.member.interests, ['Social media', 'Door-to-door canvassing']);

    const edit = await devA1.post('/api/me', { ...PROFILE, consent: undefined, occupation: 'Teacher' });
    assert.equal(edit.status, 200, edit.text);
    assert.equal(edit.data.member.occupation, 'Teacher');
    assert.equal(edit.data.member.role, 'volunteer');
  });

  test('volunteer area: log a visit, idempotent retry, pledge needs consent', async () => {
    assert.equal((await client().get('/api/volunteer')).status, 401);
    assert.equal((await client().get('/api/coord/overview')).status, 401);

    const mine = await devA1.get('/api/volunteer');
    assert.equal(mine.status, 200, mine.text);
    assert.equal(mine.data.me.name, 'Ada Test Obi');
    assert.equal(mine.data.role, 'volunteer');
    assert.equal(mine.data.totals.visits, 0);

    const clientId = crypto.randomBytes(8).toString('hex');
    const visit = await devA1.post('/api/visits', { clientId, households: 4, people: 12, area: 'Test street' });
    assert.equal(visit.status, 200, visit.text);
    assert.equal(visit.data.totals.visits, 1);
    assert.equal(visit.data.totals.households, 4);
    const again = await devA1.post('/api/visits', { clientId, households: 4 });
    assert.equal(again.status, 200, again.text);
    assert.equal(again.data.totals.visits, 1, 'the same offline clientId is not counted twice');

    const noConsent = await devA1.post('/api/pledges', { clientId: crypto.randomBytes(8).toString('hex'), name: 'Neighbour', consent: false });
    assert.equal(noConsent.status, 400);
    const pledge = await devA1.post('/api/pledges', { clientId: crypto.randomBytes(8).toString('hex'), name: 'Neighbour', consent: true });
    assert.equal(pledge.status, 200, pledge.text);
    assert.equal(pledge.data.totals.pledges, 1);

    const board = await devA1.get('/api/leaderboard?scope=state');
    assert.equal(board.status, 200, board.text);
    assert.ok(board.data.people.some((p) => p.me));
    assert.equal((await devA1.get('/api/coord/overview')).status, 403);
  });

  test('second device signs in to the same account', async () => {
    const r = await signIn(devA2, emailA);
    assert.equal(r.isNew, false);
    assert.equal(r.needsProfile, false);
    const me = await devA1.get('/api/me');
    assert.equal(me.data.sessions.length, 2);
  });

  test('the sign-in page loads the shared phone/email rules', async () => {
    const r = await client().get('/validate.js');
    assert.equal(r.status, 200);
    assert.match(r.headers.get('content-type'), /javascript/);
    assert.match(r.text, /export function normalizePhone/);
  });

  async function startGoogle(c, qs = '') {
    const r = await c.get(`/api/auth/google${qs}`);
    assert.equal(r.status, 302, r.text);
    const loc = r.headers.get('location');
    assert.ok(loc, 'Google start must redirect');
    return { start: r, loc, state: new URL(loc).searchParams.get('state') };
  }

  test('Google sign-in: start redirects to Google, callback is public, session after consent', async () => {
    const login = await client().get('/login');
    assert.match(login.text, /Continue with Google/);
    assert.match(login.text, /\/api\/auth\/google/);

    const stranger = `stranger-${rnd()}@gmail.com`;
    const c = client();
    const { loc, state } = await startGoogle(c, '?consent=1');
    const dest = new URL(loc);
    assert.equal(dest.origin, 'https://accounts.google.com');
    assert.equal(dest.pathname, '/o/oauth2/v2/auth');
    assert.equal(dest.searchParams.get('client_id'), 'pbat-test-google-client');
    assert.equal(dest.searchParams.get('redirect_uri'), `${SITE}/api/auth/google/callback`);
    assert.equal(dest.searchParams.get('response_type'), 'code');
    assert.match(dest.searchParams.get('scope'), /email/);
    assert.ok(state);
    assert.ok(c.cookie('gostate'), 'OAuth state cookie');
    assert.equal(c.sid, null);

    const denied = await c.get(`/api/auth/google/callback?error=access_denied&state=${encodeURIComponent(state)}`);
    assert.equal(denied.status, 302);
    assert.match(denied.headers.get('location'), /google_error=denied/);
    assert.equal(c.sid, null);

    const { state: state2 } = await startGoogle(c, '?consent=1');
    const bad = await c.get(`/api/auth/google/callback?code=${encodeURIComponent(`ok:${stranger}`)}&state=not-the-state`);
    assert.equal(bad.status, 302);
    assert.match(bad.headers.get('location'), /google_error=mismatch/);
    assert.equal(c.sid, null);

    const { state: state3 } = await startGoogle(c, '?consent=1');
    const unverified = await c.get(`/api/auth/google/callback?code=${encodeURIComponent(`unverified:${stranger}`)}&state=${encodeURIComponent(state3)}`);
    assert.equal(unverified.status, 302);
    assert.match(unverified.headers.get('location'), /google_error=unverified/);
    assert.equal(c.sid, null);

    const { state: state4 } = await startGoogle(c, '?consent=1');
    const ok = await c.get(`/api/auth/google/callback?code=${encodeURIComponent(`ok:${stranger}`)}&state=${encodeURIComponent(state4)}`);
    assert.equal(ok.status, 302, ok.text);
    assert.equal(ok.headers.get('location'), '/account?welcome=1');
    assert.ok(c.sid, 'session cookie after Google callback');
    assert.match(c.lastSetCookie, /HttpOnly/i);
    assert.match(c.lastSetCookie, /Secure/i);
    assert.match(c.lastSetCookie, /SameSite=Lax/i);
    assert.match(c.lastSetCookie, /Max-Age=34560000/i);
    assert.equal(c.cookie('gostate'), null, 'state cookie is cleared');

    const me = await c.get('/api/me');
    assert.equal(me.status, 200, me.text);
    assert.equal(me.data.member.email, stranger);
    assert.equal(me.data.member.emailVerified, true);
    assert.equal(me.data.member.profileComplete, false);
    assert.equal(me.data.member.full_name, 'Google Tester');
    assert.equal(me.data.member.givenName, 'Google');
    assert.equal(me.data.member.familyName, 'Tester');
    assert.equal(me.data.member.picture, 'https://lh3.googleusercontent.com/a/ACg8ocTestPhoto');
    assert.equal(me.data.member.locale, 'en');
    assert.equal(me.data.member.googleLinked, true);

    const again = client();
    const { state: state5 } = await startGoogle(again);
    const back = await again.get(`/api/auth/google/callback?code=${encodeURIComponent(`ok:${stranger}`)}&state=${encodeURIComponent(state5)}`);
    assert.equal(back.status, 302, back.text);
    assert.equal(back.headers.get('location'), '/account');
    const me2 = await again.get('/api/me');
    assert.equal(me2.data.member.email, stranger);
    assert.equal(me2.data.member.emailVerified, true);
    assert.equal(me2.data.member.picture, 'https://lh3.googleusercontent.com/a/ACg8ocTestPhoto');
    assert.equal(me2.data.member.givenName, 'Google');
    assert.equal(me2.data.member.familyName, 'Tester');
    assert.equal(me2.data.member.googleLinked, true);
  });

  test('Google sign-in from Log in asks a new person to agree; any Google email works', async () => {
    const email = `public-${rnd()}@gmail.com`;
    const c = client();
    const { state } = await startGoogle(c);
    const cb = await c.get(`/api/auth/google/callback?code=${encodeURIComponent(`ok:${email}`)}&state=${encodeURIComponent(state)}`);
    assert.equal(cb.status, 302, cb.text);
    const next = new URL(cb.headers.get('location'), SITE);
    assert.equal(next.pathname, '/login');
    const pending = next.searchParams.get('google_pending');
    assert.ok(pending, 'new Google member without consent gets a pending token');
    assert.equal(c.sid, null);

    const join = await c.post('/api/auth/join', { pending, consent: true });
    assert.equal(join.status, 200, join.text);
    assert.equal(join.data.isNew, true);
    assert.equal(join.data.member.email, email);
    assert.equal(join.data.member.emailVerified, true);
    assert.equal(join.data.member.full_name, 'Google Tester');
    assert.equal(join.data.member.picture, 'https://lh3.googleusercontent.com/a/ACg8ocTestPhoto');
    assert.equal(join.data.member.googleLinked, true);
    assert.ok(c.sid);
  });

  test('Join Google is clickable and sends a new person to /join for consent', async () => {
    const joinPage = await client().get('/join');
    assert.match(joinPage.text, /Continue with Google/);
    assert.match(joinPage.text, /from['"]\s*,\s*['"]join['"]/);
    assert.doesNotMatch(joinPage.text, /\$\('#google-btn'\)\.setAttribute\('aria-disabled'/);

    const email = `join-${rnd()}@gmail.com`;
    const c = client();
    const { state } = await startGoogle(c, '?from=join');
    const cb = await c.get(`/api/auth/google/callback?code=${encodeURIComponent(`ok:${email}`)}&state=${encodeURIComponent(state)}`);
    assert.equal(cb.status, 302, cb.text);
    const next = new URL(cb.headers.get('location'), SITE);
    assert.equal(next.pathname, '/join');
    const pending = next.searchParams.get('google_pending');
    assert.ok(pending);
    assert.equal(c.sid, null);
    const done = await c.post('/api/auth/join', { pending, consent: true });
    assert.equal(done.status, 200, done.text);
    assert.equal(done.data.isNew, true);
    assert.equal(done.data.member.email, email);
    assert.equal(done.data.member.googleLinked, true);
  });

  test('Google sign-in upserts Google fields onto an existing email member', async () => {
    const email = `pre-google-${rnd()}@example.com`;
    const c = client();
    await signIn(c, email);
    const before = await c.get('/api/me');
    assert.equal(before.data.member.email, email);
    assert.equal(before.data.member.emailVerified, true);
    assert.equal(before.data.member.googleLinked, false);
    assert.equal(before.data.member.picture, '');
    assert.equal(before.data.member.full_name, '');

    const { state } = await startGoogle(c);
    const cb = await c.get(`/api/auth/google/callback?code=${encodeURIComponent(`ok:${email}`)}&state=${encodeURIComponent(state)}`);
    assert.equal(cb.status, 302, cb.text);
    assert.equal(cb.headers.get('location'), '/account');
    const me = await c.get('/api/me');
    assert.equal(me.data.member.email, email);
    assert.equal(me.data.member.emailVerified, true);
    assert.equal(me.data.member.googleLinked, true);
    assert.equal(me.data.member.picture, 'https://lh3.googleusercontent.com/a/ACg8ocTestPhoto');
    assert.equal(me.data.member.googlePicture, 'https://lh3.googleusercontent.com/a/ACg8ocTestPhoto');
    assert.equal(me.data.member.givenName, 'Google');
    assert.equal(me.data.member.familyName, 'Tester');
    assert.equal(me.data.member.full_name, 'Google Tester', 'blank campaign name is filled from Google');
    assert.equal(me.data.member.locale, 'en');
    assert.equal(me.data.member.createdAt, before.data.member.createdAt, 'same member row, not a duplicate');
  });

  test('Google on an existing email logs into that member and keeps their name', async () => {
    const c = client();
    const { state } = await startGoogle(c);
    const cb = await c.get(`/api/auth/google/callback?code=${encodeURIComponent(`ok:${emailA}`)}&state=${encodeURIComponent(state)}`);
    assert.equal(cb.status, 302, cb.text);
    assert.equal(cb.headers.get('location'), '/account');
    const me = await c.get('/api/me');
    assert.equal(me.status, 200, me.text);
    assert.equal(me.data.member.email, emailA);
    assert.equal(me.data.member.full_name, 'Ada Test Obi', 'do not overwrite a name the member already filled');
    assert.equal(me.data.member.givenName, 'Google');
    assert.equal(me.data.member.picture, 'https://lh3.googleusercontent.com/a/ACg8ocTestPhoto');
    assert.equal(me.data.member.googlePicture, 'https://lh3.googleusercontent.com/a/ACg8ocTestPhoto');
    assert.equal(me.data.member.hasCustomPhoto, false);
    assert.equal(me.data.member.googleLinked, true);
  });

  test('custom photo is stored as bytes and beats the Google picture until cleared', async () => {
    assert.equal((await client().get('/api/me/photo')).status, 401);
    const before = await devA1.get('/api/me');
    assert.equal(before.data.member.hasCustomPhoto, false);
    assert.equal(before.data.member.picture, 'https://lh3.googleusercontent.com/a/ACg8ocTestPhoto');

    const junk = await devA1.req('POST', '/api/me/photo', Buffer.from('not-an-image'), { 'Content-Type': 'image/png' });
    assert.equal(junk.status, 400);

    const ok = await devA1.req('POST', '/api/me/photo', PNG_1x1, { 'Content-Type': 'image/png' });
    assert.equal(ok.status, 200, ok.text);
    assert.equal(ok.data.member.hasCustomPhoto, true);
    assert.match(ok.data.member.picture, /^\/api\/me\/photo\?t=/);
    assert.equal(ok.data.member.googlePicture, 'https://lh3.googleusercontent.com/a/ACg8ocTestPhoto');

    const pic = await devA1.getBuf('/api/me/photo');
    assert.equal(pic.status, 200);
    assert.equal(pic.headers.get('content-type'), 'image/png');
    assert.deepEqual(pic.buf, PNG_1x1);

    const gone = await devA1.req('DELETE', '/api/me/photo');
    assert.equal(gone.status, 200, gone.text);
    assert.equal(gone.data.member.hasCustomPhoto, false);
    assert.equal(gone.data.member.picture, 'https://lh3.googleusercontent.com/a/ACg8ocTestPhoto', 'clearing custom photo falls back to Google');
  });

  test('signed-in phone member: free Google email attaches; colliding email logs into that member', async () => {
    const phone = randomPhone();
    const attach = client();
    const started = await signInPhone(attach, phone);
    assert.equal(started.member.phone, toE164(phone));
    const gmail = `phone-google-${rnd()}@gmail.com`;
    const { state } = await startGoogle(attach, '?consent=1');
    const linked = await attach.get(`/api/auth/google/callback?code=${encodeURIComponent(`ok:${gmail}`)}&state=${encodeURIComponent(state)}`);
    assert.equal(linked.status, 302, linked.text);
    const me = await attach.get('/api/me');
    assert.equal(me.data.member.phone, toE164(phone));
    assert.equal(me.data.member.email, gmail);
    assert.equal(me.data.member.emailVerified, true);
    assert.equal(me.data.member.googleLinked, true);

    const otherPhone = randomPhone();
    const collide = client();
    await signInPhone(collide, otherPhone);
    const { state: state2 } = await startGoogle(collide);
    const hop = await collide.get(`/api/auth/google/callback?code=${encodeURIComponent(`ok:${emailA}`)}&state=${encodeURIComponent(state2)}`);
    assert.equal(hop.status, 302, hop.text);
    const landed = await collide.get('/api/me');
    assert.equal(landed.data.member.email, emailA);
    assert.equal(landed.data.member.full_name, 'Ada Test Obi');
    assert.notEqual(landed.data.member.phone, toE164(otherPhone), 'do not attach a colliding email to the phone-only member');
  });

  test('phone sign-in through Firebase (local 080… format)', async () => {
    assert.equal((await devB.post('/api/auth/start', { identifier: phoneB })).status, 400, 'server-side phone codes are off when Firebase is on');
    assert.equal((await devB.post('/api/auth/firebase', { idToken: 'not-a-jwt' })).status, 401);

    const need = await devB.post('/api/auth/firebase', { idToken: await firebaseToken(phoneB) });
    assert.equal(need.status, 200, need.text);
    assert.equal(need.data.needsConsent, true);
    assert.ok(need.data.pending);
    assert.equal(devB.sid, null, 'no session until the new person agrees');

    const r = await devB.post('/api/auth/join', { pending: need.data.pending, consent: true });
    assert.equal(r.status, 200, r.text);
    assert.equal(r.data.isNew, true);
    assert.equal(r.data.member.phone, toE164(phoneB));
    const saved = await devB.post('/api/me', { ...PROFILE, full_name: 'Bayo Test', occupation: 'Trader', email: '' });
    assert.equal(saved.status, 200, saved.text);
  });

  test('account linking: proving a phone that has its own account merges the two', async () => {
    const already = await devA1.post('/api/me/link/start', { identifier: `other-${rnd()}@example.com` });
    assert.equal(already.status, 400, 'account already has a verified email');

    assert.equal((await devA1.post('/api/me/link/start', { identifier: phoneB })).status, 400, 'phone linking uses Firebase');
    const ok = await devA1.post('/api/me/link/firebase', { idToken: await firebaseToken(phoneB) });
    assert.equal(ok.status, 200, ok.text);
    assert.equal(ok.data.merged, true);
    const m = ok.data.member;
    assert.equal(m.email, emailA);
    assert.equal(m.phone, toE164(phoneB));
    assert.ok(m.emailVerified && m.phoneVerified);
    assert.equal(m.full_name, 'Ada Test Obi', 'the older account keeps its details');

    // B's device is now signed in to the merged account, and the phone signs in to it too.
    const meB = await devB.get('/api/me');
    assert.equal(meB.status, 200);
    assert.equal(meB.data.member.email, emailA);
    const viaPhone = await signInPhone(client(), phoneB);
    assert.equal(viaPhone.member.email, emailA);
    // Ada: email join + second device + two Google logins (existing email, colliding
    // phone hop) + Bayo's moved session + this phone sign-in.
    assert.equal((await devA1.get('/api/me')).data.sessions.length, 6);
  });

  test('per-phone daily cap covers Firebase sign-in and linking, from any connection', async () => {
    const phone = randomPhone();
    for (let i = 0; i < PHONE_LIMIT; i++) {
      const c = client(APP_URL, { 'X-Forwarded-For': randomIp() });
      const ok = await signInPhone(c, phone);
      assert.equal(ok.member.phone, toE164(phone), `sign-in ${i + 1}`);
    }
    const capped = await client(APP_URL, { 'X-Forwarded-For': randomIp() })
      .post('/api/auth/firebase', { idToken: await firebaseToken(phone), consent: true });
    assert.equal(capped.status, 429);
    assert.equal(capped.data.dailyLimit, true);
    assert.match(capped.data.error, /too many codes today/);

    const linker = client(APP_URL, { 'X-Forwarded-For': randomIp() });
    await signIn(linker, `linker-${rnd()}@example.com`);
    const link = await linker.post('/api/me/link/firebase', { idToken: await firebaseToken(phone) });
    assert.equal(link.status, 429, 'linking shares the cap');
    assert.equal(link.data.dailyLimit, true);

    assert.equal((await linker.post('/api/auth/start', { identifier: `cap-${rnd()}@example.com` })).status, 200, 'emails are not capped');
    state.cappedPhone = phone;
  });

  test('rolling session cookie is re-issued; logout still fully revokes it', async () => {
    const c = client();
    const email = `roll-${rnd()}@example.com`;
    await signIn(c, email);
    const token = c.sid;
    const me = await c.get('/api/me');
    assert.equal(me.status, 200, me.text);
    assert.ok(me.headers.getSetCookie().some((h) => h.startsWith('sid=')), 'authenticated request re-issues the cookie');
    assert.equal(c.sid, token, 'same session token');
    assert.match(c.lastSetCookie, /HttpOnly/i);
    assert.match(c.lastSetCookie, /Secure/i);
    assert.match(c.lastSetCookie, /SameSite=Lax/i);
    assert.match(c.lastSetCookie, /Max-Age=34560000/i);

    assert.equal((await c.post('/api/auth/logout')).status, 200);
    assert.equal(c.sid, null);
    assert.equal((await c.get('/api/me')).status, 401);
    const stale = client(); stale.sid = token;
    assert.equal((await stale.get('/api/me')).status, 401, 'the old cookie is dead on the server');
  });

  test('logout this device, then log out everywhere', async () => {
    assert.equal((await devA2.post('/api/auth/logout')).status, 200);
    assert.equal(devA2.sid, null);
    assert.equal((await devA2.get('/api/me')).status, 401);
    assert.equal((await devA1.get('/api/me')).status, 200);

    assert.equal((await devA1.post('/api/auth/logout-all')).status, 200);
    assert.equal((await devA1.get('/api/me')).status, 401);
    const stale = client(); stale.sid = devB.sid;
    assert.equal((await stale.get('/api/me')).status, 401, 'other devices are signed out too');
  });

  test('polling units near a location', async () => {
    const c = client();
    const lagos = await c.get('/api/geo/near?lat=6.5244&lng=3.3792');
    assert.equal(lagos.status, 200);
    const r = lagos.data.results;
    assert.ok(r.length >= 1 && r.length <= 6);
    for (let i = 1; i < r.length; i++) assert.ok(r[i - 1].metres <= r[i].metres);
    assert.ok(r.every((u) => u.state === 'Lagos' && u.metres < 25000 && u.name && u.code && u.lga && u.ward));
    assert.equal(lagos.headers.get('cache-control'), 'no-store');
    assert.deepEqual((await c.get('/api/geo/near?lat=0&lng=0')).data.results, []);
    assert.equal((await c.get('/api/geo/near?lat=abc&lng=3')).status, 400);
    assert.equal((await c.get('/api/geo/near?lat=95&lng=3')).status, 400);
  });

  test('per-IP code limit is enforced, and X-Forwarded-For from visitors is ignored by Caddy', async () => {
    const ip = `203.0.113.${crypto.randomInt(1, 254)}`;
    const direct = client(APP_URL, { 'X-Forwarded-For': ip });
    for (let i = 0; i < IP_LIMIT; i++) {
      const r = await direct.post('/api/auth/start', { identifier: `limit-${rnd()}@example.com` });
      assert.equal(r.status, 200, `request ${i + 1}: ${r.text}`);
    }
    const blocked = await direct.post('/api/auth/start', { identifier: `limit-${rnd()}@example.com` });
    assert.equal(blocked.status, 429);
    assert.match(blocked.data.error, /Too many codes/);

    // A visitor claiming to be that IP through Caddy is not affected (Caddy replaces the header).
    const spoof = client(SITE, { 'X-Forwarded-For': ip });
    assert.equal((await spoof.post('/api/auth/start', { identifier: `spoof-${rnd()}@example.com` })).status, 200);
    state.blockedIp = ip;
  });

  test('leave a signed-in session for the restart phase', async () => {
    const c = client();
    const email = `keeper-${rnd()}@example.com`;
    await signIn(c, email);
    assert.equal((await c.post('/api/me', PROFILE)).status, 200);
    state.sid = c.sid;
    state.email = email;
    fs.writeFileSync(STATE_FILE, JSON.stringify(state));
  });
}

if (PHASE === 'after-restart') {
  const state = JSON.parse(fs.readFileSync(STATE_FILE, 'utf8'));

  test('sessions and profiles survive an app restart / database restore', async () => {
    const c = client(); c.sid = state.sid;
    const me = await c.get('/api/me');
    assert.equal(me.status, 200, me.text);
    assert.equal(me.data.member.email, state.email);
    assert.equal(me.data.member.full_name, 'Ada Test Obi');
  });

  test('the per-IP limit survives a restart (stored in Postgres)', async () => {
    const direct = client(APP_URL, { 'X-Forwarded-For': state.blockedIp });
    const r = await direct.post('/api/auth/start', { identifier: `limit-${rnd()}@example.com` });
    assert.equal(r.status, 429);
  });

  test('the per-phone daily cap survives a restart', async () => {
    const r = await client(APP_URL, { 'X-Forwarded-For': `192.0.2.${crypto.randomInt(1, 254)}` })
      .post('/api/auth/firebase', { idToken: await firebaseToken(state.cappedPhone), consent: true });
    assert.equal(r.status, 429);
    assert.equal(r.data.dailyLimit, true);
  });
}
