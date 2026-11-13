-- Zeliks Engine v2 schema. One business record, many channels.
-- Every business-owned row carries business_id; queries always filter on it.

CREATE TABLE IF NOT EXISTS businesses (
    id          text PRIMARY KEY,                 -- slug, e.g. 'zeliks'
    name        text NOT NULL,
    timezone    text NOT NULL DEFAULT 'Asia/Muscat',
    facts       text NOT NULL DEFAULT '',         -- everything the assistant knows, plain text
    settings    jsonb NOT NULL DEFAULT '{}'::jsonb,
    -- settings: allowed_domains[], greeting, primary_color, logo_url, position,
    --           owner_alert {telegram_chat_id | webhook_url}, after_handover ('answer'|'stop')
    active      boolean NOT NULL DEFAULT true,
    created_at  timestamptz NOT NULL DEFAULT now(),
    updated_at  timestamptz NOT NULL DEFAULT now()
);

-- How a message reaches a business. external_id identifies the door:
-- web = widget key, whatsapp = phone_number_id, instagram = IG account id, telegram = bot id.
CREATE TABLE IF NOT EXISTS channels (
    id           bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    business_id  text NOT NULL REFERENCES businesses (id) ON DELETE CASCADE,
    kind         text NOT NULL CHECK (kind IN ('web', 'whatsapp', 'instagram', 'telegram')),
    external_id  text NOT NULL,
    credentials  jsonb NOT NULL DEFAULT '{}'::jsonb,  -- access_token / bot_token / webhook secret
    active       boolean NOT NULL DEFAULT true,
    created_at   timestamptz NOT NULL DEFAULT now(),
    UNIQUE (kind, external_id)
);
CREATE INDEX IF NOT EXISTS channels_business_idx ON channels (business_id);

-- One conversation per contact per channel. contact_id = phone, IG user id, chat id or web session.
CREATE TABLE IF NOT EXISTS conversations (
    id               uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    business_id      text NOT NULL REFERENCES businesses (id) ON DELETE CASCADE,
    channel          text NOT NULL,
    contact_id       text NOT NULL,
    status           text NOT NULL DEFAULT 'open' CHECK (status IN ('open', 'handed_over', 'closed')),
    summary          text,               -- rolling summary of messages older than the history window
    page             jsonb,              -- web only: what the visitor is looking at
    alerted_at       timestamptz,        -- when the owner was last told about this chat
    last_message_at  timestamptz NOT NULL DEFAULT now(),
    created_at       timestamptz NOT NULL DEFAULT now(),
    UNIQUE (business_id, channel, contact_id)
);

CREATE TABLE IF NOT EXISTS messages (
    id               bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    conversation_id  uuid NOT NULL REFERENCES conversations (id) ON DELETE CASCADE,
    role             text NOT NULL CHECK (role IN ('user', 'assistant', 'owner')),
    body             text NOT NULL,
    created_at       timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS messages_conversation_idx ON messages (conversation_id, id DESC);

-- One lead per conversation, filled in as the chat goes.
CREATE TABLE IF NOT EXISTS leads (
    id               uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    business_id      text NOT NULL REFERENCES businesses (id) ON DELETE CASCADE,
    conversation_id  uuid NOT NULL UNIQUE REFERENCES conversations (id) ON DELETE CASCADE,
    name             text,
    phone            text,
    need             text,
    email            text,
    company          text,
    status           text NOT NULL DEFAULT 'new',
    created_at       timestamptz NOT NULL DEFAULT now(),
    updated_at       timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS leads_business_idx ON leads (business_id, created_at DESC);

-- Audit trail: handovers, alerts, errors.
CREATE TABLE IF NOT EXISTS events (
    id           bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    business_id  text NOT NULL REFERENCES businesses (id) ON DELETE CASCADE,
    kind         text NOT NULL,
    ref          text,
    payload      jsonb NOT NULL DEFAULT '{}'::jsonb,
    created_at   timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS events_business_idx ON events (business_id, created_at DESC);

-- Upgrades for databases created before a column existed.
ALTER TABLE conversations ADD COLUMN IF NOT EXISTS alerted_at timestamptz;
ALTER TABLE leads ADD COLUMN IF NOT EXISTS email text;
ALTER TABLE leads ADD COLUMN IF NOT EXISTS company text;
