'use strict';
// Calls the language model and returns its JSON answer.
// Provider is a setting: Gemini (AI Studio) or any OpenAI-compatible API.

const config = require('./config');

async function post(url, headers, body) {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), config.model.timeoutMs);
  try {
    for (let attempt = 0; attempt < 2; attempt++) {
      const res = await fetch(url, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', ...headers },
        body: JSON.stringify(body),
        signal: ctrl.signal,
      });
      const data = await res.json().catch(() => ({}));
      if (res.ok) return data;
      if ((res.status === 429 || res.status >= 500) && attempt === 0) {
        await new Promise((r) => setTimeout(r, 1200));
        continue;
      }
      throw new Error(`model ${res.status}: ${JSON.stringify(data).slice(0, 200)}`);
    }
  } finally {
    clearTimeout(timer);
  }
}

// messages: [{role: 'user'|'assistant', text}]
// Tries the main model, then the fallback model if the main one errors or returns nothing.
async function generate({ system, messages }) {
  const names = [config.model.name, config.model.fallbackName].filter((n, i, a) => n && a.indexOf(n) === i);
  let lastErr;
  for (const name of names) {
    try {
      const text = await callModel(name, system, messages);
      if (parseJson(text)) return text;
      lastErr = new Error(`${name} returned no JSON: ${String(text).slice(0, 120)}`);
    } catch (e) {
      lastErr = e;
    }
    console.warn(`model ${name} failed: ${lastErr.message}`);
  }
  throw lastErr;
}

async function callModel(name, system, messages) {
  const m = config.model;
  if (!m.apiKey) throw new Error('MODEL_API_KEY is not set');

  if (m.provider === 'openai') {
    const data = await post(
      `${m.baseUrl.replace(/\/$/, '')}/chat/completions`,
      { Authorization: `Bearer ${m.apiKey}` },
      {
        model: name,
        temperature: m.temperature,
        response_format: { type: 'json_object' },
        messages: [{ role: 'system', content: system }, ...messages.map((x) => ({ role: x.role, content: x.text }))],
      }
    );
    return data.choices?.[0]?.message?.content || '';
  }

  const data = await post(
    `https://generativelanguage.googleapis.com/v1beta/models/${name}:generateContent`,
    { 'x-goog-api-key': m.apiKey },
    {
      systemInstruction: { parts: [{ text: system }] },
      contents: messages.map((x) => ({ role: x.role === 'assistant' ? 'model' : 'user', parts: [{ text: x.text }] })),
      generationConfig: { temperature: m.temperature, responseMimeType: 'application/json' },
    }
  );
  return data.candidates?.[0]?.content?.parts?.map((p) => p.text).join('') || '';
}

// Pulls the first JSON object out of the model's text, tolerating code fences.
function parseJson(text) {
  if (!text) return null;
  const start = text.indexOf('{');
  const end = text.lastIndexOf('}');
  if (start < 0 || end <= start) return null;
  try {
    return JSON.parse(text.slice(start, end + 1));
  } catch {
    return null;
  }
}

module.exports = { generate, parseJson };
