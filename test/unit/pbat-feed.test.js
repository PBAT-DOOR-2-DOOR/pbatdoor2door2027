import { describe, test } from 'node:test';
import assert from 'node:assert/strict';
import { sanitizeFeed, createPbatFeed } from '../../pbat-feed.js';

const SQL = 'SELECT id, platform, action, name, handle, url, reason, note, added_at FROM items WHERE hidden = 0 ORDER BY added_at DESC LIMIT 500';

function row(over = {}) {
  return {
    id: '1',
    platform: 'facebook',
    action: 'like',
    url: 'https://example.com/a',
    name: 'A post',
    handle: 'pbat',
    reason: 'Worth sharing',
    note: 'New today',
    added_at: '2026-11-18T10:00:00Z',
    ...over,
  };
}

describe('like and share feed', { concurrency: 1 }, () => {
  test('sanitizeFeed drops duplicates, unknown platforms, unknown actions, javascript: and http: links', () => {
    const out = sanitizeFeed([
      row({ id: 'a', url: 'https://example.com/a', name: 'First' }),
      row({ id: 'b', url: 'https://example.com/a', name: 'Duplicate' }),
      row({ url: 'https://example.com/myspace', platform: 'myspace' }),
      row({ url: 'https://example.com/comment', action: 'comment' }),
      row({ url: 'javascript:alert(1)' }),
      row({ url: 'javascript:alert(document.domain)', platform: 'web', action: 'read' }),
      row({ url: 'http://example.com/insecure' }),
      row({ url: 'HTTP://example.com/also-insecure' }),
      row({ id: 'ok', url: 'https://example.com/ok', name: 'Kept' }),
      { id: 'news', platform: 'web', action: 'read', url: 'https://news.example/story', name: 'A story', addedAt: '2026-11-18' },
      null,
      'nope',
    ]);
    assert.deepEqual(out.map((item) => item.url), [
      'https://example.com/a',
      'https://example.com/ok',
      'https://news.example/story',
    ]);
    assert.equal(out[0].id, 'a');
    assert.equal(out[0].name, 'First');
    assert.equal(out[0].addedAt, '2026-11-18T10:00:00Z');
    assert.equal(out[2].platform, 'web');
    assert.equal(out[2].action, 'read');
    assert.equal(out[2].addedAt, '2026-11-18');
    assert.deepEqual(Object.keys(out[0]).sort(), ['action', 'addedAt', 'handle', 'id', 'name', 'note', 'platform', 'reason', 'url']);
  });

  test('sanitizeFeed trims long text and strips control characters', () => {
    const [item] = sanitizeFeed([row({
      id: `  ${'x'.repeat(200)}\n`,
      name: `${'N'.repeat(100)}\u0000${'N'.repeat(150)}`,
      handle: ` \t${'h'.repeat(90)}\t `,
      reason: `Why\u001f${'r'.repeat(400)}`,
      note: '\tHello\u0007 there\t',
      added_at: ` \n${'2026-11-18T10:00:00Z'.padEnd(55, 'x')}\n `,
    })]);
    assert.equal(item.id, 'x'.repeat(120));
    assert.equal(item.name, 'N'.repeat(200));
    assert.equal(item.handle, 'h'.repeat(80));
    assert.equal(item.reason, `Why${'r'.repeat(297)}`);
    assert.equal(item.note, 'Hello there');
    assert.equal(item.addedAt, '2026-11-18T10:00:00Z'.padEnd(55, 'x').slice(0, 40));
    assert.equal(item.addedAt.length, 40);
    assert.equal(sanitizeFeed([row(), row(), ...Array.from({ length: 600 }, (_, i) => row({ url: `https://example.com/n${i}` }))]).length, 500);
  });

  test('unconfigured feed returns [] and never calls fetch', async () => {
    let calls = 0;
    const fetchImpl = async () => { calls += 1; throw new Error('should not be called'); };
    const logger = { warn() { throw new Error('should not log'); } };
    const cases = [
      { accountId: '', databaseId: 'db', token: 'tok' },
      { accountId: 'acc', databaseId: '', token: 'tok' },
      { accountId: 'acc', databaseId: 'db', token: '' },
      { accountId: '  ', databaseId: 'db', token: 'tok' },
      { accountId: undefined, databaseId: undefined, token: undefined },
    ];
    for (const fields of cases) {
      const feed = createPbatFeed({ ...fields, logger, fetchImpl });
      assert.equal(feed.configured, false);
      assert.deepEqual(await feed.load(), []);
      assert.deepEqual(await feed.load(), []);
    }
    assert.equal(calls, 0);
  });

  test('configured feed calls the right D1 URL with the Bearer token, and the second load() is served from cache', async () => {
    const calls = [];
    const payload = { success: true, result: [{ results: [row({ name: 'Cached' })] }] };
    const fetchImpl = async (url, opts) => {
      calls.push({ url, opts });
      return { ok: true, json: async () => payload };
    };
    const feed = createPbatFeed({
      accountId: 'acc',
      databaseId: '867315d4-b1f7-40bb-a964-d69ffa1828c7',
      token: 'secret-token',
      logger: { warn() { throw new Error('should not log'); } },
      fetchImpl,
    });
    assert.equal(feed.configured, true);
    const first = await feed.load();
    const second = await feed.load();
    assert.equal(calls.length, 1);
    assert.equal(calls[0].url, 'https://api.cloudflare.com/client/v4/accounts/acc/d1/database/867315d4-b1f7-40bb-a964-d69ffa1828c7/query');
    assert.equal(calls[0].opts.method, 'POST');
    assert.equal(calls[0].opts.headers.Authorization, 'Bearer secret-token');
    assert.equal(calls[0].opts.headers['Content-Type'], 'application/json');
    assert.equal(JSON.parse(calls[0].opts.body).sql, SQL);
    assert.ok(calls[0].opts.signal instanceof AbortSignal);
    assert.equal(first[0].name, 'Cached');
    assert.deepEqual(second, first);
  });

  test('after a failure, once the cache has expired (mock Date.now), the feed returns the last good copy and logs one warning', async () => {
    let now = 1_700_000_000_000;
    const original = Date.now;
    Date.now = () => now;
    try {
      let fetches = 0;
      const warnings = [];
      const fetchImpl = async () => {
        fetches += 1;
        if (fetches > 1) return { ok: true, status: 200, json: async () => ({ success: false }) };
        return { ok: true, json: async () => ({ success: true, result: [{ results: [row({ name: 'Kept', url: 'https://example.com/kept' })] }] }) };
      };
      const feed = createPbatFeed({
        accountId: 'acc',
        databaseId: 'db',
        token: 'tok',
        logger: { warn(extra, msg) { warnings.push({ extra, msg }); } },
        fetchImpl,
      });
      const first = await feed.load();
      assert.equal(first[0].name, 'Kept');
      assert.equal(fetches, 1);
      now += 120_000;
      const second = await feed.load();
      assert.equal(second[0].name, 'Kept');
      assert.equal(second[0].url, 'https://example.com/kept');
      assert.equal(fetches, 2);
      assert.equal(warnings.length, 1);
      now += 10_000;
      const third = await feed.load();
      assert.deepEqual(third, second);
      assert.equal(fetches, 2);
      assert.equal(warnings.length, 1);
    } finally {
      Date.now = original;
    }
  });
});
