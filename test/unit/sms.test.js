import { test } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { createSms } from '../../sms.js';

const OK = { data: { code: 'MSG_101', message_id: '1ba7d8d0-b680-11f1-91b5-d2a30e0412c2', message: 'Message queued' }, status: 'success' };
const DENIED = { error: { code: 'TM_3601', message: 'Request Denied', details: [{ code: 'WSE_107', target: 'from' }] } };

/** A stand-in Zoho CPaaS API. `reply(path, body)` returns [status, json]. */
async function zoho(reply, fn) {
  const seen = [];
  const server = http.createServer((req, res) => {
    let body = '';
    req.on('data', (c) => (body += c));
    req.on('end', () => {
      const j = JSON.parse(body);
      seen.push({ path: req.url, headers: req.headers, body: j });
      const [status, out] = reply(req.url, j);
      res.writeHead(status, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify(out));
    });
  });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  try { await fn(`http://127.0.0.1:${server.address().port}/v1.1`); } finally { server.close(); }
  return seen;
}

const WA = { ZOHO_WA_TOKEN: 'Zoho-enczapikey wa-key', ZOHO_WA_FROM: '+234 901 000 0000', ZOHO_WA_TEMPLATE: 'd0109d00-b191-11f1-95b1-aaa8828ce996' };
const VOICE = { ZOHO_VOICE_TOKEN: 'voice-key', ZOHO_VOICE_FROM: '+1 415 555 0142' };

test('Zoho WhatsApp request shape (Authentication template by key, code in merge_info)', async () => {
  let via;
  const [req] = await zoho(() => [200, OK], async (url) => {
    const sms = createSms({ ...WA, ZOHO_CPAAS_API_URL: url });
    assert.equal(sms.provider, 'zoho-whatsapp');
    assert.deepEqual(sms.channels, ['whatsapp']);
    via = await sms.send('+2348031234567', '123456');
  });
  assert.equal(via, 'whatsapp');
  assert.equal(req.path, '/v1.1/whatsapp');
  assert.equal(req.headers.authorization, 'Zoho-enczapikey wa-key');
  assert.deepEqual(req.body, {
    from: '+2349010000000', to: '+2348031234567',
    template_key: 'd0109d00-b191-11f1-95b1-aaa8828ce996', merge_info: { code: '123456' },
  });
});

test('Zoho WhatsApp: template alias and custom variable name', async () => {
  const [req] = await zoho(() => [200, OK], (url) =>
    createSms({ ...WA, ZOHO_WA_TEMPLATE: 'pbat_login_code', ZOHO_WA_CODE_VAR: '1', ZOHO_CPAAS_API_URL: url }).send('+2348031234567', '654321'));
  assert.equal(req.body.template_alias, 'pbat_login_code');
  assert.equal(req.body.template_key, undefined);
  assert.deepEqual(req.body.merge_info, { 1: '654321' });
});

test('Zoho WhatsApp errors are thrown when there is no voice fallback', async () => {
  await zoho(() => [403, DENIED], async (url) => {
    await assert.rejects(createSms({ ...WA, ZOHO_CPAAS_API_URL: url }).send('+2348031234567', '123456'), /Zoho CPaaS \/whatsapp 403/);
  });
  // 200 without a message id is not an acceptance either
  await zoho(() => [200, { status: 'failed' }], async (url) => {
    await assert.rejects(createSms({ ...WA, ZOHO_CPAAS_API_URL: url }).send('+2348031234567', '123456'));
  });
});

test('Zoho: a failed WhatsApp send falls back to a voice call', async () => {
  let via;
  const seen = await zoho((path) => (path.endsWith('/whatsapp') ? [403, DENIED] : [200, OK]), async (url) => {
    const sms = createSms({ ...WA, ...VOICE, ZOHO_CPAAS_API_URL: url });
    assert.equal(sms.provider, 'zoho-whatsapp+voice');
    assert.equal(sms.via, 'whatsapp');
    via = await sms.send('+2348031234567', '123456');
  });
  assert.equal(via, 'voice');
  assert.deepEqual(seen.map((s) => s.path), ['/v1.1/whatsapp', '/v1.1/voice']);
  const call = seen[1];
  assert.equal(call.headers.authorization, 'Zoho-enczapikey voice-key');
  assert.equal(call.body.from, '14155550142');
  assert.equal(call.body.to, '2348031234567');
  assert.match(call.body.message_content, /1, 2, 3, 4, 5, 6/);
  assert.equal(call.body.language, 'en');
});

test('Zoho: { channel: "voice" } calls straight away; a voice template gets the code in merge_info', async () => {
  let via;
  const seen = await zoho(() => [200, OK], async (url) => {
    via = await createSms({ ...WA, ...VOICE, ZOHO_VOICE_TEMPLATE: 'otp_call', ZOHO_CPAAS_API_URL: url })
      .send('+2348031234567', '111222', { channel: 'voice' });
  });
  assert.equal(via, 'voice');
  assert.equal(seen.length, 1);
  assert.equal(seen[0].path, '/v1.1/voice');
  assert.equal(seen[0].body.template_alias, 'otp_call');
  assert.deepEqual(seen[0].body.merge_info, { code: '111222' });
  assert.equal(seen[0].body.message_content, undefined);
});

test('Zoho voice only', async () => {
  const sms = createSms(VOICE);
  assert.equal(sms.provider, 'zoho-voice');
  assert.equal(sms.via, 'voice');
});

test('phone provider order: Zoho first, then Message Central, DageSMS, Termii, Twilio', () => {
  const all = { ...WA, MC_CUSTOMER_ID: 'c', MC_PASSWORD: 'p', DAGESMS_API_KEY: 'd', TERMII_API_KEY: 't', TERMII_SENDER_ID: 's' };
  assert.equal(createSms(all).provider, 'zoho-whatsapp');
  assert.equal(createSms({ ...all, ZOHO_WA_TEMPLATE: '' }).provider, 'messagecentral-sms', 'Zoho WhatsApp needs token, sender and template');
  assert.equal(createSms({ DAGESMS_API_KEY: 'd', TERMII_API_KEY: 't', TERMII_SENDER_ID: 's' }).provider, 'dagesms');
  assert.equal(createSms({}).provider, null);
});
