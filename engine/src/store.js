'use strict';
// Every SQL statement lives here. Two round trips per chat turn: load, then save.

const { Pool } = require('pg');
const config = require('./config');

let pool = null;
function db() {
  if (!pool) pool = new Pool({ connectionString: config.databaseUrl, max: 10 });
  return pool;
}
function useClient(client) {
  pool = client; // tests pass an in-memory database
}

// ---- businesses (cached: they change rarely and are read on every message)
const cache = new Map();

async function getBusiness(id) {
  const hit = cache.get(id);
  if (hit && Date.now() - hit.at < config.businessCacheMs) return hit.value;
  const r = await db().query('SELECT * FROM businesses WHERE id = $1 AND active', [id]);
  const value = r.rows[0] || null;
  cache.set(id, { at: Date.now(), value });
  return value;
}

async function findChannel(kind, externalId) {
  const r = await db().query(
    'SELECT * FROM channels WHERE kind = $1 AND external_id = $2 AND active',
    [kind, externalId]
  );
  return r.rows[0] || null;
}

async function saveBusiness({ id, name, timezone, facts, settings }) {
  const r = await db().query(
    `INSERT INTO businesses (id, name, timezone, facts, settings)
     VALUES ($1, COALESCE($2, (SELECT name FROM businesses WHERE id = $1)),
             COALESCE($3, 'Asia/Muscat'), COALESCE($4, ''), COALESCE($5, '{}'::jsonb))
     ON CONFLICT (id) DO UPDATE SET
       name = COALESCE($2, businesses.name),
       timezone = COALESCE($3, businesses.timezone),
       facts = COALESCE($4, businesses.facts),
       settings = businesses.settings || COALESCE($5, '{}'::jsonb),
       updated_at = now()
     RETURNING *`,
    [id, name, timezone, facts, settings ? JSON.stringify(settings) : null]
  );
  cache.delete(id);
  return r.rows[0];
}

async function addChannel({ businessId, kind, externalId, credentials }) {
  const r = await db().query(
    `INSERT INTO channels (business_id, kind, external_id, credentials)
     VALUES ($1, $2, $3, $4)
     ON CONFLICT (kind, external_id) DO UPDATE SET
       business_id = $1, credentials = $4, active = true
     RETURNING id, business_id, kind, external_id`,
    [businessId, kind, externalId, JSON.stringify(credentials || {})]
  );
  return r.rows[0];
}

// ---- one chat turn

// Upserts the conversation, stores the incoming message, and returns the
// conversation plus recent history, in one statement.
async function startTurn({ businessId, channel, contactId, text, page }) {
  const r = await db().query(
    `WITH conv AS (
       INSERT INTO conversations (business_id, channel, contact_id, page)
       VALUES ($1, $2, $3, $5)
       ON CONFLICT (business_id, channel, contact_id) DO UPDATE SET
         page = COALESCE($5, conversations.page),
         status = CASE WHEN conversations.status = 'closed' THEN 'open' ELSE conversations.status END,
         last_message_at = now()
       RETURNING *
     ),
     msg AS (
       INSERT INTO messages (conversation_id, role, body)
       SELECT id, 'user', $4 FROM conv
       RETURNING id
     )
     SELECT conv.*,
       (SELECT coalesce(json_agg(h ORDER BY h.id), '[]') FROM (
          SELECT m.id, m.role, m.body FROM messages m
          WHERE m.conversation_id = conv.id ORDER BY m.id DESC LIMIT $6
        ) h) AS history,
       (SELECT count(*) FROM messages m WHERE m.conversation_id = conv.id)::int AS total_messages
     FROM conv`,
    [businessId, channel, contactId, text, page ? JSON.stringify(page) : null, config.historyMessages - 1]
  );
  const row = r.rows[0];
  // The just-inserted message is not visible to the subquery, so add it here.
  row.history = [...row.history, { role: 'user', body: text }];
  return row;
}

// Stores the reply and everything the model learned, in one statement.
async function finishTurn({ conversation, reply, summary, lead, handover, alerted }) {
  await db().query(
    `WITH m AS (
       INSERT INTO messages (conversation_id, role, body) VALUES ($1, 'assistant', $2)
     ),
     c AS (
       UPDATE conversations SET
         summary = COALESCE($3, summary),
         status = CASE WHEN $4 THEN 'handed_over' ELSE status END,
         alerted_at = CASE WHEN $13 THEN now() ELSE alerted_at END
       WHERE id = $1
     ),
     l AS (
       INSERT INTO leads (business_id, conversation_id, name, phone, need, email, company)
       SELECT $5, $1, $6, $7, $8, $11, $12 WHERE $9
       ON CONFLICT (conversation_id) DO UPDATE SET
         name = COALESCE(EXCLUDED.name, leads.name),
         phone = COALESCE(EXCLUDED.phone, leads.phone),
         need = COALESCE(EXCLUDED.need, leads.need),
         email = COALESCE(EXCLUDED.email, leads.email),
         company = COALESCE(EXCLUDED.company, leads.company),
         updated_at = now()
     )
     INSERT INTO events (business_id, kind, ref, payload)
     SELECT $5, 'handover', $1::text, $10 WHERE $4`,
    [
      conversation.id,
      reply,
      summary || null,
      !!handover,
      conversation.business_id,
      lead?.name || null,
      lead?.phone || null,
      lead?.need || null,
      !!(lead && (lead.name || lead.phone || lead.need || lead.email || lead.company)),
      JSON.stringify({ channel: conversation.channel, contact: conversation.contact_id }),
      lead?.email || null,
      lead?.company || null,
      !!alerted,
    ]
  );
}

async function logEvent(businessId, kind, ref, payload) {
  await db().query(
    'INSERT INTO events (business_id, kind, ref, payload) VALUES ($1, $2, $3, $4)',
    [businessId, kind, ref || null, JSON.stringify(payload || {})]
  );
}

async function getConversation(businessId, channel, contactId) {
  const r = await db().query(
    'SELECT * FROM conversations WHERE business_id = $1 AND channel = $2 AND contact_id = $3',
    [businessId, channel, contactId]
  );
  return r.rows[0] || null;
}

module.exports = {
  db, useClient, getBusiness, findChannel, saveBusiness, addChannel,
  startTurn, finishTurn, logEvent, getConversation,
};
