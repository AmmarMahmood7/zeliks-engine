'use strict';
// Demo door: a visitor describes their own business, then chats with an assistant
// built from that description. Used by the zeliks.tech /try page.
//   POST /api/demo/start  {business_name, about}        -> {demo_id, token, business_name, greeting}
//   POST /api/demo/chat   {demo_id, token, text}        -> {reply_text, lead, summary, ready}

const crypto = require('crypto');
const config = require('../config');
const store = require('../store');
const brain = require('../brain');
const { send, readJson } = require('../http');

const ORIGINS = (process.env.DEMO_ORIGINS || 'zeliks.tech,www.zeliks.tech').split(',').map((s) => s.trim());
const STARTS_PER_HOUR = Number(process.env.DEMO_STARTS_PER_HOUR || 6); // per visitor address
const MESSAGES_PER_DEMO = Number(process.env.DEMO_MESSAGES || 30);

const starts = new Map(); // ip -> [timestamps]
const used = new Map(); // demo_id -> messages sent

function originOk(req) {
  try {
    const host = new URL(req.headers.origin || '').hostname;
    return ORIGINS.includes(host) || host === 'localhost';
  } catch {
    return false;
  }
}

function cors(req) {
  return {
    'Access-Control-Allow-Origin': req.headers.origin,
    'Access-Control-Allow-Methods': 'POST, OPTIONS',
    'Access-Control-Allow-Headers': 'Content-Type',
    Vary: 'Origin',
  };
}

function clientIp(req) {
  return String(req.headers['x-forwarded-for'] || req.socket.remoteAddress || '').split(',')[0].trim();
}

function allowStart(ip) {
  const now = Date.now();
  const recent = (starts.get(ip) || []).filter((t) => now - t < 3600e3);
  if (recent.length >= STARTS_PER_HOUR) return false;
  starts.set(ip, [...recent, now]);
  return true;
}

const sign = (demoId) => crypto.createHmac('sha256', config.adminToken || 'dev').update(demoId).digest('hex').slice(0, 48);
const clean = (v, max) => String(v || '').replace(/\s+/g, ' ').trim().slice(0, max);

function factsFor(name, about) {
  return [
    `${name}: ${about}`,
    'This is a live demo. The person chatting is testing the assistant as one of this business\'s customers.',
    'You know only the name and the description above. Never invent prices, opening hours, addresses, staff or availability. If asked, say the team will confirm, and offer to take their details.',
    'Be useful on what the description covers. Ask what they need, then their name, then a phone number, one question at a time.',
    'Put what they want, and when, in the lead "need" field. Set needs_human to true once you have a name, a phone number and what they need.',
  ].join('\n\n');
}

async function route(req, res, path) {
  if (!path.startsWith('/api/demo/')) return false;
  if (req.method === 'OPTIONS') return send(res, 204, '', originOk(req) ? cors(req) : {}), true;
  if (req.method !== 'POST') return false;
  if (!originOk(req)) return send(res, 403, { error: 'origin_not_allowed' }), true;
  const headers = cors(req);
  const body = await readJson(req);

  if (path === '/api/demo/start') {
    if (!allowStart(clientIp(req))) return send(res, 429, { error: 'slow_down' }, headers), true;
    const name = clean(body.business_name, 60);
    const about = clean(body.about, 300);
    if (!name || about.length < 5) return send(res, 400, { error: 'details_required' }, headers), true;
    const id = 'demo-' + crypto.randomBytes(5).toString('hex');
    await store.saveBusiness({
      id, name, timezone: 'Asia/Muscat', facts: factsFor(name, about),
      settings: { demo: true, greeting: `Hi, this is ${name}. How can I help?` },
    });
    return send(res, 200, { demo_id: id, token: sign(id), business_name: name, greeting: `Hi, this is ${name}. How can I help?` }, headers), true;
  }

  if (path === '/api/demo/chat') {
    const id = String(body.demo_id || '');
    const token = String(body.token || '');
    if (!/^demo-[a-f0-9]{10}$/.test(id) || token !== sign(id)) return send(res, 401, { error: 'bad_session' }, headers), true;
    const count = (used.get(id) || 0) + 1;
    if (count > MESSAGES_PER_DEMO) return send(res, 429, { error: 'demo_limit' }, headers), true;
    used.set(id, count);
    const out = await brain.handle({ businessId: id, channel: 'web', contactId: id, text: body.text });
    const conv = await store.getConversation(id, 'web', id);
    const lead = conv ? (await store.db().query('SELECT name, phone, need FROM leads WHERE conversation_id = $1', [conv.id])).rows[0] || {} : {};
    return send(res, 200, {
      reply_text: out?.reply || '',
      lead: { name: lead.name || null, phone: lead.phone || null, need: lead.need || null },
      summary: conv?.summary || '',
      ready: !!lead.phone,
    }, headers), true;
  }
  return false;
}

module.exports = { route, factsFor };
