// Stand-in for Brevo (email), Firebase Phone Auth (JWKS + test ID tokens), Zoho CPaaS and
// DageSMS during the stack tests. The app runs with its production configuration; tests mint a
// Firebase ID token from POST /firebase/token and read email codes from GET /codes?to=…
import http from 'node:http';
import crypto from 'node:crypto';

const latest = new Map();
const ZOHO_OK = (id) => ({ data: { code: 'MSG_101', message_id: id, message: 'Message queued' }, status: 'success' });
const PROJECT = (process.env.FIREBASE_PROJECT_ID || 'pbat-test').trim();

const { publicKey, privateKey } = crypto.generateKeyPairSync('rsa', { modulusLength: 2048 });
const jwk = { ...publicKey.export({ format: 'jwk' }), kid: 'test', alg: 'RS256', use: 'sig' };

function signJwt(payload) {
  const header = Buffer.from(JSON.stringify({ alg: 'RS256', kid: 'test', typ: 'JWT' })).toString('base64url');
  const body = Buffer.from(JSON.stringify(payload)).toString('base64url');
  const sig = crypto.sign('sha256', Buffer.from(`${header}.${body}`), privateKey).toString('base64url');
  return `${header}.${body}.${sig}`;
}

http.createServer((req, res) => {
  const url = new URL(req.url, 'http://mock');
  if (req.method === 'GET' && url.pathname === '/codes') {
    const hit = latest.get(url.searchParams.get('to'));
    res.writeHead(hit ? 200 : 404, { 'Content-Type': 'application/json' });
    return res.end(JSON.stringify(hit || { code: null }));
  }
  if (req.method === 'GET' && url.pathname === '/firebase/jwks') {
    res.writeHead(200, { 'Content-Type': 'application/json' });
    return res.end(JSON.stringify({ keys: [jwk] }));
  }
  let body = '';
  req.on('data', (c) => (body += c));
  req.on('end', () => {
    let j = {};
    try { j = JSON.parse(body); } catch {}
    if (url.pathname === '/firebase/token') {
      const phone = String(j.phone || '');
      const now = Math.floor(Date.now() / 1000);
      const idToken = signJwt({
        iss: `https://securetoken.google.com/${PROJECT}`,
        aud: PROJECT,
        auth_time: now,
        user_id: phone,
        sub: phone,
        iat: now,
        exp: now + 3600,
        phone_number: phone,
        firebase: { sign_in_provider: 'phone' },
      });
      res.writeHead(200, { 'Content-Type': 'application/json' });
      return res.end(JSON.stringify({ idToken }));
    }
    const zohoAuth = /^Zoho-enczapikey \S+$/.test(req.headers.authorization || '');
    let to = null, code = null, channel = null;
    if (url.pathname === '/brevo' && req.headers['api-key']) { to = j.to?.[0]?.email; code = String(j.subject || '').match(/\b(\d{6})\b/)?.[1]; channel = 'email'; }
    if (url.pathname === '/dagesms/v1/messages' && /^Bearer /.test(req.headers.authorization || '')) { to = j.to; code = String(j.body || '').match(/\b(\d{6})\b/)?.[1]; channel = 'sms'; }
    if (url.pathname === '/zoho/v1.1/whatsapp' && zohoAuth && j.from && (j.template_key || j.template_alias)) {
      if (String(j.to).endsWith('0000')) {
        res.writeHead(403, { 'Content-Type': 'application/json' });
        return res.end(JSON.stringify({ error: { code: 'TM_3601', message: 'Request Denied', details: [{ code: 'WA_999', target: 'to' }] } }));
      }
      to = j.to; code = j.merge_info?.code; channel = 'whatsapp';
    }
    if (url.pathname === '/zoho/v1.1/voice' && zohoAuth && j.from) {
      to = `+${j.to}`; code = String(j.message_content || '').replace(/[^\d]/g, '').slice(0, 6); channel = 'voice';
    }
    if (!to || !/^\d{6}$/.test(String(code || ''))) { res.writeHead(400); return res.end('{"status":"error"}'); }
    latest.set(to, { code, channel });
    console.log(`mock: ${url.pathname} -> ${to}`);
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify(url.pathname.startsWith('/zoho/') ? ZOHO_OK(`m-${Date.now()}`) : { status: 'success', messageId: `m${Date.now()}` }));
  });
}).listen(8025, '0.0.0.0', () => console.log('mock providers on :8025'));
