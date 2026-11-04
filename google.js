// Public Google sign-in (OAuth 2.0 authorization code). Any Google account can join.
// There is no allow-list. Client id/secret stay in env and are never sent to the browser.

import crypto from 'node:crypto';

const AUTH_URL = 'https://accounts.google.com/o/oauth2/v2/auth';
const TOKEN_URL = 'https://oauth2.googleapis.com/token';
const USERINFO_URL = 'https://www.googleapis.com/oauth2/v2/userinfo';
export const STATE_COOKIE = 'gostate';
const STATE_MS = 10 * 60 * 1000;

const trim = (v) => String(v || '').trim();

export function googleEnabled(env = process.env) {
  return Boolean(trim(env.GOOGLE_CLIENT_ID) && trim(env.GOOGLE_CLIENT_SECRET) && trim(env.GOOGLE_REDIRECT_URI));
}

export function googleErrorRedirect(code) {
  return `/login?google_error=${encodeURIComponent(code)}`;
}

export function createGoogle(env = process.env) {
  const clientId = trim(env.GOOGLE_CLIENT_ID);
  const clientSecret = trim(env.GOOGLE_CLIENT_SECRET);
  const redirectUri = trim(env.GOOGLE_REDIRECT_URI);
  const authUrl = trim(env.GOOGLE_AUTH_URL) || AUTH_URL;
  const tokenUrl = trim(env.GOOGLE_TOKEN_URL) || TOKEN_URL;
  const userinfoUrl = trim(env.GOOGLE_USERINFO_URL) || USERINFO_URL;
  const enabled = Boolean(clientId && clientSecret && redirectUri);
  const hmacKey = clientSecret || 'disabled';

  const sign = (p) => crypto.createHmac('sha256', hmacKey).update(p).digest('base64url');
  const safeEqual = (a, b) =>
    a.length === b.length && crypto.timingSafeEqual(Buffer.from(a), Buffer.from(b));

  function issueState({ consent = false, sms = false, now = Date.now() } = {}) {
    const nonce = crypto.randomBytes(16).toString('base64url');
    const p = `${nonce}|${consent ? 1 : 0}|${sms ? 1 : 0}|${now + STATE_MS}`;
    return { nonce, state: `${Buffer.from(p).toString('base64url')}.${sign(p)}` };
  }

  function readState(state, nonce) {
    const [b, sig] = String(state || '').split('.');
    if (!b || !sig || !nonce) return null;
    let p;
    try { p = Buffer.from(b, 'base64url').toString(); } catch { return null; }
    if (!safeEqual(sig, sign(p))) return null;
    const [got, consent, sms, exp] = p.split('|');
    if (!got || got !== String(nonce) || !(Number(exp) > Date.now())) return null;
    return { consent: consent === '1', sms: sms === '1' };
  }

  function authorizationUrl(state) {
    const u = new URL(authUrl);
    u.searchParams.set('client_id', clientId);
    u.searchParams.set('redirect_uri', redirectUri);
    u.searchParams.set('response_type', 'code');
    u.searchParams.set('scope', 'openid email profile');
    u.searchParams.set('state', state);
    u.searchParams.set('prompt', 'select_account');
    return u.toString();
  }

  async function exchangeCode(code) {
    const tokenRes = await fetch(tokenUrl, {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({
        code: String(code || ''),
        client_id: clientId,
        client_secret: clientSecret,
        redirect_uri: redirectUri,
        grant_type: 'authorization_code',
      }),
    });
    const tokens = await tokenRes.json().catch(() => ({}));
    if (!tokenRes.ok || !tokens.access_token) {
      const err = new Error('google_token_failed');
      err.code = 'google_token_failed';
      throw err;
    }
    const infoRes = await fetch(userinfoUrl, {
      headers: { Authorization: `Bearer ${tokens.access_token}` },
    });
    const info = await infoRes.json().catch(() => ({}));
    if (!infoRes.ok) {
      const err = new Error('google_userinfo_failed');
      err.code = 'google_userinfo_failed';
      throw err;
    }
    const email = String(info.email || '').trim().toLowerCase();
    if (!email || !email.includes('@')) {
      const err = new Error('google_no_email');
      err.code = 'google_no_email';
      throw err;
    }
    return {
      email,
      verified: info.verified_email === true || info.email_verified === true,
      name: String(info.name || '').trim(),
    };
  }

  return {
    enabled,
    clientId,
    redirectUri,
    authUrl,
    issueState,
    readState,
    authorizationUrl,
    exchangeCode,
    cookieOptions(secure) {
      return { httpOnly: true, secure, sameSite: 'lax', maxAge: STATE_MS, path: '/' };
    },
  };
}
