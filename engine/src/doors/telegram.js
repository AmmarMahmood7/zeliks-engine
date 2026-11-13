'use strict';
// Telegram door. Each business's bot posts to /telegram/<bot id>.
// Telegram sends our secret in a header so nobody else can post here.

const config = require('../config');
const store = require('../store');
const brain = require('../brain');
const { send, readJson } = require('../http');

async function route(req, res, path) {
  const m = path.match(/^\/telegram\/(\d+)$/);
  if (!m || req.method !== 'POST') return false;
  if (!config.telegramSecret || req.headers['x-telegram-bot-api-secret-token'] !== config.telegramSecret) {
    return send(res, 401, 'forbidden'), true;
  }
  const update = await readJson(req);
  send(res, 200, 'ok');

  const msg = update.message;
  if (!msg?.text || msg.chat?.type !== 'private') return true;
  const channel = await store.findChannel('telegram', m[1]);
  if (!channel) return true;
  try {
    const out = await brain.handle({ businessId: channel.business_id, channel: 'telegram', contactId: String(msg.chat.id), text: msg.text });
    if (out?.reply) {
      await fetch(`https://api.telegram.org/bot${channel.credentials.bot_token}/sendMessage`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ chat_id: msg.chat.id, text: out.reply }),
      });
    }
  } catch (e) {
    console.error(`telegram: ${e.message}`);
  }
  return true;
}

module.exports = { route };
