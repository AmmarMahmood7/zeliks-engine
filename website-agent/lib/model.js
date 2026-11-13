'use strict';
/*
 * One Gemini generateContent call, in the same JSON style as the existing
 * engine (systemInstruction + contents + generationConfig with
 * responseMimeType application/json, temperature from config).
 *
 * Two transports, one contract:
 *  - aistudio: Gemini API with the "Gemini API" API-key credential.
 *  - vertex:   Vertex AI with the engine's service-account credential.
 *    Implemented and selectable with MODEL_PROVIDER=vertex, but the Agent
 *    Platform API is disabled in that project today (Google returns 403
 *    "Agent Platform API has not been used in project ... before or it is
 *    disabled"), which is also why the old Chat Entry errors at its model
 *    step. Enable the API in the project and flip the env var to move
 *    this service onto Vertex with no code change.
 */
const crypto = require('crypto');
const fs = require('fs');
const config = require('../config');

function fetchWithTimeout(url, options) {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), config.MODEL_TIMEOUT_MS);
  return fetch(url, { ...options, signal: ctrl.signal }).finally(() =>
    clearTimeout(timer)
  );
}

let tokenCache = { token: null, expiresAt: 0 };

async function vertexAccessToken() {
  if (tokenCache.token && Date.now() < tokenCache.expiresAt) {
    return tokenCache.token;
  }
  const saPath = process.env.GOOGLE_APPLICATION_CREDENTIALS;
  if (!saPath) throw new Error('GOOGLE_APPLICATION_CREDENTIALS is not set');
  const sa = JSON.parse(fs.readFileSync(saPath, 'utf8'));
  const now = Math.floor(Date.now() / 1000);
  const header = Buffer.from(
    JSON.stringify({ alg: 'RS256', typ: 'JWT' })
  ).toString('base64url');
  const claim = Buffer.from(
    JSON.stringify({
      iss: sa.client_email,
      scope: 'https://www.googleapis.com/auth/cloud-platform',
      aud: 'https://oauth2.googleapis.com/token',
      iat: now,
      exp: now + 3600,
    })
  ).toString('base64url');
  const signer = crypto.createSign('RSA-SHA256');
  signer.update(`${header}.${claim}`);
  const signature = signer
    .sign(sa.private_key)
    .toString('base64url');
  const jwt = `${header}.${claim}.${signature}`;
  const res = await fetchWithTimeout('https://oauth2.googleapis.com/token', {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      grant_type: 'urn:ietf:params:oauth:grant-type:jwt-bearer',
      assertion: jwt,
    }),
  });
  const data = await res.json();
  if (!res.ok || !data.access_token) {
    throw new Error(
      `Vertex token request failed (${res.status}): ${JSON.stringify(data).slice(0, 300)}`
    );
  }
  tokenCache = {
    token: data.access_token,
    expiresAt: Date.now() + (data.expires_in - 60) * 1000,
  };
  return tokenCache.token;
}

/**
 * generate({ system, contents }) -> the model's text (a JSON string when
 * the caller asked for JSON mode, which this service always does).
 * contents: [{ role: 'user'|'model', text }]
 */
async function generate({ system, contents }) {
  const body = {
    systemInstruction: { parts: [{ text: system }] },
    contents: contents.map((c) => ({
      role: c.role,
      parts: [{ text: c.text }],
    })),
    generationConfig: {
      temperature: config.MODEL_TEMPERATURE,
      responseMimeType: 'application/json',
    },
  };

  let url;
  let headers;
  if (config.MODEL_PROVIDER === 'vertex') {
    const token = await vertexAccessToken();
    url =
      `https://${config.VERTEX_REGION}-aiplatform.googleapis.com/v1/projects/` +
      `${config.VERTEX_PROJECT}/locations/${config.VERTEX_REGION}/publishers/` +
      `google/models/${config.VERTEX_MODEL}:generateContent`;
    headers = {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${token}`,
    };
  } else {
    const key = process.env.GEMINI_API_KEY;
    if (!key) throw new Error('GEMINI_API_KEY is not set');
    url =
      `https://generativelanguage.googleapis.com/v1beta/models/` +
      `${config.GEMINI_MODEL}:generateContent`;
    headers = { 'Content-Type': 'application/json', 'x-goog-api-key': key };
  }

  // One retry on transient capacity errors (429 / 503): the flash-lite
  // pool occasionally answers "high demand" for a few seconds, and a
  // chat visitor should not meet the fallback for that.
  let res;
  let data = {};
  for (let attempt = 0; attempt < 2; attempt++) {
    res = await fetchWithTimeout(url, {
      method: 'POST',
      headers,
      body: JSON.stringify(body),
    });
    data = await res.json().catch(() => ({}));
    if (res.ok) break;
    if ((res.status === 429 || res.status === 503) && attempt === 0) {
      await new Promise((r) => setTimeout(r, 1500));
      continue;
    }
    break;
  }
  if (!res.ok) {
    const msg =
      (data.error && data.error.message) || JSON.stringify(data).slice(0, 300);
    throw new Error(`Model call failed (${res.status}): ${msg}`);
  }
  const parts =
    (data.candidates &&
      data.candidates[0] &&
      data.candidates[0].content &&
      data.candidates[0].content.parts) ||
    [];
  const text = parts.map((p) => p.text || '').join('');
  if (!text) throw new Error('Model returned an empty reply');
  return text;
}

/** Parse the agent's JSON answer the way the old engine's parser did:
 * strip code fences, then JSON.parse; on failure return null. */
function parseAgentJson(text) {
  try {
    return JSON.parse(text);
  } catch (_) {
    const start = text.indexOf('{');
    const end = text.lastIndexOf('}');
    if (start >= 0 && end > start) {
      try {
        return JSON.parse(text.slice(start, end + 1));
      } catch (_) {
        return null;
      }
    }
    return null;
  }
}

module.exports = { generate, parseAgentJson };
