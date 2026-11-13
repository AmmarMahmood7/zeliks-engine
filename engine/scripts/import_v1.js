'use strict';
// One-off: copies businesses and widget keys from the v1 database (OLD_DATABASE_URL)
// into v2. Old chats stay in v1 as an archive. Test businesses are skipped.
const { Client } = require('pg');
const store = require('../src/store');

const SKIP = /test|ghost/i;

(async () => {
  const old = new Client({ connectionString: process.env.OLD_DATABASE_URL });
  await old.connect();
  const { rows } = await old.query(
    `SELECT t.id, t.name, t.timezone, tc.context_text, tc.pack
     FROM tenants t JOIN tenant_config tc ON tc.tenant_id = t.id
     WHERE tc.context_text IS NOT NULL`
  );
  for (const t of rows) {
    if (SKIP.test(t.id)) { console.log('skip', t.id); continue; }
    const w = t.pack?.widget || {};
    await store.saveBusiness({
      id: t.id, name: t.name, timezone: t.pack?.business?.timezone || t.timezone, facts: t.context_text,
      settings: { allowed_domains: w.allowed_domains || [], greeting: w.greeting, primary_color: w.primary_color, logo_url: w.logo_url, position: w.position },
    });
    const keys = await old.query('SELECT key FROM widget_keys WHERE tenant_id = $1 AND active', [t.id]);
    for (const k of keys.rows) await store.addChannel({ businessId: t.id, kind: 'web', externalId: k.key });
    console.log('imported', t.id, `${keys.rows.length} widget key(s)`);
  }
  await old.end();
  await store.db().end();
})().catch((e) => { console.error(e.message); process.exit(1); });
