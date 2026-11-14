'use strict';
// Zeliks Engine: one service, many businesses, every channel.

const fs = require('fs');
const path = require('path');
const http = require('http');
const config = require('./config');
const { send } = require('./http');
const doors = [require('./doors/web'), require('./doors/meta'), require('./doors/telegram'), require('./admin')];

const WIDGET_JS = fs.readFileSync(path.join(__dirname, '..', 'public', 'widget.js'));
const PREVIEW = fs.readFileSync(path.join(__dirname, '..', 'public', 'preview.html'));

async function handler(req, res) {
  const url = new URL(req.url, 'http://local');
  const p = url.pathname.replace(/\/+$/, '') || '/';
  try {
    if (req.method === 'GET' && p === '/healthz') return send(res, 200, { ok: true });
    if (req.method === 'GET' && p === '/widget.js') {
      res.writeHead(200, { 'Content-Type': 'text/javascript; charset=utf-8', 'Cache-Control': 'public, max-age=300' });
      return res.end(WIDGET_JS);
    }
    if (req.method === 'GET' && p === '/preview') {
      res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-store' });
      return res.end(PREVIEW);
    }
    for (const door of doors) {
      if (await door.route(req, res, p, url)) return;
    }
    send(res, 404, { error: 'not_found' });
  } catch (err) {
    console.error(`${req.method} ${p}: ${err.message}`);
    if (!res.headersSent) send(res, err.status || 500, { error: err.status ? err.message : 'server_error' });
  }
}

if (require.main === module) {
  http.createServer(handler).listen(config.port, () => console.log(`engine listening on ${config.port}`));
}

module.exports = { handler };
