'use strict';
// Website door: the one-tag widget. Same API contract as the v1 widget,
// so sites that already have the widget keep working after the switch.

const crypto = require('crypto');
const store = require('../store');
const brain = require('../brain');
const { send, readJson } = require('../http');

function originHost(req) {
  try {
    return new URL(req.headers.origin || req.headers.referer || '').hostname.toLowerCase();
  } catch {
    return null;
  }
}

// '.example.com' allows every subdomain; 'example.com' allows exactly that host.
function domainAllowed(allowed, host) {
  if (!host || !Array.isArray(allowed)) return false;
  return allowed.some((d) => {
    const entry = String(d).toLowerCase();
    return entry.startsWith('.') ? host === entry.slice(1) || host.endsWith(entry) : host === entry;
  });
}

function cors(req) {
  if (!req.headers.origin) return {};
  return {
    'Access-Control-Allow-Origin': req.headers.origin,
    'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
    'Access-Control-Allow-Headers': 'Content-Type, X-Widget-Key',
    Vary: 'Origin',
  };
}

// Resolves the widget key to a business, and refuses other websites.
async function auth(req, res) {
  const key = req.headers['x-widget-key'];
  const channel = key ? await store.findChannel('web', String(key)) : null;
  const business = channel ? await store.getBusiness(channel.business_id) : null;
  if (!business) {
    send(res, 401, { error: 'unknown_key' }, cors(req));
    return null;
  }
  if (!domainAllowed(business.settings?.allowed_domains, originHost(req))) {
    send(res, 403, { error: 'domain_not_allowed' }, cors(req));
    return null;
  }
  return business;
}

function greeting(business) {
  return business.settings?.greeting || `Hi, this is ${business.name}. How can I help?`;
}

// Only the fields the assistant needs, size-limited.
function cleanPage(packet) {
  if (!packet || typeof packet !== 'object') return null;
  const page = {};
  if (packet.page?.url) page.url = String(packet.page.url).slice(0, 300);
  if (packet.page?.title) page.title = String(packet.page.title).slice(0, 200);
  if (packet.item) page.item = packet.item;
  if (packet.cart) page.cart = packet.cart;
  const out = JSON.stringify(page);
  return out.length > 2 && out.length < 4000 ? page : null;
}

async function route(req, res, path) {
  if (req.method === 'OPTIONS' && path.startsWith('/api/')) return send(res, 204, '', cors(req)), true;

  if (req.method === 'GET' && path === '/api/widget-config') {
    const b = await auth(req, res);
    if (b) {
      const s = b.settings || {};
      send(res, 200, {
        tenant_id: b.id, business_name: b.name, greeting: greeting(b),
        primary_color: s.primary_color || '#333333', logo_url: s.logo_url || null,
        position: s.position || 'bottom-right',
        variant: s.widget_variant || 'studio', theme: s.widget_theme || 'auto',
      }, cors(req));
    }
    return true;
  }

  if (req.method === 'POST' && path === '/api/session') {
    const b = await auth(req, res);
    if (b) {
      const token = crypto.randomBytes(24).toString('hex');
      send(res, 200, { session_token: token, business_name: b.name, greeting: greeting(b), handed_over: false }, cors(req));
    }
    return true;
  }

  if (req.method === 'POST' && path === '/api/chat') {
    const b = await auth(req, res);
    if (!b) return true;
    const body = await readJson(req);
    const token = String(body.session_token || '');
    if (!/^[a-f0-9]{48}$/.test(token)) return send(res, 400, { error: 'bad_session' }, cors(req)), true;
    const out = await brain.handle({ businessId: b.id, channel: 'web', contactId: token, text: body.text, page: cleanPage(body.packet) });
    // The widget locks its input on handed_over, so only report it when the assistant really stops.
    const locked = !!out?.handedOver && b.settings?.after_handover === 'stop';
    send(res, 200, { reply_text: out?.reply || '', handed_over: locked }, cors(req));
    return true;
  }
  return false;
}

module.exports = { route, domainAllowed };
