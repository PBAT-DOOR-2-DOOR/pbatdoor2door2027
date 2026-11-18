// Like & share feed (/share).
// Posts, videos and news live in Cloudflare D1. The site keeps a copy for two minutes so the
// page only ever loads from here (no change to the security policy) and still works if D1 is briefly down.
// Same pattern as the Zoni events cache in server.js.

export const FEED_PLATFORMS = ['facebook', 'instagram', 'tiktok', 'youtube', 'x', 'web'];
const FEED_ACTIONS = ['like', 'follow', 'read'];
const FEED_TTL = 120_000;
const FEED_RETRY = 15_000;
const FEED_SQL = 'SELECT id, platform, action, name, handle, url, reason, note, added_at FROM items WHERE hidden = 0 ORDER BY added_at DESC LIMIT 500';
const TEXT_LIMITS = { id: 120, name: 200, handle: 80, reason: 300, note: 200, addedAt: 40 };

function clip(value, max) {
  return String(value ?? '').replace(/[\p{Cc}]/gu, '').trim().slice(0, max);
}

/** An https URL, or '' when the value is not one. The original text is kept once it parses. */
function httpsUrl(value) {
  const raw = String(value ?? '').trim();
  if (!raw || /[\p{Cc}]/u.test(raw)) return '';
  try {
    if (new URL(raw).protocol !== 'https:') return '';
    return raw;
  } catch {
    return '';
  }
}

export function sanitizeFeed(rows) {
  if (!Array.isArray(rows)) return [];
  const seen = new Set();
  const out = [];
  for (const row of rows) {
    if (!row || typeof row !== 'object') continue;
    const url = httpsUrl(row.url);
    if (!url || seen.has(url)) continue;
    const platform = clip(row.platform, 40).toLowerCase();
    const action = clip(row.action, 40).toLowerCase();
    if (!FEED_PLATFORMS.includes(platform) || !FEED_ACTIONS.includes(action)) continue;
    seen.add(url);
    out.push({
      id: clip(row.id, TEXT_LIMITS.id),
      platform,
      action,
      url,
      name: clip(row.name, TEXT_LIMITS.name),
      handle: clip(row.handle, TEXT_LIMITS.handle),
      reason: clip(row.reason, TEXT_LIMITS.reason),
      note: clip(row.note, TEXT_LIMITS.note),
      addedAt: clip(row.added_at ?? row.addedAt, TEXT_LIMITS.addedAt),
    });
    if (out.length >= 500) break;
  }
  return out;
}

function filled(value) {
  return String(value ?? '').trim();
}

export function createPbatFeed({ accountId, databaseId, token, logger, fetchImpl = fetch } = {}) {
  const account = filled(accountId);
  const database = filled(databaseId);
  const apiToken = filled(token);
  const configured = Boolean(account && database && apiToken);
  let cache = { at: 0, items: null };

  async function load() {
    if (!configured) return [];
    if (cache.items && Date.now() - cache.at < FEED_TTL) return cache.items;
    try {
      const response = await fetchImpl(
        `https://api.cloudflare.com/client/v4/accounts/${encodeURIComponent(account)}/d1/database/${encodeURIComponent(database)}/query`,
        {
          method: 'POST',
          headers: {
            Authorization: `Bearer ${apiToken}`,
            'Content-Type': 'application/json',
          },
          body: JSON.stringify({ sql: FEED_SQL }),
          signal: AbortSignal.timeout(6000),
        },
      );
      if (!response.ok) throw new Error(`Feed answered ${response.status}`);
      const body = await response.json();
      if (!body || body.success !== true) throw new Error('Feed query failed');
      const items = sanitizeFeed(body.result?.[0]?.results);
      cache = { at: Date.now(), items };
      return items;
    } catch (err) {
      logger.warn({ err: err.message }, 'Could not load the like and share feed; showing the last copy');
      cache.at = Date.now() - FEED_TTL + FEED_RETRY; // try again in 15 seconds, not on every visit
      return cache.items || [];
    }
  }

  return { configured, load };
}
