'use strict';
/*
 * Zeliks website assistant (Phase 1): one small Node service.
 *
 *   GET  /widget.js          the loader script the one-tag install serves
 *   GET  /api/widget-config  widget look for a key (domain-checked)
 *   POST /api/session        open a conversation, store the live packet
 *   POST /api/chat           one turn: history + FAQ lookup + packet +
 *                            context document -> one Gemini call -> writes
 *                            messages, lead, handover, rolling summary
 *   GET  /api/context        owner: read the live context document (PIN)
 *   POST /api/context        owner: save a new context document (PIN)
 *   POST /api/context/auto   owner: re-read facts from the business's
 *                            own website into the AUTO block (PIN)
 *   POST /api/context/create owner: create a blank business (PIN)
 *   GET  /context/<tenant>   owner: the business's one context page:
 *                            install snippet + context editor (PIN)
 *
 * Security shape: nothing trusts a bare business name. Every widget call
 * carries the business's widget key AND must come from one of the
 * domains in that business's pack. Owner edits need the key PLUS the
 * edit PIN (DEMO_EDIT_PIN, server-side only). Unknown keys and wrong
 * domains are refused; there is no fallback business anywhere.
 */
const http = require('http');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const config = require('./config');
const db = require('./lib/db');
const model = require('./lib/model');
const ctx = require('./lib/context');
const { upsertBusiness, snippetFor } = require('./lib/onboard');
const autofetch = require('./lib/autofetch');
const { renderContextPage, renderNotFound } = require('./lib/context_page');

const WIDGET_JS = fs.readFileSync(path.join(__dirname, 'widget.js'), 'utf8');

// Demo pages, served by the service itself as a fallback host while the
// demos.zeliks.tech Pages deployment of the same pages is pending.
// Same built folders as sites/assistant-* in the zeliks-demos repo.
const DEMO_PAGES = {};
for (const name of ['salon', 'estate', 'context', 'zeliks']) {
  try {
    DEMO_PAGES[name] = fs.readFileSync(
      path.join(__dirname, 'demo', name, 'index.html'),
      'utf8'
    );
  } catch (_) {
    DEMO_PAGES[name] = null;
  }
}

// ------------------------------------------------------------ utilities

function sendJson(res, status, obj, extraHeaders) {
  const body = JSON.stringify(obj);
  res.writeHead(status, {
    'Content-Type': 'application/json; charset=utf-8',
    'Content-Length': Buffer.byteLength(body),
    ...(extraHeaders || {}),
  });
  res.end(body);
}

function fail(res, status, code, message) {
  sendJson(res, status, { error: code, message: message || code });
}

function readBody(req, maxBytes) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let size = 0;
    req.on('data', (c) => {
      size += c.length;
      if (size > (maxBytes || 65536)) {
        reject(new Error('body_too_large'));
        req.destroy();
        return;
      }
      chunks.push(c);
    });
    req.on('end', () => {
      const raw = Buffer.concat(chunks).toString('utf8');
      if (!raw) return resolve({});
      try {
        resolve(JSON.parse(raw));
      } catch (_) {
        reject(new Error('bad_json'));
      }
    });
    req.on('error', reject);
  });
}

function requestHost(req) {
  const src = req.headers.origin || req.headers.referer || '';
  try {
    return new URL(src).hostname.toLowerCase();
  } catch (_) {
    return null;
  }
}

function domainAllowed(pack, host) {
  const domains =
    pack && pack.widget && Array.isArray(pack.widget.allowed_domains)
      ? pack.widget.allowed_domains
      : null;
  if (!domains || !domains.length || !host) return false;
  return domains.some((d) => {
    const entry = String(d).toLowerCase();
    if (entry.startsWith('.')) {
      return host === entry.slice(1) || host.endsWith(entry);
    }
    return host === entry;
  });
}

function corsHeaders(req, allowAnyOrigin) {
  const origin = req.headers.origin;
  if (!origin) return {};
  return {
    'Access-Control-Allow-Origin': allowAnyOrigin ? origin : origin,
    'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
    'Access-Control-Allow-Headers': 'Content-Type, X-Widget-Key, X-Edit-Pin',
    Vary: 'Origin',
  };
}

// ------------------------------------------------------------ auth

async function tenantByKey(key) {
  if (!key || typeof key !== 'string') return null;
  const res = await db.query(
    `SELECT wk.tenant_id, tc.system_prompt, tc.context_text, tc.currency,
            tc.pack, t.name AS business_name
       FROM widget_keys wk
       JOIN tenant_config tc ON tc.tenant_id = wk.tenant_id
       JOIN tenants t ON t.id = wk.tenant_id
      WHERE wk.key = $1 AND wk.active`,
    [key]
  );
  return res.rows[0] || null;
}

/** Widget routes: key + allowed domain, or refuse. Returns tenant or null
 * (and sends the error itself). */
async function widgetAuth(req, res) {
  const key = req.headers['x-widget-key'];
  const tenant = await tenantByKey(key);
  if (!tenant) {
    fail(res, 403, 'invalid_key', 'Unknown widget key.');
    return null;
  }
  const host = requestHost(req);
  if (!tenant.pack || !tenant.pack.widget) {
    fail(res, 403, 'widget_not_configured', 'This business has no widget configuration.');
    return null;
  }
  if (!domainAllowed(tenant.pack, host)) {
    fail(res, 403, 'domain_not_allowed', `This widget is not allowed on ${host || 'an unknown domain'}.`);
    return null;
  }
  tenant._cors = corsHeaders(req);
  return tenant;
}

function pinOk(req, body) {
  const expected = process.env.DEMO_EDIT_PIN || '';
  if (!expected) return false;
  const given =
    req.headers['x-edit-pin'] ||
    (body && body.pin) ||
    new URL(req.url, 'http://x').searchParams.get('pin') ||
    '';
  const a = Buffer.from(String(given));
  const b = Buffer.from(expected);
  return a.length === b.length && crypto.timingSafeEqual(a, b);
}

// ------------------------------------------------------------ leads + events

const PHONE_RE = /(\+?\d[\d\s().-]{7,}\d)/;
const EMAIL_RE = /([A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,})/;

function normalisePhone(raw) {
  if (!raw) return '';
  const digits = String(raw).replace(/[^\d+]/g, '');
  return digits.length >= 7 ? digits : '';
}

async function registerEvent(tenantId, entityType, entityId, eventType, summary, payload) {
  await db.query(
    `INSERT INTO register_events (tenant_id, entity_type, entity_id, event_type, summary, payload)
     VALUES ($1, $2, $3, $4, $5, $6)`,
    [
      tenantId,
      entityType,
      String(entityId),
      eventType,
      summary,
      JSON.stringify({ actor: 'website-agent', ...(payload || {}) }),
    ]
  );
}

async function captureLead(tenant, conversation, parsedLead, visitorText) {
  const lead = { ...(parsedLead || {}) };
  if (!lead.phone) {
    const m = String(visitorText || '').match(PHONE_RE);
    if (m) lead.phone = m[1];
  }
  if (!lead.email) {
    const m = String(visitorText || '').match(EMAIL_RE);
    if (m) lead.email = m[1];
  }
  const phone = normalisePhone(lead.phone);
  const email = lead.email ? String(lead.email).trim().slice(0, 200) : '';
  if (!phone && !email) return null;

  const name = (lead.name || conversation.visitor_name || '').toString().slice(0, 200);
  let need = (lead.need || '').toString().slice(0, 900);
  // The leads table has no email column; the address rides in the need
  // text so the owner can still see and use it.
  if (email) need = `${need}${need ? ' ' : ''}(Email: ${email})`.slice(0, 1000);

  // The engine keys a lead by (tenant_id, customer_id): one lead per
  // customer identity, refreshed as more is learned.
  const res = await db.query(
    `INSERT INTO leads (tenant_id, customer_id, name, phone, need, status, source_channel)
     VALUES ($1, $2, $3, $4, $5, 'new', 'website')
     ON CONFLICT (tenant_id, customer_id) DO UPDATE
       SET name = CASE WHEN EXCLUDED.name <> '' THEN EXCLUDED.name ELSE leads.name END,
           phone = COALESCE(EXCLUDED.phone, leads.phone),
           need = CASE WHEN EXCLUDED.need <> '' THEN EXCLUDED.need ELSE leads.need END,
           last_seen_at = now(), updated_at = now()
     RETURNING id, (xmax = 0) AS inserted`,
    [tenant.tenant_id, conversation.customer_id, name, phone || null, need]
  );
  const row = res.rows[0];
  await db.query('UPDATE conversations SET lead_id = $2 WHERE id = $1', [
    conversation.id,
    row.id,
  ]);
  if (row.inserted) {
    await registerEvent(
      tenant.tenant_id,
      'lead',
      row.id,
      'lead_captured',
      `Lead captured from the website chat: ${name || 'unnamed visitor'}${phone ? `, ${phone}` : ''}`,
      { channel: 'website', conversation_id: conversation.id }
    );
  }
  return row;
}

// ------------------------------------------------------------ routes

async function handleWidgetConfig(req, res) {
  const tenant = await widgetAuth(req, res);
  if (!tenant) return;
  const w = tenant.pack.widget || {};
  sendJson(
    res,
    200,
    {
      tenant_id: tenant.tenant_id,
      business_name: tenant.business_name,
      greeting: w.greeting || `Hi, this is ${tenant.business_name}. How can I help?`,
      primary_color: w.primary_color || '#333333',
      logo_url: w.logo_url || null,
      position: w.position || 'bottom-right',
    },
    tenant._cors
  );
}

async function handleSession(req, res) {
  const tenant = await widgetAuth(req, res);
  if (!tenant) return;
  const body = await readBody(req);
  const packet = ctx.sanitisePacket(body.packet);
  const token = crypto.randomBytes(24).toString('hex');
  const customerId = 'web-' + token.slice(0, 16);
  const visitorName = packet.visitor ? packet.visitor.name : null;
  const ins = await db.query(
    `INSERT INTO conversations
       (tenant_id, channel, session_id, customer_id, status, live_packet, visitor_name)
     VALUES ($1, 'website', $2, $3, 'open', $4, $5)
     RETURNING id`,
    [tenant.tenant_id, token, customerId, JSON.stringify(packet), visitorName]
  );
  await registerEvent(
    tenant.tenant_id,
    'conversation',
    ins.rows[0].id,
    'session_started',
    `Website chat started${packet.page && packet.page.title ? `: ${packet.page.title}` : ''}`,
    { channel: 'website', page: packet.page || null }
  );
  const w = tenant.pack.widget || {};
  sendJson(
    res,
    200,
    {
      session_token: token,
      business_name: tenant.business_name,
      greeting: w.greeting || `Hi, this is ${tenant.business_name}. How can I help?`,
      handed_over: false,
    },
    tenant._cors
  );
}

async function handleChat(req, res) {
  const tenant = await widgetAuth(req, res);
  if (!tenant) return;
  const body = await readBody(req);
  const text = typeof body.text === 'string' ? body.text.trim().slice(0, 4000) : '';
  if (!text) return fail(res, 400, 'empty_message', 'The message is empty.');
  if (!body.session_token) return fail(res, 400, 'missing_session', 'No session token.');

  const convRes = await db.query(
    `SELECT id, customer_id, status, live_packet, summary, visitor_name
       FROM conversations
      WHERE tenant_id = $1 AND channel = 'website' AND session_id = $2`,
    [tenant.tenant_id, String(body.session_token)]
  );
  if (!convRes.rows.length) return fail(res, 404, 'session_not_found', 'Unknown session.');
  const conversation = convRes.rows[0];

  // Latest packet wins, field by field.
  const incoming = ctx.sanitisePacket(body.packet);
  const packet = { ...(conversation.live_packet || {}), ...incoming };
  if (incoming.page) packet.page = incoming.page;
  if (packet.visitor && packet.visitor.name && !conversation.visitor_name) {
    conversation.visitor_name = packet.visitor.name;
  }
  await db.query(
    'UPDATE conversations SET live_packet = $2, visitor_name = COALESCE(visitor_name, $3) WHERE id = $1',
    [conversation.id, JSON.stringify(packet), conversation.visitor_name]
  );

  // The visitor's message is saved first, as the engine has always done.
  await db.query(
    `INSERT INTO messages (conversation_id, tenant_id, direction, sender, body)
     VALUES ($1, $2, 'in', 'customer', $3)`,
    [conversation.id, tenant.tenant_id, text]
  );

  if (conversation.status === 'handed_over') {
    return sendJson(res, 200, { reply_text: null, handed_over: true }, tenant._cors);
  }

  // History: the last HISTORY_MESSAGES messages, in order (see config.js).
  const totalRes = await db.query(
    'SELECT count(*)::int AS n FROM messages WHERE conversation_id = $1',
    [conversation.id]
  );
  const total = totalRes.rows[0].n;
  const histRes = await db.query(
    `SELECT sender, body FROM messages
      WHERE conversation_id = $1 ORDER BY id DESC LIMIT $2`,
    [conversation.id, config.HISTORY_MESSAGES]
  );
  const history = histRes.rows.reverse();
  const contents = history.map((m) => ({
    role: m.sender === 'customer' ? 'user' : 'model',
    text: m.body,
  }));
  const hasOlder = total > history.length;

  // FAQ lookup over this message and the previous visitor message.
  const prevVisitor = [...history]
    .slice(0, -1)
    .reverse()
    .find((m) => m.sender === 'customer');
  const faqMatches = ctx.lookupFaqs(
    tenant.pack,
    `${text} ${prevVisitor ? prevVisitor.body : ''}`
  );

  const system = ctx.buildSystemPrompt({
    tenant,
    pack: tenant.pack,
    packet,
    faqMatches,
    summary: hasOlder ? conversation.summary : null,
  });

  let parsed = null;
  let rawText = '';
  try {
    rawText = await model.generate({ system, contents });
    parsed = model.parseAgentJson(rawText);
  } catch (err) {
    console.error('model call failed:', err.message);
  }
  if (!parsed || typeof parsed.reply_text !== 'string') {
    parsed = {
      reply_text:
        'Thanks for your message. Let me check that with the team and come back to you.',
      intent: 'handover',
      needs_human: true,
      lead: null,
      summary: conversation.summary || '',
    };
  }

  await db.query(
    `INSERT INTO messages (conversation_id, tenant_id, direction, sender, body)
     VALUES ($1, $2, 'out', 'agent', $3)`,
    [conversation.id, tenant.tenant_id, parsed.reply_text]
  );

  // Lead capture on ANY chat with contact details or clear intent.
  const leadRow = await captureLead(tenant, conversation, parsed.lead, text);

  // Rolling summary of everything before the window.
  if (typeof parsed.summary === 'string' && parsed.summary.trim()) {
    await db.query('UPDATE conversations SET summary = $2 WHERE id = $1', [
      conversation.id,
      parsed.summary.trim().slice(0, config.SUMMARY_MAX_CHARS),
    ]);
  }

  let handedOver = false;
  if (parsed.needs_human === true || parsed.intent === 'handover') {
    handedOver = true;
    await db.query(
      "UPDATE conversations SET status = 'handed_over' WHERE id = $1",
      [conversation.id]
    );
    await registerEvent(
      tenant.tenant_id,
      'conversation',
      conversation.id,
      'handover_flagged',
      'Website chat flagged for the owner; the assistant has stopped replying',
      {
        channel: 'website',
        intent: parsed.intent || 'question',
        lead_id: leadRow ? leadRow.id : null,
      }
    );
  }

  sendJson(
    res,
    200,
    { reply_text: parsed.reply_text, handed_over: handedOver, lead_captured: !!leadRow },
    tenant._cors
  );
}

// ------------------------------------------------------------ owner context routes

async function handleContextGet(req, res) {
  const url = new URL(req.url, 'http://x');
  const key = req.headers['x-widget-key'] || url.searchParams.get('key');
  const tenant = await tenantByKey(key);
  if (!tenant) return fail(res, 403, 'invalid_key', 'Unknown widget key.');
  if (!pinOk(req, null)) return fail(res, 403, 'invalid_pin', 'The edit PIN is wrong.');
  const row = await db.query(
    'SELECT context_text, context_updated_at FROM tenant_config WHERE tenant_id = $1',
    [tenant.tenant_id]
  );
  sendJson(
    res,
    200,
    {
      tenant_id: tenant.tenant_id,
      business_name: tenant.business_name,
      context_text: row.rows[0].context_text || '',
      context_updated_at: row.rows[0].context_updated_at,
    },
    corsHeaders(req, true)
  );
}

async function handleContextSave(req, res) {
  const body = await readBody(req, 262144);
  const key = req.headers['x-widget-key'] || body.key;
  const tenant = await tenantByKey(key);
  if (!tenant) return fail(res, 403, 'invalid_key', 'Unknown widget key.');
  if (!pinOk(req, body)) return fail(res, 403, 'invalid_pin', 'The edit PIN is wrong.');
  const text = typeof body.context_text === 'string' ? body.context_text : '';
  if (!text.trim() || text.length > 120000) {
    return fail(res, 400, 'bad_context', 'Context text is empty or too large.');
  }
  // The context document is the business's live brain for BOTH doors:
  // the website service reads context_text, the n8n side reads
  // system_prompt, so a save updates both copies of the same document.
  const upd = await db.query(
    `UPDATE tenant_config
        SET context_text = $2, system_prompt = $2, context_updated_at = now()
      WHERE tenant_id = $1
      RETURNING context_updated_at`,
    [tenant.tenant_id, text]
  );
  sendJson(res, 200, { ok: true, context_updated_at: upd.rows[0].context_updated_at }, corsHeaders(req, true));
}

/** Re-read the business's own website and refresh the AUTO block of
 * its context document. Key + PIN, like the other owner routes. */
async function handleContextAuto(req, res) {
  const body = await readBody(req);
  const key = req.headers['x-widget-key'] || body.key;
  const tenant = await tenantByKey(key);
  if (!tenant) return fail(res, 403, 'invalid_key', 'Unknown widget key.');
  if (!pinOk(req, body)) return fail(res, 403, 'invalid_pin', 'The edit PIN is wrong.');
  const result = await autofetch.refreshTenantContext(tenant.tenant_id);
  if (!result) {
    return fail(
      res,
      422,
      'no_site',
      'No readable website is configured for this business (set business.website in its pack, or an allowed domain that is the business site).'
    );
  }
  sendJson(res, 200, result, corsHeaders(req, true));
}

/** The one context page per business: /context/<tenant_id>. Shows the
 * install snippet and, after the PIN, the context editor. */
async function handleContextPage(req, res, tenantId) {
  const row = await db.query(
    `SELECT t.name AS business_name, wk.key AS widget_key
       FROM tenants t
       JOIN widget_keys wk ON wk.tenant_id = t.id AND wk.active
      WHERE t.id = $1
      ORDER BY wk.created_at
      LIMIT 1`,
    [tenantId]
  );
  res.writeHead(row.rows.length ? 200 : 404, {
    'Content-Type': 'text/html; charset=utf-8',
    'Cache-Control': 'no-store',
  });
  if (!row.rows.length) return res.end(renderNotFound(tenantId));
  return res.end(
    renderContextPage({
      tenantId,
      businessName: row.rows[0].business_name,
      widgetKey: row.rows[0].widget_key,
      snippet: snippetFor(row.rows[0].widget_key),
    })
  );
}

function slugify(name) {
  return String(name || '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 48);
}

async function handleContextCreate(req, res) {
  const body = await readBody(req);
  if (!pinOk(req, body)) return fail(res, 403, 'invalid_pin', 'The edit PIN is wrong.');
  const name = typeof body.name === 'string' ? body.name.trim().slice(0, 120) : '';
  if (!name) return fail(res, 400, 'missing_name', 'Give the business a name.');
  let slug = slugify(name) || 'business';
  const taken = await db.query('SELECT 1 FROM tenants WHERE id = $1', [slug]);
  if (taken.rows.length) slug = `${slug}-${crypto.randomBytes(2).toString('hex')}`;

  const domains = Array.isArray(body.allowed_domains) && body.allowed_domains.length
    ? body.allowed_domains.map((d) => String(d).slice(0, 120))
    : ['demos.zeliks.tech', '.zeliks-demos.pages.dev', '.zeliks-demos-git.pages.dev'];

  const pack = {
    tenant_id: slug,
    pack_version: 2,
    business: { name, type: 'business', area: 'Edit the context to set this', timezone: 'UTC' },
    currency: 'USD',
    services: [
      {
        id: 'general-enquiry',
        name: 'General enquiry',
        price: 0,
        duration_minutes: 30,
        description: 'A placeholder. The real services live in the context text.',
      },
    ],
    hours: {
      weekly: {
        mon: { open: '09:00', close: '17:00' },
        tue: { open: '09:00', close: '17:00' },
        wed: { open: '09:00', close: '17:00' },
        thu: { open: '09:00', close: '17:00' },
        fri: { open: '09:00', close: '17:00' },
        sat: null,
        sun: null,
      },
    },
    faqs: [],
    policies: {},
    tools: {
      answer: true,
      lead_capture: true,
      booking: false,
      follow_up: false,
      owner_alert: true,
      evening_summary: false,
    },
    owner_alerts: { channel: 'none', target: '' },
    languages: { supported: ['English'], default: 'English' },
    role_card: {
      goal: `Answer questions about ${name} from the context text, and capture the details of anyone who wants the business to get back to them.`,
      qualification_questions: [
        'What are you interested in?',
        'What is the best phone number or email for us to reach you?',
      ],
      handover_rules: ['The visitor asks to speak to a human', 'You cannot answer from the context given'],
    },
    rules: ['Never invent facts that are not in the context text.'],
    widget: {
      greeting: `Hi, this is ${name}. Ask me anything about us.`,
      primary_color: '#333333',
      position: 'bottom-right',
      allowed_domains: domains,
    },
    owner: { name: '', alert_channel: 'none', alert_target: '' },
  };

  const contextText = [
    `You are the front desk assistant for ${name}.`,
    '',
    '# About the business',
    '',
    '(Edit this document on the context page. Everything the assistant knows comes from this text: describe the business, its services and prices, opening hours, policies, and anything customers ask about. Save, then start a fresh chat: the assistant answers from the new text straight away.)',
    '',
    '## What we do',
    '',
    'To be written.',
    '',
    '## Services and prices',
    '',
    'To be written.',
    '',
    '## Opening hours',
    '',
    'To be written.',
    '',
    '## Tone',
    '',
    'Friendly, plain and brief.',
    '',
  ].join('\n');

  const client = await db.connect();
  try {
    await client.query('BEGIN');
    const result = await upsertBusiness(client, {
      pack,
      packFile: `${slug}.json`,
      systemPrompt: contextText,
      contextText,
      resetContext: true,
    });
    await client.query('COMMIT');
    sendJson(
      res,
      200,
      {
        tenant_id: result.tenant_id,
        widget_key: result.widget_key,
        snippet: snippetFor(result.widget_key),
      },
      corsHeaders(req, true)
    );
  } catch (err) {
    await client.query('ROLLBACK');
    throw err;
  } finally {
    client.release();
  }
}

// ------------------------------------------------------------ server

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, 'http://x');
  const pathname = url.pathname;
  try {
    if (req.method === 'OPTIONS' && pathname.startsWith('/api/')) {
      res.writeHead(204, corsHeaders(req, true));
      return res.end();
    }
    if (req.method === 'GET' && pathname === '/healthz') {
      return sendJson(res, 200, { ok: true, service: 'zeliks-website-agent' });
    }
    if (req.method === 'GET' && pathname === '/') {
      return sendJson(res, 200, { ok: true, service: 'zeliks-website-agent' });
    }
    if (req.method === 'GET' && pathname === '/widget.js') {
      res.writeHead(200, {
        'Content-Type': 'text/javascript; charset=utf-8',
        'Cache-Control': 'public, max-age=300',
      });
      return res.end(WIDGET_JS);
    }
    const demoMatch = pathname.match(/^\/demo\/(salon|estate|context|zeliks)\/?$/);
    if (req.method === 'GET' && demoMatch) {
      const html = DEMO_PAGES[demoMatch[1]];
      if (!html) return fail(res, 404, 'not_found', 'Demo page not bundled.');
      res.writeHead(200, {
        'Content-Type': 'text/html; charset=utf-8',
        'Cache-Control': 'no-store',
      });
      return res.end(html);
    }
    if (req.method === 'GET' && pathname === '/api/widget-config') {
      return await handleWidgetConfig(req, res);
    }
    if (req.method === 'POST' && pathname === '/api/session') {
      return await handleSession(req, res);
    }
    if (req.method === 'POST' && pathname === '/api/chat') {
      return await handleChat(req, res);
    }
    if (req.method === 'GET' && pathname === '/api/context') {
      return await handleContextGet(req, res);
    }
    if (req.method === 'POST' && pathname === '/api/context') {
      return await handleContextSave(req, res);
    }
    if (req.method === 'POST' && pathname === '/api/context/auto') {
      return await handleContextAuto(req, res);
    }
    const contextPageMatch = pathname.match(/^\/context\/([a-z0-9][a-z0-9-]*)\/?$/);
    if (req.method === 'GET' && contextPageMatch) {
      return await handleContextPage(req, res, contextPageMatch[1]);
    }
    if (req.method === 'POST' && pathname === '/api/context/create') {
      return await handleContextCreate(req, res);
    }
    return fail(res, 404, 'not_found', 'No such route.');
  } catch (err) {
    console.error('request failed:', pathname, err.message);
    if (!res.headersSent) fail(res, 500, 'server_error', 'Something went wrong.');
  }
});

server.listen(config.PORT, () => {
  console.log(
    `zeliks-website-agent listening on ${config.PORT} ` +
      `(provider=${config.MODEL_PROVIDER}, history=${config.HISTORY_MESSAGES})`
  );
});
