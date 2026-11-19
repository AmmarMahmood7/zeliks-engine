'use strict';
// Demo door: a visitor describes their own business, then chats with an assistant
// built from that description. Used by the zeliks.tech /try page.
//   POST /api/demo/start  {business_name, about}        -> {demo_id, token, business_name, greeting}
//   POST /api/demo/chat   {demo_id, token, text}        -> {reply_text, lead, summary, ready}
// Demo businesses get no owner alerts (no settings.owner_alert) and are deleted after DEMO_KEEP_DAYS.

const crypto = require('crypto');
const config = require('../config');
const store = require('../store');
const brain = require('../brain');
const { send, readJson } = require('../http');

const env = process.env;
const list = (v) => String(v || '').split(',').map((s) => s.trim()).filter(Boolean);
const LIMITS = {
  origins: list(env.DEMO_ORIGINS || 'zeliks.tech,www.zeliks.tech'),
  startsPerIpHour: Number(env.DEMO_STARTS_PER_HOUR || 6),
  startsTotalHour: Number(env.DEMO_STARTS_TOTAL_PER_HOUR || 60), // caps model spend
  messagesPerDemo: Number(env.DEMO_MESSAGES || 30),
  keepDays: Number(env.DEMO_KEEP_DAYS || 7),
  // Proxies in front of the engine that add to X-Forwarded-For. 0 = use the socket address.
  proxyHops: Number(env.TRUST_PROXY_HOPS || 0),
};
const HOUR = 3600e3;
const MAX_TRACKED = 10000; // bounds the in-memory maps

const starts = new Map(); // ip -> [timestamps]
let allStarts = []; // timestamps, every visitor
const used = new Map(); // demo_id -> messages sent
let lastCleanup = 0;

function originOk(req) {
  try {
    const host = new URL(req.headers.origin || '').hostname;
    return LIMITS.origins.includes(host) || host === 'localhost';
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

/** The visitor's address. Only trusts X-Forwarded-For entries added by our own proxies. */
function clientIp(req) {
  const socket = String(req.socket.remoteAddress || '');
  if (!LIMITS.proxyHops) return socket;
  const chain = list(req.headers['x-forwarded-for']);
  return chain[chain.length - LIMITS.proxyHops] || socket;
}

function remember(map, key, value) {
  if (!map.has(key) && map.size >= MAX_TRACKED) map.delete(map.keys().next().value);
  map.set(key, value);
}

function allowStart(ip) {
  const now = Date.now();
  allStarts = allStarts.filter((t) => now - t < HOUR);
  if (allStarts.length >= LIMITS.startsTotalHour) return false;
  const recent = (starts.get(ip) || []).filter((t) => now - t < HOUR);
  if (recent.length >= LIMITS.startsPerIpHour) return false;
  remember(starts, ip, [...recent, now]);
  allStarts.push(now);
  return true;
}

const sign = (demoId) => crypto.createHmac('sha256', config.adminToken).update(`demo:${demoId}`).digest('hex').slice(0, 48);

function tokenOk(demoId, token) {
  const want = Buffer.from(sign(demoId));
  const got = Buffer.from(String(token));
  return got.length === want.length && crypto.timingSafeEqual(got, want);
}

const clean = (v, max) => String(v || '').replace(/\s+/g, ' ').trim().slice(0, max);

/** Deletes old demo businesses, at most once an hour. Their chats and leads go with them. */
async function cleanup(force = false) {
  if (!force && Date.now() - lastCleanup < HOUR) return;
  lastCleanup = Date.now();
  await store.db().query(
    "DELETE FROM businesses WHERE id LIKE 'demo-%' AND settings->>'demo' = 'true' AND created_at < now() - make_interval(days => $1)",
    [LIMITS.keepDays]
  );
}

function factsFor(name, about) {
  return [
    `${name}: ${about}`,
    'This is a live demo. The person chatting is testing the assistant as one of this business\'s customers.',
    'You know only the name and the description above. Never invent prices, opening hours, addresses, staff or availability. If asked, say the team will confirm, and offer to take their details.',
    'Be useful on what the description covers. Ask what they need, then their name, then a phone number, one question at a time.',
    'Put what they want, and when, in the lead "need" field. Set needs_human to true once you have a name, a phone number and what they need.',
  ].join('\n\n');
}

async function start(req, res, body, headers) {
  if (!allowStart(clientIp(req))) return send(res, 429, { error: 'slow_down' }, headers);
  const name = clean(body.business_name, 60);
  const about = clean(body.about, 300);
  if (!name || about.length < 5) return send(res, 400, { error: 'details_required' }, headers);
  cleanup().catch((e) => console.error(`[demo] cleanup failed: ${e.message}`));
  const id = 'demo-' + crypto.randomBytes(5).toString('hex');
  const greeting = `Hi, this is ${name}. How can I help?`;
  await store.saveBusiness({ id, name, timezone: 'Asia/Muscat', facts: factsFor(name, about), settings: { demo: true, greeting } });
  return send(res, 200, { demo_id: id, token: sign(id), business_name: name, greeting }, headers);
}

async function chat(req, res, body, headers) {
  const id = String(body.demo_id || '');
  if (!/^demo-[a-f0-9]{10}$/.test(id) || !tokenOk(id, body.token)) return send(res, 401, { error: 'bad_session' }, headers);
  const count = (used.get(id) || 0) + 1;
  if (count > LIMITS.messagesPerDemo) return send(res, 429, { error: 'demo_limit' }, headers);
  remember(used, id, count);
  const out = await brain.handle({ businessId: id, channel: 'web', contactId: id, text: body.text });
  const conv = await store.getConversation(id, 'web', id);
  const lead = conv ? (await store.db().query('SELECT name, phone, need FROM leads WHERE conversation_id = $1', [conv.id])).rows[0] || {} : {};
  return send(res, 200, {
    reply_text: out?.reply || '',
    lead: { name: lead.name || null, phone: lead.phone || null, need: lead.need || null },
    summary: conv?.summary || '',
    ready: !!lead.phone,
  }, headers);
}

async function route(req, res, path) {
  if (!path.startsWith('/api/demo/')) return false;
  if (req.method === 'OPTIONS') return send(res, 204, '', originOk(req) ? cors(req) : {}), true;
  if (req.method !== 'POST') return false;
  if (!originOk(req)) return send(res, 403, { error: 'origin_not_allowed' }), true;
  const headers = cors(req);
  // Tokens are signed with ADMIN_TOKEN; without it the demo stays off rather than use a known key.
  if (!config.adminToken) return send(res, 503, { error: 'demo_off' }, headers), true;
  const body = await readJson(req);
  if (path === '/api/demo/start') return await start(req, res, body, headers), true;
  if (path === '/api/demo/chat') return await chat(req, res, body, headers), true;
  return false;
}

module.exports = { route, factsFor, clientIp, cleanup, LIMITS };
