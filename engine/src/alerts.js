'use strict';
// Tells the business owner about a lead or a chat that needs them.
// Where it goes is a business setting: settings.owner_alert =
//   { webhook_url }        e.g. an n8n workflow that adds a Sheet row and sends an email
//   { telegram_chat_id }   needs ALERT_TELEGRAM_BOT_TOKEN

const store = require('./store');

async function ownerAlert(business, conversation, answer, { handover, transcript }) {
  const target = business.settings?.owner_alert || {};
  const r = await store.db().query(
    'SELECT name, company, phone, email, need FROM leads WHERE conversation_id = $1',
    [conversation.id]
  );
  const lead = r.rows[0] || {};
  const payload = {
    business_id: business.id,
    business_name: business.name,
    reason: handover ? 'needs_you' : 'new_lead',
    channel: conversation.channel,
    contact_id: conversation.contact_id,
    conversation_id: conversation.id,
    page: conversation.page?.url || null,
    lead,
    summary: answer.summary || '',
    transcript: transcript.map((m) => `${m.role === 'assistant' ? 'Assistant' : 'Customer'}: ${m.body}`).join('\n'),
    at: new Date().toISOString(),
  };
  const sent = [];

  if (target.webhook_url) {
    const res = await fetch(target.webhook_url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'X-Zeliks-Secret': target.webhook_secret || '' },
      body: JSON.stringify(payload),
    });
    if (!res.ok) throw new Error(`webhook ${res.status}`);
    sent.push('webhook');
  }
  if (target.telegram_chat_id && process.env.ALERT_TELEGRAM_BOT_TOKEN) {
    const text = [`${business.name}: ${handover ? 'a chat needs you' : 'new lead'} (${conversation.channel})`,
      lead.name && `Name: ${lead.name}`, lead.phone && `Phone: ${lead.phone}`, lead.need && `Needs: ${lead.need}`,
      payload.summary && `Summary: ${payload.summary}`].filter(Boolean).join('\n');
    await fetch(`https://api.telegram.org/bot${process.env.ALERT_TELEGRAM_BOT_TOKEN}/sendMessage`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ chat_id: target.telegram_chat_id, text }),
    });
    sent.push('telegram');
  }
  await store.logEvent(business.id, handover ? 'owner_alert_handover' : 'owner_alert_lead', conversation.id, { sent });
}

module.exports = { ownerAlert };
