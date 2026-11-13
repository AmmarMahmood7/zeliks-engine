'use strict';
// Tells the business owner a chat needs them. Where it goes is a business setting:
// settings.owner_alert = { telegram_chat_id } and/or { webhook_url } (e.g. an n8n webhook).

const store = require('./store');

async function ownerAlert(business, conversation, answer) {
  const target = business.settings?.owner_alert || {};
  const lead = answer.lead || {};
  const lines = [
    `${business.name}: a ${conversation.channel} chat needs you.`,
    lead.name && `Name: ${lead.name}`,
    lead.phone && `Phone: ${lead.phone}`,
    lead.need && `Needs: ${lead.need}`,
    answer.summary && `Summary: ${answer.summary}`,
    `Contact: ${conversation.contact_id}`,
  ].filter(Boolean);
  const text = lines.join('\n');
  const sent = [];

  if (target.telegram_chat_id && process.env.ALERT_TELEGRAM_BOT_TOKEN) {
    await fetch(`https://api.telegram.org/bot${process.env.ALERT_TELEGRAM_BOT_TOKEN}/sendMessage`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ chat_id: target.telegram_chat_id, text }),
    });
    sent.push('telegram');
  }
  if (target.webhook_url) {
    await fetch(target.webhook_url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ business_id: business.id, conversation_id: conversation.id, channel: conversation.channel, contact: conversation.contact_id, lead, summary: answer.summary, text }),
    });
    sent.push('webhook');
  }
  await store.logEvent(business.id, 'owner_alert', conversation.id, { sent });
}

module.exports = { ownerAlert };
