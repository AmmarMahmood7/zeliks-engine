'use strict';
// All settings in one place. Secrets come from the environment only.

const env = process.env;

module.exports = {
  port: Number(env.PORT || 8080),
  publicBaseUrl: env.PUBLIC_BASE_URL || 'http://localhost:8080',
  databaseUrl: env.DATABASE_URL,

  // Model: 'gemini' (Google AI Studio) or 'openai' (any OpenAI-compatible API: OpenAI, DeepSeek, OpenRouter).
  model: {
    provider: env.MODEL_PROVIDER || 'gemini',
    name: env.MODEL_NAME || 'gemini-2.5-flash',
    fallbackName: env.MODEL_FALLBACK_NAME || 'gemini-flash-lite-latest', // used when the main model fails
    apiKey: env.MODEL_API_KEY || env.GEMINI_API_KEY,
    baseUrl: env.MODEL_BASE_URL || 'https://api.openai.com/v1',
    temperature: Number(env.MODEL_TEMPERATURE || 0.3),
    timeoutMs: Number(env.MODEL_TIMEOUT_MS || 15000),
  },

  historyMessages: Number(env.HISTORY_MESSAGES || 20), // recent messages sent to the model
  maxMessageChars: 2000,
  businessCacheMs: 60000, // business records are cached in memory for this long

  adminToken: env.ADMIN_TOKEN, // protects the /admin routes
  meta: {
    verifyToken: env.META_VERIFY_TOKEN,
    appSecret: env.META_APP_SECRET,
    graphVersion: env.META_GRAPH_VERSION || 'v21.0',
  },
  telegramSecret: env.TELEGRAM_WEBHOOK_SECRET,
};
