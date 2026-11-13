'use strict';
/*
 * One business in, everything written, one transaction:
 *   tenants row + tenant_config row (full pack jsonb, compiled prompt,
 *   services map, context document) + an active widget key.
 * Used by tools/load_pack.js (one file onboarding) and by the context
 * page's "create a blank business" endpoint.
 */
const crypto = require('crypto');

const PRICE_FORMATS = { USD: '$', GBP: '£', EUR: '€', OMR: 'OMR ' };

function servicesMap(pack) {
  const map = {};
  for (const s of pack.services || []) {
    map[s.id] = { name: s.name, price: s.price };
  }
  return map;
}

function newWidgetKey() {
  return 'wk_' + crypto.randomBytes(16).toString('hex');
}

/**
 * client: a pg client inside a transaction.
 * opts: { pack, packFile, systemPrompt, contextText, resetContext }
 * Returns { tenant_id, widget_key, key_created, context_preserved }.
 *
 * context_text is the business's live context document (what the website
 * assistant reads). On a re-load it is PRESERVED if the owner has edited
 * it on the context page, unless resetContext is set: the pack is the
 * onboarding source, the context page is the live editor, and a reload
 * must never silently wipe the owner's edits.
 */
async function upsertBusiness(client, opts) {
  const { pack, systemPrompt } = opts;
  const tenantId = pack.tenant_id;
  const packVersion = pack.pack_version || 1;

  await client.query(
    `INSERT INTO tenants (id, name, pack_file, timezone)
     VALUES ($1, $2, $3, $4)
     ON CONFLICT (id) DO UPDATE
       SET name = EXCLUDED.name, pack_file = EXCLUDED.pack_file,
           timezone = EXCLUDED.timezone`,
    [
      tenantId,
      pack.business.name,
      opts.packFile || `${tenantId}.json`,
      pack.business.timezone,
    ]
  );

  const existing = await client.query(
    'SELECT context_text FROM tenant_config WHERE tenant_id = $1 FOR UPDATE',
    [tenantId]
  );
  const hadContext =
    existing.rows.length > 0 && existing.rows[0].context_text != null;
  const incomingContext = opts.contextText || systemPrompt;
  const contextPreserved = hadContext && !opts.resetContext;
  const contextText = contextPreserved
    ? existing.rows[0].context_text
    : incomingContext;

  await client.query(
    `INSERT INTO tenant_config
       (tenant_id, system_prompt, services, timezone, currency, price_format,
        pack, pack_version, context_text, context_updated_at)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, now())
     ON CONFLICT (tenant_id) DO UPDATE
       SET system_prompt = EXCLUDED.system_prompt,
           services = EXCLUDED.services,
           timezone = EXCLUDED.timezone,
           currency = EXCLUDED.currency,
           price_format = EXCLUDED.price_format,
           pack = EXCLUDED.pack,
           pack_version = EXCLUDED.pack_version,
           context_text = EXCLUDED.context_text,
           context_updated_at = CASE
             WHEN tenant_config.context_text IS DISTINCT FROM EXCLUDED.context_text
             THEN now() ELSE tenant_config.context_updated_at END`,
    [
      tenantId,
      systemPrompt,
      JSON.stringify(servicesMap(pack)),
      pack.business.timezone,
      pack.currency,
      PRICE_FORMATS[pack.currency] || `${pack.currency} `,
      JSON.stringify(pack),
      packVersion,
      contextText,
    ]
  );

  const keyRes = await client.query(
    'SELECT key FROM widget_keys WHERE tenant_id = $1 AND active ORDER BY created_at LIMIT 1',
    [tenantId]
  );
  let widgetKey;
  let keyCreated = false;
  if (keyRes.rows.length) {
    widgetKey = keyRes.rows[0].key;
  } else {
    widgetKey = newWidgetKey();
    await client.query(
      'INSERT INTO widget_keys (key, tenant_id) VALUES ($1, $2)',
      [widgetKey, tenantId]
    );
    keyCreated = true;
  }

  return { tenant_id: tenantId, widget_key: widgetKey, key_created: keyCreated, context_preserved: contextPreserved };
}

function snippetFor(widgetKey) {
  const base = require('../config').PUBLIC_BASE_URL.replace(/\/$/, '');
  return `<script src="${base}/widget.js" data-zeliks-key="${widgetKey}" async></script>`;
}

module.exports = { upsertBusiness, servicesMap, newWidgetKey, snippetFor };
