'use strict';
/*
 * Zeliks website assistant: service configuration.
 *
 * THIS IS THE ONE PLACE for service-wide settings. Change a behaviour here,
 * not in the route code. Secrets are NOT here: they come from the
 * environment (.env on the server): DATABASE_URL, GEMINI_API_KEY,
 * GOOGLE_APPLICATION_CREDENTIALS, DEMO_EDIT_PIN.
 */
module.exports = {
  PORT: Number(process.env.PORT || 8080),

  // ------------------------------------------------------------------
  // CONVERSATION HISTORY (the setting the owner asked about)
  //
  // HISTORY_MESSAGES: on every turn, the model is sent the last
  // HISTORY_MESSAGES messages of the conversation (the visitor's and the
  // assistant's, in order, including the message just received). Before
  // this service existed, the old engine sent ONLY the latest message and
  // no window was defined anywhere.
  //
  // When a conversation grows past the window, the older part is carried
  // as a short rolling summary: the model refreshes it on every reply
  // (the "summary" field of its JSON answer) and it is stored on the
  // conversation row and injected into the next turn's context.
  //
  // Change the number here (or set HISTORY_MESSAGES in .env) and restart
  // the container. Default: 20.
  // ------------------------------------------------------------------
  HISTORY_MESSAGES: Number(process.env.HISTORY_MESSAGES || 20),
  SUMMARY_MAX_CHARS: 1200,

  // Model. Provider "aistudio" uses the Gemini API key credential.
  // Provider "vertex" uses the service account at
  // GOOGLE_APPLICATION_CREDENTIALS against the Vertex project in .env.
  // (Vertex is implemented and ready, but the Agent Platform API is
  // currently disabled in that Google Cloud project, so the deployed
  // service runs on aistudio. Same generateContent JSON contract either
  // way; see lib/model.js.)
  MODEL_PROVIDER: process.env.MODEL_PROVIDER || 'aistudio',
  GEMINI_MODEL: process.env.GEMINI_MODEL || 'gemini-flash-lite-latest',
  VERTEX_MODEL: process.env.VERTEX_MODEL || 'gemini-3.5-flash-lite',
  VERTEX_PROJECT: process.env.VERTEX_PROJECT || '',
  VERTEX_REGION: process.env.VERTEX_REGION || 'us-central1',
  MODEL_TEMPERATURE: 0.3,
  MODEL_TIMEOUT_MS: 45000,

  // Public base the one-tag snippet points at (loader prints it).
  PUBLIC_BASE_URL:
    process.env.PUBLIC_BASE_URL || 'https://n8n.moodtech.cloud/zeliks-chat',

  // FAQ / knowledge lookup: how many matched entries are injected.
  LOOKUP_MAX_RESULTS: 3,
  LOOKUP_MIN_SCORE: 2,
};
