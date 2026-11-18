// Google Analytics: off until a Measurement ID is set; when on, the CSP allows Google and pages send no ?codes.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { analyticsScript, gaValid } from '../../analytics.js';
import { securityHeaders } from '../../security.js';

const PUBLIC = path.join(path.dirname(fileURLToPath(import.meta.url)), '../../public');
const csp = (opts) => new Promise((ok) => {
  const headers = {}; const res = { setHeader: (k, v) => { headers[k.toLowerCase()] = v; }, getHeader: (k) => headers[k.toLowerCase()], removeHeader() {} };
  securityHeaders({ publicDir: PUBLIC, isProd: true, ...opts })({ headers: {} }, res, () => ok(headers['content-security-policy']));
});

test('analytics is off without a valid Measurement ID', () => {
  assert.equal(gaValid(''), false); assert.equal(gaValid('UA-1234-1'), false); assert.equal(gaValid('G-ABC123XYZ'), true);
  assert.match(analyticsScript(''), /off/); assert.doesNotMatch(analyticsScript(''), /googletagmanager/);
});

test('when on: loads gtag, strips ?codes and #… from the page address, ads features off', () => {
  const js = analyticsScript('G-ABC123XYZ');
  assert.match(js, /googletagmanager\.com\/gtag\/js\?id=/); assert.match(js, /"G-ABC123XYZ"/);
  assert.match(js, /page_location: location\.origin \+ location\.pathname/);
  assert.match(js, /allow_google_signals: false/); assert.match(js, /allow_ad_personalization_signals: false/);
  assert.doesNotThrow(() => new Function(js));
});

test('CSP allows Google Analytics only when it is on, and still no inline script', async () => {
  const off = await csp({}), on = await csp({ analytics: true });
  assert.doesNotMatch(off, /googletagmanager|google-analytics/);
  assert.match(on, /script-src [^;]*https:\/\/www\.googletagmanager\.com/);
  assert.match(on, /connect-src [^;]*https:\/\/\*\.google-analytics\.com/);
  assert.match(on, /img-src [^;]*https:\/\/\*\.google-analytics\.com/);
  assert.doesNotMatch(on, /script-src[^;]*'unsafe-inline'/);
});

test('every page (except the offline page) loads /analytics.js', () => {
  for (const f of fs.readdirSync(PUBLIC).filter((x) => x.endsWith('.html') && x !== 'offline.html')) {
    assert.match(fs.readFileSync(path.join(PUBLIC, f), 'utf8'), /<script src="\/analytics\.js" defer><\/script>\s*<\/head>/, f);
  }
});
