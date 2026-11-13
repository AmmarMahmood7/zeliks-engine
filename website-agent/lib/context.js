'use strict';
/*
 * Context building for one chat turn:
 *
 *   system prompt = the business's context document (tenant_config.context_text,
 *                   compiled from its pack by the loader, editable live from
 *                   the context page)
 *                 + the website-channel rules and the JSON answer contract
 *                 + FAQ lookup results for this message (FAQs are NOT in the
 *                   prompt; before this service they never reached an answer
 *                   at all, because the old engine's answer tool was a stub)
 *                 + the live facts packet (what the visitor is looking at)
 *                 + the rolling summary of anything older than the history
 *                   window (see config.HISTORY_MESSAGES)
 *
 *   contents      = the last HISTORY_MESSAGES messages from the messages
 *                   table, oldest first.
 */
const config = require('../config');

const CHANNEL_RULES = `
# This conversation (website chat)

You are answering inside the chat widget on this business's own website.
There are no booking tools on this channel and you cannot check a diary.
Never say an appointment, viewing or order is booked or confirmed. When
the visitor wants to book, reserve, view or be called back, collect their
name and phone number in the chat and tell them the business will call
them to arrange it. The system saves those details as a lead for the
owner on its own.

Facts about what the visitor is looking at right now, and matched FAQs,
may be given to you below the facts. Use them. If the visitor asks about
"this" with no other detail, they mean the item named in the live facts.

# How to answer (output contract)

Reply with one JSON object only, no other text:
{
  "reply_text": "your answer to the visitor, in the visitor's language",
  "intent": "question" | "lead" | "booking_request" | "handover" | "other",
  "lead": null or { "name": "...", "phone": "...", "email": "...", "need": "what they want" },
  "needs_human": true or false,
  "summary": "a running summary of the whole conversation so far, at most 60 words: the visitor's name, any contact details, what they are interested in, and anything agreed"
}
Include "lead" as soon as the visitor has shared a name plus a phone
number or email, or said clearly what they want and how to reach them.
Set "needs_human": true when one of this business's handover rules
applies, or when you cannot answer from the facts you have. When
"needs_human" is true, make reply_text a short, kind message saying the
owner will pick this up.
`;

// ---------------------------------------------------------------- packet

function cleanStr(v, max) {
  if (typeof v !== 'string') return undefined;
  const s = v.trim().slice(0, max || 300);
  return s || undefined;
}
function cleanNum(v) {
  const n = Number(v);
  return Number.isFinite(n) ? n : undefined;
}
function cleanItem(v) {
  if (!v || typeof v !== 'object') return undefined;
  const item = {};
  for (const k of ['kind', 'id', 'name', 'title', 'price', 'beds', 'baths', 'area', 'stock', 'url']) {
    if (k === 'price' || k === 'beds' || k === 'baths') {
      const n = cleanNum(v[k]);
      if (n !== undefined) item[k] = n;
    } else {
      const s = cleanStr(v[k], 200);
      if (s) item[k] = s;
    }
  }
  return Object.keys(item).length ? item : undefined;
}

/** Accept only the packet shapes the widget is allowed to send. */
function sanitisePacket(raw) {
  const out = {};
  if (!raw || typeof raw !== 'object') return out;
  if (raw.page && typeof raw.page === 'object') {
    const page = {};
    const url = cleanStr(raw.page.url, 500);
    const title = cleanStr(raw.page.title, 200);
    if (url) page.url = url;
    if (title) page.title = title;
    if (Object.keys(page).length) out.page = page;
  }
  const item = cleanItem(raw.item || raw.service || raw.property || raw.product);
  if (item) out.item = item;
  if (Array.isArray(raw.cart)) {
    const cart = raw.cart.map(cleanItem).filter(Boolean).slice(0, 20);
    if (cart.length) out.cart = cart;
  }
  if (raw.visitor && typeof raw.visitor === 'object') {
    const name = cleanStr(raw.visitor.name, 120);
    if (name) out.visitor = { name };
  }
  return out;
}

function itemLine(item, currency) {
  const bits = [];
  const label = item.title || item.name || item.id || 'item';
  bits.push(label);
  if (item.kind) bits.push(`(${item.kind})`);
  if (item.area) bits.push(`in ${item.area}`);
  if (item.beds !== undefined) bits.push(`${item.beds} bed`);
  if (item.price !== undefined) {
    bits.push(
      item.price === 0 ? 'free' : `priced ${item.price} ${currency || ''}`.trim()
    );
  }
  if (item.stock !== undefined) bits.push(`stock: ${item.stock}`);
  return bits.join(', ');
}

function renderPacket(packet, currency) {
  if (!packet || !Object.keys(packet).length) return '';
  const lines = ['', '# Live facts: what the visitor is looking at right now', ''];
  if (packet.page) {
    lines.push(
      `- Page: ${packet.page.title || '(untitled)'}${packet.page.url ? ` (${packet.page.url})` : ''}`
    );
  }
  if (packet.item) {
    lines.push(`- The visitor is viewing: ${itemLine(packet.item, currency)}`);
  }
  if (packet.cart && packet.cart.length) {
    lines.push('- In the visitor\'s shortlist / cart:');
    for (const item of packet.cart) lines.push(`  - ${itemLine(item, currency)}`);
  }
  if (packet.visitor && packet.visitor.name) {
    lines.push(`- The visitor's name is ${packet.visitor.name}.`);
  }
  lines.push('');
  return lines.join('\n');
}

// ---------------------------------------------------------------- lookup

function tokenize(text) {
  return new Set(
    String(text || '')
      .toLowerCase()
      .replace(/[^\p{L}\p{N}\s]/gu, ' ')
      .split(/\s+/)
      .filter((w) => w.length >= 3)
  );
}

/** The FAQ fix: score the pack's FAQs against the visitor's words and
 * return the best matches. FAQs deliberately live outside the prompt, so
 * this lookup is the only way their answers reach the model. */
function lookupFaqs(pack, queryText) {
  const faqs = (pack && pack.faqs) || [];
  if (!faqs.length) return [];
  const q = tokenize(queryText);
  if (!q.size) return [];
  const scored = [];
  for (const faq of faqs) {
    const hay = tokenize(`${faq.question} ${(faq.tags || []).join(' ')}`);
    let score = 0;
    for (const w of q) if (hay.has(w)) score += 1;
    if (score >= config.LOOKUP_MIN_SCORE) scored.push({ faq, score });
  }
  scored.sort((a, b) => b.score - a.score);
  return scored.slice(0, config.LOOKUP_MAX_RESULTS).map((s) => s.faq);
}

function renderFaqBlock(faqs) {
  if (!faqs.length) return '';
  const lines = [
    '',
    '# Matched FAQs from this business (use the business\'s own wording)',
    '',
  ];
  for (const f of faqs) {
    lines.push(`Q: ${f.question}`);
    lines.push(`A: ${f.answer}`);
    lines.push('');
  }
  return lines.join('\n');
}

// ---------------------------------------------------------------- prompt

function buildSystemPrompt({ tenant, pack, packet, faqMatches, summary }) {
  let system = tenant.context_text || tenant.system_prompt || '';
  system += '\n' + CHANNEL_RULES;
  const faqBlock = renderFaqBlock(faqMatches || []);
  if (faqBlock) system += '\n' + faqBlock;
  const packetBlock = renderPacket(packet, tenant.currency);
  if (packetBlock) system += '\n' + packetBlock;
  if (summary) {
    system +=
      '\n\n# Earlier in this conversation (summary of the part before the recent messages)\n\n' +
      summary +
      '\n';
  }
  return system;
}

module.exports = {
  sanitisePacket,
  renderPacket,
  lookupFaqs,
  buildSystemPrompt,
  tokenize,
};
