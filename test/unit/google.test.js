import { test } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createGoogle, googleEnabled, googleErrorRedirect, STATE_COOKIE } from '../../google.js';

const ENV = {
  GOOGLE_CLIENT_ID: 'client-id',
  GOOGLE_CLIENT_SECRET: 'client-secret',
  GOOGLE_REDIRECT_URI: 'https://pbatdoor2door2027.org/api/auth/google/callback',
};

test('Google sign-in is off until client id, secret and redirect URI are all set', () => {
  assert.equal(googleEnabled({}), false);
  assert.equal(googleEnabled({ GOOGLE_CLIENT_ID: 'x', GOOGLE_CLIENT_SECRET: 'y' }), false);
  assert.equal(googleEnabled(ENV), true);
  assert.equal(createGoogle({}).enabled, false);
  assert.equal(createGoogle(ENV).enabled, true);
});

test('authorization URL is Google OAuth with PBAT callback, no invite hint', () => {
  const g = createGoogle(ENV);
  const url = new URL(g.authorizationUrl('state-token'));
  assert.equal(url.origin, 'https://accounts.google.com');
  assert.equal(url.pathname, '/o/oauth2/v2/auth');
  assert.equal(url.searchParams.get('client_id'), 'client-id');
  assert.equal(url.searchParams.get('redirect_uri'), ENV.GOOGLE_REDIRECT_URI);
  assert.equal(url.searchParams.get('response_type'), 'code');
  assert.equal(url.searchParams.get('scope'), 'openid email profile');
  assert.equal(url.searchParams.get('state'), 'state-token');
  assert.equal(url.searchParams.get('prompt'), 'select_account');
  assert.equal(url.searchParams.get('hd'), null);
});

test('signed OAuth state carries consent and rejects a bad nonce or signature', () => {
  const g = createGoogle(ENV);
  const { nonce, state } = g.issueState({ consent: true, sms: true });
  assert.deepEqual(g.readState(state, nonce), { consent: true, sms: true });
  assert.equal(g.readState(state, 'other-nonce'), null);
  assert.equal(g.readState(state.slice(0, -2) + 'xx', nonce), null);
  assert.equal(g.readState('', nonce), null);
  const stale = g.issueState({ now: Date.now() - 11 * 60 * 1000 });
  assert.equal(g.readState(stale.state, stale.nonce), null);
  assert.deepEqual(g.cookieOptions(true), {
    httpOnly: true, secure: true, sameSite: 'lax', maxAge: 10 * 60 * 1000, path: '/',
  });
  assert.equal(STATE_COOKIE, 'gostate');
  assert.equal(googleErrorRedirect('denied'), '/login?google_error=denied');
});

test('code exchange returns a verified email from any Google account (invite list unused)', async () => {
  const seen = [];
  const server = http.createServer((req, res) => {
    let body = '';
    req.on('data', (c) => (body += c));
    req.on('end', () => {
      seen.push({ url: req.url, method: req.method, auth: req.headers.authorization, body });
      if (req.url === '/token') {
        const form = new URLSearchParams(body);
        assert.equal(form.get('grant_type'), 'authorization_code');
        assert.equal(form.get('code'), 'auth-code');
        assert.equal(form.get('client_id'), 'client-id');
        assert.equal(form.get('redirect_uri'), ENV.GOOGLE_REDIRECT_URI);
        res.writeHead(200, { 'Content-Type': 'application/json' });
        return res.end(JSON.stringify({ access_token: 'access-tok' }));
      }
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({
        email: 'Stranger.NotOnAnyList@gmail.com',
        verified_email: true,
        name: 'Stranger',
      }));
    });
  });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  const base = `http://127.0.0.1:${server.address().port}`;
  try {
    const g = createGoogle({
      ...ENV,
      GOOGLE_TOKEN_URL: `${base}/token`,
      GOOGLE_USERINFO_URL: `${base}/userinfo`,
      GOOGLE_INVITE_EMAILS: 'filatei@gmail.com,francisaduku00@gmail.com',
    });
    const profile = await g.exchangeCode('auth-code');
    assert.deepEqual(profile, { email: 'stranger.notonanylist@gmail.com', verified: true, name: 'Stranger' });
    assert.equal(seen[1].auth, 'Bearer access-tok');
  } finally {
    server.close();
  }
});

test('code exchange fails when Google rejects the code', async () => {
  const server = http.createServer((req, res) => {
    res.writeHead(400, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ error: 'invalid_grant' }));
  });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  const base = `http://127.0.0.1:${server.address().port}`;
  try {
    const g = createGoogle({ ...ENV, GOOGLE_TOKEN_URL: `${base}/token`, GOOGLE_USERINFO_URL: `${base}/info` });
    await assert.rejects(() => g.exchangeCode('bad'), { code: 'google_token_failed' });
  } finally {
    server.close();
  }
});

test('runtime code never reads an invite allow-list env var', () => {
  const root = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
  for (const file of ['google.js', 'server.js']) {
    const text = fs.readFileSync(path.join(root, file), 'utf8');
    assert.doesNotMatch(text, /GOOGLE_INVITE_EMAILS/, `${file} must not read an invite list`);
  }
  assert.doesNotMatch(fs.readFileSync(path.join(root, '.env.example'), 'utf8'), /^GOOGLE_INVITE_EMAILS=/m);
});
