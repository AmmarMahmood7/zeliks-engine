-- Phase 1 (website assistant) additions to the Zeliks engine schema.
-- Additive only: no existing table, column or row is changed in meaning.
-- Booking, follow-up and summary tables are untouched.

-- The full pack and the live context document live next to the compiled
-- prompt, so one business record carries everything the assistant needs.
ALTER TABLE tenant_config ADD COLUMN IF NOT EXISTS pack jsonb;
ALTER TABLE tenant_config ADD COLUMN IF NOT EXISTS pack_version integer NOT NULL DEFAULT 1;
ALTER TABLE tenant_config ADD COLUMN IF NOT EXISTS context_text text;
ALTER TABLE tenant_config ADD COLUMN IF NOT EXISTS context_updated_at timestamptz;

-- One row per widget key. The key is what the one-tag snippet carries;
-- the business it belongs to is resolved here, never trusted from the
-- page. Keys can be revoked by setting active = false.
CREATE TABLE IF NOT EXISTS widget_keys (
    key         text PRIMARY KEY,
    tenant_id   text NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
    active      boolean NOT NULL DEFAULT true,
    created_at  timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS widget_keys_tenant_idx ON widget_keys (tenant_id);

-- What the visitor was looking at (stored at session start, refreshed on
-- every message), the visitor's name when known, and the rolling summary
-- of the part of the conversation older than the history window.
ALTER TABLE conversations ADD COLUMN IF NOT EXISTS live_packet jsonb NOT NULL DEFAULT '{}'::jsonb;
ALTER TABLE conversations ADD COLUMN IF NOT EXISTS summary text;
ALTER TABLE conversations ADD COLUMN IF NOT EXISTS visitor_name text;
