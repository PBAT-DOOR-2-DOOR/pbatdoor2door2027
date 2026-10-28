// Login sessions: they never expire on the server, only logging out (this device or all) ends one.
// The browser caps cookie lifetime at ~400 days, so the cookie is rolled: on an authenticated
// request it is re-issued with a fresh max-age, at most once per `refreshMs` per session, and
// last_seen is updated at the same moment (one DB write per session per day, not per request).

export const COOKIE_NAME = 'sid';
export const COOKIE_MAX_AGE_MS = 400 * 24 * 60 * 60 * 1000;
export const REFRESH_MS = 24 * 60 * 60 * 1000;

export const cookieOptions = (secure) => ({
  httpOnly: true, secure, sameSite: 'lax', maxAge: COOKIE_MAX_AGE_MS, path: '/',
});

/**
 * Express middleware: loads req.member / req.sessionHash from the cookie and rolls the cookie.
 * An unknown token (logged out, or revoked by "log out of all devices") clears the cookie.
 * Database errors are passed on (a 500), never treated as "logged out".
 */
export function sessionMiddleware({ store, hash, secure, refreshMs = REFRESH_MS, now = Date.now }) {
  return async (req, res, next) => {
    try {
      const token = req.cookies?.[COOKIE_NAME];
      if (!token) return next();
      const s = await store.getSession(hash(token));
      const member = s && (await store.memberById(s.member_id));
      if (!member) {
        res.clearCookie(COOKIE_NAME, { path: '/' });
        return next();
      }
      req.member = member;
      req.sessionHash = s.token_hash;
      const t = now();
      if (t - s.last_seen >= refreshMs) {
        await store.touchSession(s.token_hash, t);
        res.cookie(COOKIE_NAME, token, cookieOptions(secure));
      }
      next();
    } catch (err) {
      next(err);
    }
  };
}
