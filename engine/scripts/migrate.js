'use strict';
// Creates or updates the tables. Safe to run again.
const fs = require('fs');
const path = require('path');
const store = require('../src/store');

(async () => {
  await store.db().query(fs.readFileSync(path.join(__dirname, '..', 'db', 'schema.sql'), 'utf8'));
  console.log('schema ready');
  await store.db().end();
})().catch((e) => { console.error(e.message); process.exit(1); });
