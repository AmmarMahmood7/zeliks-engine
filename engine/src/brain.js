'use strict';
// The one place a message becomes a reply, whatever channel it came from.

const config = require('./config');
const store = require('./store');
const model = require('./model');
const { buildSystem } = require('./prompt');
const alerts = require('./alerts');

const FALLBACK = "Thanks for your message. I'll check with the team and get back to you shortly.";

// msg: { businessId, channel, contactId, text, page? }
// Returns { reply, handedOver } or null when the assistant should stay quiet.
async function handle(msg, deps = { model }) {
  const business = await store.getBusiness(msg.businessId);
  if (!business) throw new Error(`unknown business ${msg.businessId}`);
  const text = String(msg.text || '').slice(0, config.maxMessageChars).trim();
  if (!text) return null;

  const conversation = await store.startTurn({ ...msg, text });
  const stopAfterHandover = business.settings?.after_handover === 'stop';
  if (conversation.status === 'handed_over' && stopAfterHandover) return { reply: null, handedOver: true };

  let answer = null;
  try {
    const raw = await deps.model.generate({
      system: buildSystem({ business, conversation }),
      messages: conversation.history.map((h) => ({ role: h.role === 'assistant' ? 'assistant' : 'user', text: h.body })),
    });
    answer = model.parseJson(raw);
  } catch (err) {
    console.error(`[${business.id}] model failed: ${err.message}`);
  }
  if (!answer || typeof answer.reply !== 'string' || !answer.reply.trim()) {
    answer = { reply: FALLBACK, needs_human: true, lead: null, summary: null };
  }

  const handover = answer.needs_human === true && conversation.status !== 'handed_over';
  const lead = answer.lead || {};
  const hasContact = !!(lead.phone || lead.email);
  // Tell the owner once when contact details first appear, and again on a handover.
  const alertNow = handover || (hasContact && !conversation.alerted_at);
  await store.finishTurn({
    conversation,
    reply: answer.reply,
    summary: answer.summary,
    lead: answer.lead,
    handover,
    alerted: alertNow, // marked before sending, so a quick next message cannot alert twice
  });

  if (alertNow) {
    const transcript = [...conversation.history, { role: 'assistant', body: answer.reply }];
    alerts.ownerAlert(business, conversation, answer, { handover, transcript }).catch((e) => console.error(`[${business.id}] alert failed: ${e.message}`));
  }
  return { reply: answer.reply, handedOver: handover || conversation.status === 'handed_over' };
}

module.exports = { handle, FALLBACK };
