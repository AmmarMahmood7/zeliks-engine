-- Zeliks Engine: Postgres schema
-- One shared database for all businesses. Every business-owned table carries
-- tenant_id, and every query in the engine filters on it inside the SQL.
-- Isolation is never done by fetching rows and filtering them afterwards.
--
-- Apply:  psql "$DATABASE_URL" -f db/schema.sql
-- Needs:  Postgres 13 or newer (gen_random_uuid is built in).
--         The btree_gist extension, used by the booking overlap guard.

BEGIN;

CREATE EXTENSION IF NOT EXISTS btree_gist;
CREATE EXTENSION IF NOT EXISTS pgcrypto;

-- ---------------------------------------------------------------------------
-- tenants: one row per business. The id is the slug, and it matches the
-- config pack file name in packs/ (packs/luxe-locks-salon.json -> luxe-locks-salon).
-- ---------------------------------------------------------------------------
CREATE TABLE tenants (
    id          text PRIMARY KEY,
    name        text NOT NULL,
    pack_file   text NOT NULL,
    timezone    text NOT NULL DEFAULT 'America/Chicago',
    status      text NOT NULL DEFAULT 'active'
                CHECK (status IN ('active', 'paused', 'closed')),
    created_at  timestamptz NOT NULL DEFAULT now(),
    updated_at  timestamptz NOT NULL DEFAULT now()
);

-- ---------------------------------------------------------------------------
-- leads: a person who contacted the business and might buy.
-- One lead per (tenant, customer) where customer_id is the channel-scoped id
-- of the person (for Telegram, their chat id; later, a WhatsApp number).
-- ---------------------------------------------------------------------------
CREATE TABLE leads (
    id             uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    tenant_id      text NOT NULL REFERENCES tenants (id) ON DELETE CASCADE,
    customer_id    text NOT NULL,
    name           text,
    phone          text,
    need           text,
    status         text NOT NULL DEFAULT 'new'
                   CHECK (status IN ('new', 'engaged', 'booked', 'quiet', 'closed')),
    source_channel text NOT NULL DEFAULT 'telegram',
    first_seen_at  timestamptz NOT NULL DEFAULT now(),
    last_seen_at   timestamptz NOT NULL DEFAULT now(),
    created_at     timestamptz NOT NULL DEFAULT now(),
    updated_at     timestamptz NOT NULL DEFAULT now(),
    UNIQUE (tenant_id, customer_id)
);

CREATE INDEX leads_tenant_status_idx ON leads (tenant_id, status);

-- ---------------------------------------------------------------------------
-- conversations: one chat thread with a customer. booking_state holds the
-- booking state machine's scratchpad while a booking is being collected:
--   {"state": "collect", "service_id": null, "starts_at": null, ...}
-- The partial unique index keeps at most one open conversation per customer
-- per tenant, so a chat can never split into two live threads by accident.
-- ---------------------------------------------------------------------------
CREATE TABLE conversations (
    id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    tenant_id     text NOT NULL REFERENCES tenants (id) ON DELETE CASCADE,
    lead_id       uuid REFERENCES leads (id) ON DELETE SET NULL,
    customer_id   text NOT NULL,
    channel       text NOT NULL DEFAULT 'telegram',
    status        text NOT NULL DEFAULT 'open'
                  CHECK (status IN ('open', 'handed_over', 'closed')),
    booking_state jsonb NOT NULL DEFAULT '{}'::jsonb,
    started_at    timestamptz NOT NULL DEFAULT now(),
    ended_at      timestamptz
);

CREATE UNIQUE INDEX conversations_one_open_per_customer
    ON conversations (tenant_id, customer_id)
    WHERE status = 'open';

CREATE INDEX conversations_tenant_customer_idx
    ON conversations (tenant_id, customer_id, started_at DESC);

-- ---------------------------------------------------------------------------
-- messages: every message in and out, in order. This is the raw material for
-- the evening summary and for reviewing what the agent actually said.
-- ---------------------------------------------------------------------------
CREATE TABLE messages (
    id              bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    tenant_id       text NOT NULL REFERENCES tenants (id) ON DELETE CASCADE,
    conversation_id uuid NOT NULL REFERENCES conversations (id) ON DELETE CASCADE,
    direction       text NOT NULL CHECK (direction IN ('in', 'out')),
    sender          text NOT NULL CHECK (sender IN ('customer', 'agent', 'owner', 'system')),
    body            text NOT NULL,
    created_at      timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX messages_conversation_idx
    ON messages (tenant_id, conversation_id, created_at);

-- ---------------------------------------------------------------------------
-- bookings: an appointment in the diary.
-- Two guards work together (see db/notes.md):
--   1. idempotency_key is unique per tenant, so a retried write of the same
--      confirmed booking returns the existing row instead of a duplicate.
--   2. The exclusion constraint makes it impossible for two confirmed
--      bookings of the same tenant to overlap in time, whoever writes them.
-- service_id matches the id of a service in the tenant's config pack.
-- ---------------------------------------------------------------------------
CREATE TABLE bookings (
    id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    tenant_id       text NOT NULL REFERENCES tenants (id) ON DELETE CASCADE,
    lead_id         uuid REFERENCES leads (id) ON DELETE SET NULL,
    conversation_id uuid REFERENCES conversations (id) ON DELETE SET NULL,
    service_id      text NOT NULL,
    starts_at       timestamptz NOT NULL,
    ends_at         timestamptz NOT NULL,
    status          text NOT NULL DEFAULT 'confirmed'
                    CHECK (status IN ('confirmed', 'cancelled', 'rescheduled', 'no_show')),
    idempotency_key text NOT NULL,
    created_at      timestamptz NOT NULL DEFAULT now(),
    updated_at      timestamptz NOT NULL DEFAULT now(),
    CHECK (ends_at > starts_at),
    UNIQUE (tenant_id, idempotency_key),
    EXCLUDE USING gist (
        tenant_id WITH =,
        tstzrange(starts_at, ends_at) WITH &&
    ) WHERE (status = 'confirmed')
);

CREATE INDEX bookings_tenant_starts_idx ON bookings (tenant_id, starts_at);

-- ---------------------------------------------------------------------------
-- register_events: the day book. Every notable thing that happened, in plain
-- language, one row each: lead captured, booking made, question unanswered,
-- nudge sent. The evening summary is built from these rows and nothing else.
-- ---------------------------------------------------------------------------
CREATE TABLE register_events (
    id          bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    tenant_id   text NOT NULL REFERENCES tenants (id) ON DELETE CASCADE,
    event_type  text NOT NULL,
    entity_type text,
    entity_id   text,
    summary     text NOT NULL,
    payload     jsonb NOT NULL DEFAULT '{}'::jsonb,
    created_at  timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX register_events_tenant_day_idx
    ON register_events (tenant_id, created_at);

-- ---------------------------------------------------------------------------
-- followups: scheduled nudges. The follow-up workflow polls rows that are
-- due. The partial unique index keeps at most one scheduled nudge per lead,
-- so re-running the scheduler can never queue the same nudge twice.
-- ---------------------------------------------------------------------------
CREATE TABLE followups (
    id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    tenant_id       text NOT NULL REFERENCES tenants (id) ON DELETE CASCADE,
    lead_id         uuid NOT NULL REFERENCES leads (id) ON DELETE CASCADE,
    conversation_id uuid REFERENCES conversations (id) ON DELETE SET NULL,
    kind            text NOT NULL DEFAULT 'quiet_lead_nudge',
    due_at          timestamptz NOT NULL,
    status          text NOT NULL DEFAULT 'scheduled'
                    CHECK (status IN ('scheduled', 'sent', 'cancelled', 'done')),
    attempts        integer NOT NULL DEFAULT 0,
    sent_at         timestamptz,
    created_at      timestamptz NOT NULL DEFAULT now()
);

CREATE UNIQUE INDEX followups_one_scheduled_per_lead
    ON followups (tenant_id, lead_id)
    WHERE status = 'scheduled';

CREATE INDEX followups_due_idx ON followups (status, due_at);

-- ---------------------------------------------------------------------------
-- summaries: one evening summary per tenant per day. The unique constraint
-- makes the cron safe to re-run: a second run updates the same row.
-- ---------------------------------------------------------------------------
CREATE TABLE summaries (
    id           uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    tenant_id    text NOT NULL REFERENCES tenants (id) ON DELETE CASCADE,
    summary_date date NOT NULL,
    body         text NOT NULL,
    stats        jsonb NOT NULL DEFAULT '{}'::jsonb,
    sent_at      timestamptz,
    created_at   timestamptz NOT NULL DEFAULT now(),
    UNIQUE (tenant_id, summary_date)
);

COMMIT;

-- ===========================================================================
-- Reference queries used by the workflows. The workflows carry their own
-- copies; these are the canonical versions to test against.
-- ===========================================================================

-- Availability check (booking state machine, "check_availability" state).
-- Returns true when no confirmed booking of this tenant overlaps the slot.
-- $1 tenant_id, $2 starts_at, $3 ends_at.
--
--   SELECT NOT EXISTS (
--       SELECT 1 FROM bookings
--       WHERE tenant_id = $1
--         AND status = 'confirmed'
--         AND tstzrange(starts_at, ends_at) && tstzrange($2, $3)
--   ) AS slot_free;

-- Idempotent booking write (booking state machine, "write_booking" state).
-- The idempotency key is built by the workflow from the confirmed details
-- (tenant + lead + service + start time, hashed). If the same write is
-- retried after a timeout, the conflict returns the existing booking and no
-- second row is created. If a different booking already holds the slot, the
-- exclusion constraint raises an error and the workflow sends the customer
-- back to pick another time.
-- $1 tenant_id, $2 lead_id, $3 conversation_id, $4 service_id,
-- $5 starts_at, $6 ends_at, $7 idempotency_key.
--
--   INSERT INTO bookings
--       (tenant_id, lead_id, conversation_id, service_id,
--        starts_at, ends_at, idempotency_key)
--   VALUES ($1, $2, $3, $4, $5, $6, $7)
--   ON CONFLICT (tenant_id, idempotency_key) DO NOTHING
--   RETURNING id;
