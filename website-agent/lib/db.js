'use strict';
/* Postgres access: the same Neon database the engine already uses.
 * Tenant separation is the engine's own rule: every row carries tenant_id
 * and every query in this service filters on it.
 *
 * One environment quirk, handled here: the VPS container networks have no
 * IPv6 route, and Node's default DNS order hands back the Neon hostname's
 * AAAA record first, which makes plain connects fail with ENETUNREACH.
 * So the hostname is resolved to its IPv4 address explicitly, and the
 * original hostname is kept as the TLS server name (Neon routes on SNI).
 * Re-resolution happens on container start. */
const dns = require('dns');
const { Pool } = require('pg');

const rawUrl = process.env.DATABASE_URL;
if (!rawUrl) throw new Error('DATABASE_URL is not set');
const parsed = new URL(rawUrl);
const useSsl =
  /neon\.tech/.test(rawUrl) || /sslmode=require/.test(rawUrl);

let poolPromise = null;

async function getPool() {
  if (!poolPromise) {
    poolPromise = (async () => {
      let host = parsed.hostname;
      const ssl = useSsl ? { rejectUnauthorized: false } : undefined;
      try {
        const { address } = await dns.promises.lookup(host, { family: 4 });
        host = address;
        if (ssl) ssl.servername = parsed.hostname;
      } catch (_) {
        /* fall back to the hostname and let pg try */
      }
      return new Pool({
        host,
        port: Number(parsed.port || 5432),
        user: decodeURIComponent(parsed.username),
        password: decodeURIComponent(parsed.password),
        database: parsed.pathname.replace(/^\//, ''),
        ssl,
        max: 5,
      });
    })();
  }
  return poolPromise;
}

module.exports = {
  query: async (text, params) => (await getPool()).query(text, params),
  connect: async () => (await getPool()).connect(),
  end: async () => {
    if (poolPromise) await (await poolPromise).end();
  },
};
