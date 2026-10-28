import { test } from 'node:test';
import assert from 'node:assert/strict';
import { sessionMiddleware, COOKIE_MAX_AGE_MS, REFRESH_MS } from '../../session.js';

const DAY = 24 * 60 * 60 * 1000;
const T0 = 1_800_000_000_000;

function fakeStore(sessions) {
  const touched = [];
  return {
    touched,
    getSession: async (h) => sessions.get(h) || null,
    memberById: async (id) => (id === 7 ? { id: 7, email: 'a@b.co' } : null),
    touchSession: async (h, t) => { touched.push([h, t]); sessions.get(h).last_seen = t; },
  };
}
const fakeRes = () => {
  const res = { cookies: [], cleared: [] };
  res.cookie = (name, value, opts) => res.cookies.push({ name, value, opts });
  res.clearCookie = (name, opts) => res.cleared.push({ name, opts });
  return res;
};
async function run(mw, cookies, extra = {}) {
  const req = { cookies, method: extra.method || 'GET', path: extra.path || '/me' }, res = fakeRes();
  let err;
  await mw(req, res, (e) => { err = e; });
  return { req, res, err };
}

test('rolling cookie: re-issued with a fresh 400-day max-age at most once a day', async () => {
  const sessions = new Map([['h:tok', { token_hash: 'h:tok', member_id: 7, last_seen: T0 }]]);
  const store = fakeStore(sessions);
  let now = T0 + 60_000;
  const mw = sessionMiddleware({ store, hash: (t) => `h:${t}`, secure: true, now: () => now });

  let r = await run(mw, { sid: 'tok' });
  assert.equal(r.req.member.id, 7);
  assert.equal(r.res.cookies.length, 0, 'no refresh within a day');
  assert.equal(store.touched.length, 0, 'no DB write within a day');

  now = T0 + REFRESH_MS + 1;
  r = await run(mw, { sid: 'tok' });
  assert.equal(r.res.cookies.length, 1);
  const c = r.res.cookies[0];
  assert.equal(c.name, 'sid');
  assert.equal(c.value, 'tok', 'same session, same token');
  assert.deepEqual(c.opts, { httpOnly: true, secure: true, sameSite: 'lax', maxAge: COOKIE_MAX_AGE_MS, path: '/' });
  assert.ok(COOKIE_MAX_AGE_MS >= 399 * DAY && COOKIE_MAX_AGE_MS <= 400 * DAY);
  assert.deepEqual(store.touched, [['h:tok', now]], 'last_seen updated with the refresh');

  r = await run(mw, { sid: 'tok' });                 // right after: throttled again
  assert.equal(r.res.cookies.length, 0);
  assert.equal(store.touched.length, 1);
});

test('refreshMs=0 re-issues the cookie on every authenticated request (used by e2e)', async () => {
  const sessions = new Map([['h:tok', { token_hash: 'h:tok', member_id: 7, last_seen: T0 }]]);
  const store = fakeStore(sessions);
  const mw = sessionMiddleware({ store, hash: (t) => `h:${t}`, secure: true, refreshMs: 0, now: () => T0 });
  const r = await run(mw, { sid: 'tok' });
  assert.equal(r.res.cookies.length, 1);
  assert.equal(store.touched.length, 1);
});

test('sessions never expire: a session idle for a year still works and is refreshed', async () => {
  const sessions = new Map([['h:old', { token_hash: 'h:old', member_id: 7, last_seen: T0 - 365 * DAY }]]);
  const mw = sessionMiddleware({ store: fakeStore(sessions), hash: (t) => `h:${t}`, secure: false, now: () => T0 });
  const r = await run(mw, { sid: 'old' });
  assert.equal(r.req.member.id, 7);
  assert.equal(r.res.cookies.length, 1);
  assert.equal(r.res.cleared.length, 0);
});

test('logout and logout-all do not re-issue the cookie, even when refresh is due', async () => {
  const sessions = new Map([['h:tok', { token_hash: 'h:tok', member_id: 7, last_seen: T0 }]]);
  const store = fakeStore(sessions);
  const mw = sessionMiddleware({ store, hash: (t) => `h:${t}`, secure: true, refreshMs: 0, now: () => T0 });
  for (const path of ['/auth/logout', '/auth/logout-all']) {
    store.touched.length = 0;
    const r = await run(mw, { sid: 'tok' }, { method: 'POST', path });
    assert.equal(r.req.member.id, 7);
    assert.equal(r.res.cookies.length, 0, `no rolling Set-Cookie on ${path}`);
    assert.equal(store.touched.length, 0);
  }
});

test('a revoked (logged-out) token is cleared; a database error is a 500, not a logout', async () => {
  const sessions = new Map();
  const mw = sessionMiddleware({ store: fakeStore(sessions), hash: (t) => `h:${t}`, secure: true, now: () => T0 });
  let r = await run(mw, { sid: 'gone' });
  assert.equal(r.req.member, undefined);
  assert.deepEqual(r.res.cleared, [{ name: 'sid', opts: { path: '/' } }]);

  const broken = sessionMiddleware({
    store: { getSession: async () => { throw new Error('connection terminated'); } },
    hash: (t) => t, secure: true,
  });
  r = await run(broken, { sid: 'tok' });
  assert.match(r.err.message, /connection terminated/);
  assert.equal(r.res.cleared.length, 0, 'cookie kept on server errors');

  r = await run(mw, {});
  assert.equal(r.req.member, undefined);
  assert.equal(r.res.cleared.length, 0);
});
