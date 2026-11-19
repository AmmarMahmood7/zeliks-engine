'use strict';
// Runs the whole engine against an in-memory Postgres and a fake model.
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');
const http = require('http');
const { PGlite } = require('@electric-sql/pglite');

process.env.ADMIN_TOKEN = 'admin-test-token';
process.env.MODEL_API_KEY = 'unused';
const store = require('../src/store');
const brain = require('../src/brain');
const model = require('../src/model');
const meta = require('../src/doors/meta');
const { domainAllowed } = require('../src/doors/web');
const { handler } = require('../src/server');

let server, base, widgetKey;
const replies = [];
model.generate = async ({ system, messages }) => replies.shift()?.({ system, messages }) ?? '{"reply":"Hello from the fake model","needs_human":false}';

test.before(async () => {
  const pg = new PGlite();
  await pg.exec(fs.readFileSync(path.join(__dirname, '..', 'db', 'schema.sql'), 'utf8'));
  store.useClient(pg);
  server = http.createServer(handler).listen(0);
  base = `http://127.0.0.1:${server.address().port}`;
});
test.after(() => { server.closeAllConnections(); server.close(); });

const admin = (p, method, body) =>
  fetch(base + p, { method, headers: { Authorization: 'Bearer admin-test-token', 'Content-Type': 'application/json' }, body: body && JSON.stringify(body) }).then((r) => r.json().then((j) => ({ status: r.status, j })));

test('admin creates a business and a widget key', async () => {
  const b = await admin('/admin/businesses/cafe-one', 'PUT', {
    name: 'Cafe One', facts: 'We sell coffee. Latte OMR 1.5.', settings: { allowed_domains: ['cafeone.om', '.cafeone.om'] },
  });
  assert.equal(b.status, 200);
  assert.equal(b.j.name, 'Cafe One');
  const ch = await admin('/admin/businesses/cafe-one/channels', 'POST', { kind: 'web' });
  assert.match(ch.j.external_id, /^wk_[a-f0-9]{32}$/);
  assert.match(ch.j.snippet, /data-zeliks-key/);
  widgetKey = ch.j.external_id;
  const denied = await fetch(base + '/admin/businesses/cafe-one');
  assert.equal(denied.status, 401);
});

test('widget refuses other websites and works on allowed ones', async () => {
  const headers = (origin) => ({ 'X-Widget-Key': widgetKey, Origin: origin, 'Content-Type': 'application/json' });
  assert.equal((await fetch(base + '/api/widget-config', { headers: headers('https://evil.com') })).status, 403);
  const ok = await fetch(base + '/api/widget-config', { headers: headers('https://www.cafeone.om') });
  assert.equal(ok.status, 200);
  assert.equal((await ok.json()).business_name, 'Cafe One');

  const s = await (await fetch(base + '/api/session', { method: 'POST', headers: headers('https://cafeone.om'), body: '{}' })).json();
  replies.push(({ system }) => {
    assert.match(system, /Latte OMR 1.5/);
    return '```json\n{"reply":"A latte is OMR 1.5.","needs_human":false,"lead":{"name":null},"summary":"Asked latte price"}\n```';
  });
  const r = await (await fetch(base + '/api/chat', { method: 'POST', headers: headers('https://cafeone.om'), body: JSON.stringify({ session_token: s.session_token, text: 'How much is a latte?' }) })).json();
  assert.equal(r.reply_text, 'A latte is OMR 1.5.');
  assert.equal(r.handed_over, false);
});

test('conversation history is sent to the model, lead and handover are saved', async () => {
  const msg = { businessId: 'cafe-one', channel: 'whatsapp', contactId: '96871234567' };
  await brain.handle({ ...msg, text: 'Hi' });
  replies.push(({ messages }) => {
    assert.deepEqual(messages.map((m) => m.role), ['user', 'assistant', 'user']);
    return JSON.stringify({ reply: 'Thanks Ali, the team will message you.', needs_human: true, lead: { name: 'Ali', phone: '96871234567', need: 'catering' }, summary: 'Ali wants catering' });
  });
  const out = await brain.handle({ ...msg, text: 'I am Ali, I need catering for 50 people' });
  assert.equal(out.handedOver, true);
  const lead = await store.db().query("SELECT name, need FROM leads WHERE business_id = 'cafe-one' AND name = 'Ali'");
  assert.equal(lead.rows[0].need, 'catering');
  const ev = await store.db().query("SELECT count(*)::int n FROM events WHERE kind = 'handover'");
  assert.equal(ev.rows[0].n, 1);
});

test('a broken model answer falls back politely and hands over', async () => {
  replies.push(() => 'not json at all');
  const out = await brain.handle({ businessId: 'cafe-one', channel: 'telegram', contactId: '42', text: 'hello?' });
  assert.equal(out.reply, brain.FALLBACK);
});

test('meta webhook parsing covers WhatsApp and Instagram', () => {
  const wa = { entry: [{ changes: [{ value: { metadata: { phone_number_id: 'P1' }, messages: [{ type: 'text', from: '968', text: { body: 'hi' } }, { type: 'image', from: '968' }] } }] }] };
  const ig = { entry: [{ messaging: [{ sender: { id: 'U1' }, recipient: { id: 'IG1' }, message: { text: 'salam' } }, { sender: { id: 'IG1' }, recipient: { id: 'U1' }, message: { text: 'x', is_echo: true } }] }] };
  assert.deepEqual(meta.incoming(wa), [{ kind: 'whatsapp', accountId: 'P1', contactId: '968', text: 'hi' }]);
  assert.deepEqual(meta.incoming(ig), [{ kind: 'instagram', accountId: 'IG1', contactId: 'U1', text: 'salam' }]);
});

test('domain rules', () => {
  assert.ok(domainAllowed(['.zeliks.tech'], 'demos.zeliks.tech'));
  assert.ok(domainAllowed(['zeliks.tech'], 'zeliks.tech'));
  assert.ok(!domainAllowed(['zeliks.tech'], 'evilzeliks.tech'));
  assert.ok(!domainAllowed(['.zeliks.tech'], 'evilzeliks.tech'));
});

test('a new lead is sent once to the owner webhook with the full chat', async () => {
  const got = [];
  const hook = http.createServer((req, res) => {
    let b = ''; req.on('data', (c) => (b += c)); req.on('end', () => { got.push({ secret: req.headers['x-zeliks-secret'], body: JSON.parse(b) }); res.end('ok'); });
  }).listen(0);
  await store.saveBusiness({ id: 'cafe-one', settings: { owner_alert: { webhook_url: `http://127.0.0.1:${hook.address().port}/lead`, webhook_secret: 's3' } } });
  const msg = { businessId: 'cafe-one', channel: 'web', contactId: 'a'.repeat(48) };
  replies.push(() => JSON.stringify({ reply: 'Hi! What is your name?', needs_human: false, lead: {} }));
  await brain.handle({ ...msg, text: 'I want a website' });
  replies.push(() => JSON.stringify({ reply: 'Thanks Mona, we will message you today.', needs_human: false, lead: { name: 'Mona', phone: '+96890000000', need: 'website' }, summary: 'Mona wants a website' }));
  await brain.handle({ ...msg, text: 'Mona, +96890000000' });
  replies.push(() => JSON.stringify({ reply: 'Noted.', needs_human: false, lead: { phone: '+96890000000' } }));
  await brain.handle({ ...msg, text: 'thanks' });
  await new Promise((r) => setTimeout(r, 200));
  hook.closeAllConnections();
  hook.close();
  assert.equal(got.length, 1);
  assert.equal(got[0].secret, 's3');
  assert.equal(got[0].body.lead.name, 'Mona');
  assert.equal(got[0].body.reason, 'new_lead');
  assert.match(got[0].body.transcript, /Customer: I want a website[\s\S]*Assistant: Thanks Mona/);
});

// Demo door (zeliks.tech /try)
const demo = require('../src/doors/demo');
const demoCall = (p, body, origin = 'https://zeliks.tech') =>
  fetch(base + p, { method: 'POST', headers: { Origin: origin, 'Content-Type': 'application/json' }, body: JSON.stringify(body) })
    .then((r) => r.json().then((j) => ({ status: r.status, j })));

test('demo: only our site can start one, and it needs real details', async () => {
  assert.equal((await demoCall('/api/demo/start', { business_name: 'X', about: 'a salon' }, 'https://evil.com')).status, 403);
  assert.equal((await demoCall('/api/demo/start', { business_name: '', about: 'a salon' })).status, 400);
  assert.equal((await demoCall('/api/demo/start', { business_name: 'X', about: 'hi' })).status, 400);
});

test('demo: chat uses the visitor description and reports the lead', async () => {
  const s = await demoCall('/api/demo/start', { business_name: 'Noor Salon', about: 'Hair salon in Al Khuwair, open every day' });
  assert.equal(s.status, 200);
  assert.match(s.j.demo_id, /^demo-[a-f0-9]{10}$/);
  assert.equal(s.j.greeting, 'Hi, this is Noor Salon. How can I help?');

  replies.push(({ system }) => {
    assert.match(system, /Hair salon in Al Khuwair/);
    assert.match(system, /Never invent prices/);
    return JSON.stringify({ reply: 'Sure. Your name and number?', needs_human: true, lead: { name: 'Sara', phone: '+96891234567', need: 'haircut Friday' }, summary: 'Sara wants a haircut' });
  });
  const c = await demoCall('/api/demo/chat', { demo_id: s.j.demo_id, token: s.j.token, text: 'Haircut on Friday?' });
  assert.equal(c.status, 200);
  assert.equal(c.j.reply_text, 'Sure. Your name and number?');
  assert.deepEqual(c.j.lead, { name: 'Sara', phone: '+96891234567', need: 'haircut Friday' });
  assert.equal(c.j.ready, true);

  assert.equal((await demoCall('/api/demo/chat', { demo_id: s.j.demo_id, token: 'x'.repeat(48), text: 'hi' })).status, 401);
  assert.equal((await demoCall('/api/demo/chat', { demo_id: 'cafe-one', token: s.j.token, text: 'hi' })).status, 401);
  const alerts = await store.db().query("SELECT count(*)::int n FROM events WHERE business_id = $1 AND kind LIKE 'owner_alert%' AND payload->'sent' <> '[]'::jsonb", [s.j.demo_id]);
  assert.equal(alerts.rows[0].n, 0, 'demo leads must not reach any owner');
});

test('demo: message cap per demo', async () => {
  const keep = demo.LIMITS.messagesPerDemo;
  demo.LIMITS.messagesPerDemo = 1;
  const s = await demoCall('/api/demo/start', { business_name: 'Cap Cafe', about: 'A small cafe in Muscat' });
  assert.equal((await demoCall('/api/demo/chat', { demo_id: s.j.demo_id, token: s.j.token, text: 'hi' })).status, 200);
  assert.equal((await demoCall('/api/demo/chat', { demo_id: s.j.demo_id, token: s.j.token, text: 'hi' })).status, 429);
  demo.LIMITS.messagesPerDemo = keep;
});

test('demo: visitor address ignores a forged X-Forwarded-For', () => {
  const req = (xff) => ({ headers: { 'x-forwarded-for': xff }, socket: { remoteAddress: '10.0.0.2' } });
  const keep = demo.LIMITS.proxyHops;
  demo.LIMITS.proxyHops = 0;
  assert.equal(demo.clientIp(req('1.1.1.1')), '10.0.0.2');
  demo.LIMITS.proxyHops = 1;
  assert.equal(demo.clientIp(req('6.6.6.6, 203.0.113.9')), '203.0.113.9');
  assert.equal(demo.clientIp(req('')), '10.0.0.2');
  demo.LIMITS.proxyHops = keep;
});

test('demo: hourly caps per visitor and in total', async () => {
  const keep = { ...demo.LIMITS };
  demo.LIMITS.startsPerIpHour = 1000;
  demo.LIMITS.startsTotalHour = 0;
  assert.equal((await demoCall('/api/demo/start', { business_name: 'Busy', about: 'A busy shop in Sohar' })).status, 429);
  demo.LIMITS.startsTotalHour = 1000;
  demo.LIMITS.startsPerIpHour = 0;
  assert.equal((await demoCall('/api/demo/start', { business_name: 'Busy', about: 'A busy shop in Sohar' })).status, 429);
  Object.assign(demo.LIMITS, keep);
});

test('demo: old demos are deleted, real businesses never', async () => {
  await store.saveBusiness({ id: 'demo-0000000000', name: 'Old demo', facts: 'x', settings: { demo: true } });
  await store.saveBusiness({ id: 'demo-real-client', name: 'Looks like a demo', facts: 'x', settings: {} });
  await store.db().query("UPDATE businesses SET created_at = now() - interval '30 days'");
  await demo.cleanup(true);
  const ids = (await store.db().query('SELECT id FROM businesses')).rows.map((r) => r.id);
  assert.ok(!ids.includes('demo-0000000000'));
  assert.ok(ids.includes('demo-real-client'));
  assert.ok(ids.includes('cafe-one'));
});
