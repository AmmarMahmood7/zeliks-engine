# Zeliks Engine v2

One AI assistant service for many businesses, on every channel.

```
Website widget ─┐
WhatsApp ───────┤                          ┌─ business record (facts + settings)
Instagram DM ───┼─▶ door ─▶ brain.handle ─▶┼─ last 20 messages + rolling summary
Telegram ───────┘                          └─ AI model (Gemini or any OpenAI-compatible API)
```

Example: a café adds one script tag to its site and connects its WhatsApp
number. Both reach the same brain, which reads the café's one record. Change
the café's prices in that record and every channel answers with the new ones.

## Layout

| File | Job |
|---|---|
| `src/brain.js` | Turns one message into one reply, for every channel |
| `src/prompt.js` | Fixed rules first (cacheable), then the business facts |
| `src/model.js` | Gemini or OpenAI-compatible call, JSON answer |
| `src/store.js` | All SQL. Two database round trips per message |
| `src/doors/web.js` | The one-tag widget (same API as v1, so existing installs keep working) |
| `src/doors/meta.js` | WhatsApp Cloud API and Instagram DMs, one webhook: `/meta` |
| `src/doors/telegram.js` | Telegram bots: `/telegram/<bot id>` |
| `src/admin.js` | Create businesses, edit facts, add channels (Bearer `ADMIN_TOKEN`) |
| `src/alerts.js` | Tells the owner when a chat needs them (Telegram and/or a webhook, e.g. n8n) |
| `db/schema.sql` | Six tables: businesses, channels, conversations, messages, leads, events |

## Add a business

```bash
curl -X PUT $BASE/admin/businesses/cafe-one -H "Authorization: Bearer $ADMIN_TOKEN" \
  -H 'Content-Type: application/json' \
  -d '{"name":"Cafe One","facts":"What the assistant should know...","settings":{"allowed_domains":["cafeone.om",".cafeone.om"],"greeting":"Hi! Ask me anything about Cafe One."}}'

# website widget: returns the one-line snippet to paste on their site
curl -X POST $BASE/admin/businesses/cafe-one/channels -H "Authorization: Bearer $ADMIN_TOKEN" -d '{"kind":"web"}'

# WhatsApp: their phone_number_id and a permanent access token
curl -X POST $BASE/admin/businesses/cafe-one/channels -H "Authorization: Bearer $ADMIN_TOKEN" \
  -d '{"kind":"whatsapp","external_id":"PHONE_NUMBER_ID","credentials":{"access_token":"..."}}'
```

## Settings per business

`allowed_domains`, `greeting`, `primary_color`, `logo_url`, `position`,
`owner_alert` (`telegram_chat_id` and/or `webhook_url`),
`after_handover` (`answer` keeps replying after alerting the owner, the default; `stop` goes quiet).

## Environment

`DATABASE_URL`, `MODEL_PROVIDER` (`gemini`|`openai`), `MODEL_NAME`, `MODEL_API_KEY`,
`MODEL_BASE_URL` (OpenAI-compatible only), `ADMIN_TOKEN`, `PUBLIC_BASE_URL`,
`META_VERIFY_TOKEN`, `META_APP_SECRET`, `TELEGRAM_WEBHOOK_SECRET`, `ALERT_TELEGRAM_BOT_TOKEN`.

## Run

```bash
npm install && npm test        # in-memory Postgres, fake model
npm run migrate && npm start   # real database
OLD_DATABASE_URL=... node scripts/import_v1.js   # one-off: copy v1 businesses and widget keys
```
