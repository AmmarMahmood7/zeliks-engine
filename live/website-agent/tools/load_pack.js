'use strict';
/*
 * One-file onboarding:
 *
 *   node tools/load_pack.js packs/<business>.json [--reset-context] [--no-auto]
 *
 * After the load, if the pack names the business's website, the loader
 * also reads that website and refreshes the AUTO block of the context
 * document (see lib/autofetch.js). A site that cannot be read never
 * fails the load; --no-auto skips the read.
 *
 * Validates the pack against packs/schema.json, compiles its prompt with
 * prompts/build_prompt.py, and writes EVERYTHING in one transaction:
 * the tenants row, the full pack as jsonb, the compiled prompt, the
 * services map, the live context document, and the business's widget key.
 * Then it prints the business's one-tag widget snippet.
 *
 * Re-running the loader for an existing business refreshes the pack and
 * the compiled prompt, keeps the same widget key, and PRESERVES the live
 * context document if the owner has edited it on the context page
 * (pass --reset-context to overwrite it with the freshly compiled one).
 */
const fs = require('fs');
const path = require('path');
const { execFileSync } = require('child_process');
const Ajv2020 = require('ajv/dist/2020');
const addFormats = require('ajv-formats');
const db = require('../lib/db');
const { upsertBusiness, snippetFor } = require('../lib/onboard');
const autofetch = require('../lib/autofetch');

const ENGINE_DIR = path.join(__dirname, '..', 'engine');
const SCHEMA_PATH =
  process.env.PACK_SCHEMA || path.join(ENGINE_DIR, 'packs', 'schema.json');
const BUILDER_PATH = path.join(ENGINE_DIR, 'prompts', 'build_prompt.py');

async function main() {
  const args = process.argv.slice(2);
  const resetContext = args.includes('--reset-context');
  const noAuto = args.includes('--no-auto');
  const packPath = args.find((a) => !a.startsWith('--'));
  if (!packPath) {
    console.error('usage: node tools/load_pack.js <pack.json> [--reset-context] [--no-auto]');
    process.exit(2);
  }

  const pack = JSON.parse(fs.readFileSync(packPath, 'utf8'));

  const schema = JSON.parse(fs.readFileSync(SCHEMA_PATH, 'utf8'));
  const ajv = new Ajv2020({ allErrors: true, strict: false });
  addFormats(ajv);
  const validate = ajv.compile(schema);
  if (!validate(pack)) {
    console.error('pack does not validate against the schema:');
    for (const e of validate.errors || []) {
      console.error(`  ${e.instancePath || '/'} ${e.message}`);
    }
    process.exit(1);
  }

  const tmpPrompt = path.join(
    require('os').tmpdir(),
    `prompt-${pack.tenant_id}-${Date.now()}.md`
  );
  execFileSync('python3', [BUILDER_PATH, packPath, '-o', tmpPrompt], {
    stdio: 'inherit',
  });
  const systemPrompt = fs.readFileSync(tmpPrompt, 'utf8');
  fs.unlinkSync(tmpPrompt);

  const client = await db.connect();
  try {
    await client.query('BEGIN');
    const result = await upsertBusiness(client, {
      pack,
      packFile: path.basename(packPath),
      systemPrompt,
      contextText: systemPrompt,
      resetContext,
    });
    await client.query('COMMIT');

    const domains =
      (pack.widget && pack.widget.allowed_domains) || [];
    console.log('');
    console.log(`Business loaded: ${pack.business.name} (${result.tenant_id})`);
    console.log(`Pack version: ${pack.pack_version || 1}`);
    console.log(`Widget key: ${result.key_created ? 'new key created' : 'existing key kept'}`);
    console.log(`Allowed domains: ${domains.join(', ') || '(none set)'}`);
    console.log(
      `Context document: ${result.context_preserved ? 'owner-edited version preserved' : 'set from the pack'}`
    );
    console.log('');
    console.log('One-tag widget snippet:');
    console.log(snippetFor(result.widget_key));
    console.log('');
    console.log(
      `Context page: ${require('../config').PUBLIC_BASE_URL.replace(/\/$/, '')}/context/${result.tenant_id} (edit PIN required)`
    );

    if (!noAuto) {
      try {
        const auto = await autofetch.refreshTenantContext(result.tenant_id);
        if (auto) {
          console.log(
            `Auto context: read ${auto.pages_read.length} page(s) from ${auto.site}; ` +
              `AUTO block ${auto.mode}; hours ${auto.hours_found ? 'found on the site' : 'not stated on the site'}.`
          );
        } else {
          console.log('Auto context: no readable website in the pack; skipped.');
        }
      } catch (err) {
        console.log(`Auto context: website read failed (${err.message}); load unaffected.`);
      }
    }
  } catch (err) {
    await client.query('ROLLBACK');
    console.error('load failed, nothing written:', err.message);
    process.exitCode = 1;
  } finally {
    client.release();
    await db.end();
  }
}

main();
