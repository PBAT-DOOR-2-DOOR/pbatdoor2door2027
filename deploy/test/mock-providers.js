// Stand-in for Brevo (email), Zoho CPaaS (WhatsApp + voice) and DageSMS (SMS) during the stack
// tests, so the app runs with its production configuration and real provider code paths. Records
// each message; the tests read the latest code for an address from GET /codes?to=<email or +234…>,
// which also says how it was delivered ({ code, channel }).
// Zoho WhatsApp refuses numbers ending in 0000 (like a number that can't get WhatsApp messages),
// so the tests can check the fallback to a voice call.
import http from 'node:http';

const latest = new Map();
const ZOHO_OK = (id) => ({ data: { code: 'MSG_101', message_id: id, message: 'Message queued' }, status: 'success' });

http.createServer((req, res) => {
  const url = new URL(req.url, 'http://mock');
  if (req.method === 'GET' && url.pathname === '/codes') {
    const hit = latest.get(url.searchParams.get('to'));
    res.writeHead(hit ? 200 : 404, { 'Content-Type': 'application/json' });
    return res.end(JSON.stringify(hit || { code: null }));
  }
  let body = '';
  req.on('data', (c) => (body += c));
  req.on('end', () => {
    let j = {};
    try { j = JSON.parse(body); } catch {}
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
