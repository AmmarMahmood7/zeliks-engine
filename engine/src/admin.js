'use strict';
// Owner routes, protected by ADMIN_TOKEN (sent as a Bearer token).
//   GET  /admin/businesses/:id            read a business
//   PUT  /admin/businesses/:id            create or update {name, timezone, facts, settings}
//   POST /admin/businesses/:id/channels   add a door {kind, external_id?, credentials?}
//        kind 'web' with no external_id creates a new widget key.

const crypto = require('crypto');
const config = require('./config');
const store = require('./store');
const { send, readJson } = require('./http');

function authorised(req) {
  const given = String(req.headers.authorization || '').replace(/^Bearer /, '');
  if (!config.adminToken || given.length !== config.adminToken.length) return false;
  return crypto.timingSafeEqual(Buffer.from(given), Buffer.from(config.adminToken));
}

async function route(req, res, path) {
  const m = path.match(/^\/admin\/businesses\/([a-z0-9][a-z0-9-]{1,60})(\/channels)?$/);
  if (!m) return false;
  if (!authorised(req)) return send(res, 401, { error: 'unauthorised' }), true;
  const id = m[1];

  if (!m[2] && req.method === 'GET') {
    const b = await store.getBusiness(id);
    return send(res, b ? 200 : 404, b || { error: 'not_found' }), true;
  }
  if (!m[2] && req.method === 'PUT') {
    const body = await readJson(req);
    if (!body.name && !(await store.getBusiness(id))) return send(res, 400, { error: 'name_required' }), true;
    return send(res, 200, await store.saveBusiness({ id, ...body })), true;
  }
  if (m[2] && req.method === 'POST') {
    const body = await readJson(req);
    if (!['web', 'whatsapp', 'instagram', 'telegram'].includes(body.kind)) return send(res, 400, { error: 'bad_kind' }), true;
    const externalId = body.external_id || (body.kind === 'web' ? 'wk_' + crypto.randomBytes(16).toString('hex') : null);
    if (!externalId) return send(res, 400, { error: 'external_id_required' }), true;
    const ch = await store.addChannel({ businessId: id, kind: body.kind, externalId, credentials: body.credentials });
    const snippet = body.kind === 'web'
      ? `<script src="${config.publicBaseUrl}/widget.js" data-zeliks-key="${externalId}" async></script>`
      : undefined;
    return send(res, 200, { ...ch, snippet }), true;
  }
  return false;
}

module.exports = { route };
