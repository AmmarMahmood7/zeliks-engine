'use strict';
// WhatsApp Cloud API and Instagram DMs share Meta's webhook format,
// so one door serves both. The business is found from the receiving
// account: WhatsApp phone_number_id or Instagram account id.

const crypto = require('crypto');
const config = require('../config');
const store = require('../store');
const brain = require('../brain');
const { send, readRaw } = require('../http');

function signatureOk(req, raw) {
  if (!config.meta.appSecret) return false;
  const given = String(req.headers['x-hub-signature-256'] || '');
  const expected = 'sha256=' + crypto.createHmac('sha256', config.meta.appSecret).update(raw).digest('hex');
  return given.length === expected.length && crypto.timingSafeEqual(Buffer.from(given), Buffer.from(expected));
}

// Turns a webhook body into [{kind, accountId, contactId, text}].
function incoming(body) {
  const out = [];
  for (const entry of body.entry || []) {
    for (const change of entry.changes || []) {
      const v = change.value || {};
      for (const m of v.messages || []) {
        if (m.type === 'text') out.push({ kind: 'whatsapp', accountId: v.metadata?.phone_number_id, contactId: m.from, text: m.text?.body });
      }
    }
    for (const m of entry.messaging || []) {
      if (m.message?.text && !m.message.is_echo) out.push({ kind: 'instagram', accountId: m.recipient?.id, contactId: m.sender?.id, text: m.message.text });
    }
  }
  return out.filter((x) => x.accountId && x.contactId && x.text);
}

async function reply(channel, contactId, text) {
  const token = channel.credentials?.access_token;
  if (!token) throw new Error(`channel ${channel.id} has no access_token`);
  const base = `https://graph.facebook.com/${config.meta.graphVersion}`;
  const body = channel.kind === 'whatsapp'
    ? { messaging_product: 'whatsapp', to: contactId, type: 'text', text: { body: text } }
    : { recipient: { id: contactId }, message: { text } };
  const res = await fetch(`${base}/${channel.external_id}/messages`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
    body: JSON.stringify(body),
  });
  if (!res.ok) throw new Error(`meta send ${res.status}: ${(await res.text()).slice(0, 200)}`);
}

async function handleIncoming(msg) {
  const channel = await store.findChannel(msg.kind, msg.accountId);
  if (!channel) return console.warn(`meta: no channel for ${msg.kind} ${msg.accountId}`);
  const out = await brain.handle({ businessId: channel.business_id, channel: msg.kind, contactId: msg.contactId, text: msg.text });
  if (out?.reply) await reply(channel, msg.contactId, out.reply);
}

async function route(req, res, path, url) {
  if (path !== '/meta') return false;

  // Meta's one-time webhook check.
  if (req.method === 'GET') {
    const ok = url.searchParams.get('hub.verify_token') === config.meta.verifyToken && config.meta.verifyToken;
    send(res, ok ? 200 : 403, ok ? url.searchParams.get('hub.challenge') || '' : 'forbidden');
    return true;
  }
  if (req.method !== 'POST') return false;

  const raw = await readRaw(req, 512 * 1024);
  if (!signatureOk(req, raw)) return send(res, 401, 'bad signature'), true;
  send(res, 200, 'ok'); // answer Meta at once; reply in the background
  for (const msg of incoming(JSON.parse(raw.toString('utf8')))) {
    handleIncoming(msg).catch((e) => console.error(`meta ${msg.kind}: ${e.message}`));
  }
  return true;
}

module.exports = { route, incoming };
