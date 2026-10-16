-- 0046_crm_connectors.sql
-- LYCERT_BRIDGE_ARCHITECTURE.md Part 6.9 + Part 5 — the CRM connector layer (HubSpot first). Lycert stops
-- owning authoritative verification and instead orchestrates the client's existing CRM + verification
-- provider; this is the foundation schema for the "CRM" half of that (Milestone M1). SheerID's tables
-- (verification_provider_connections, reverification_requests — Part 7.3) are NOT part of this migration;
-- they land with Milestone M3.
--
-- STAGING ONLY for now, same standing posture as the verification layer (0037-0045): prod still lacks the
-- entire enrichment/verification chain, so this is additive to that same deferred prod-promotion ledger.
--
-- Queue: adds crm_sync_q (+ DLQ) to the SAME pgmq runtime as enrichment/verification (0030/0041) — Part 5
-- is explicit that all long-running CRM work (backfill, reconcile, write-back) must run on this queue,
-- never inside a Vercel request handler. The generic public.q_* wrappers from 0030 already operate on any
-- queue name, so no new RPC surface is needed.

CREATE EXTENSION IF NOT EXISTS pgmq;

SELECT pgmq.create('crm_sync_q')  WHERE NOT EXISTS (SELECT 1 FROM pgmq.list_queues() WHERE queue_name = 'crm_sync_q');
SELECT pgmq.create('crm_sync_dlq') WHERE NOT EXISTS (SELECT 1 FROM pgmq.list_queues() WHERE queue_name = 'crm_sync_dlq');

-- One connected CRM per tenant per provider. Tokens are AES-256-GCM ciphertext (lib/crypto.ts,
-- LYCERT_ENCRYPTION_KEY) — never plaintext, never returned to the client layer. RLS does not protect
-- column contents, only row visibility; the ciphertext is the actual protection.
CREATE TABLE crm_connections (
    id                 uuid        PRIMARY KEY DEFAULT gen_random_uuid(),
    tenant_id          uuid        NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
    provider           text        NOT NULL DEFAULT 'hubspot',
    portal_id          text        NOT NULL,
    hub_domain         text,
    scopes             text[]      NOT NULL DEFAULT '{}',
    access_token_enc   text        NOT NULL,
    access_expires_at  timestamptz NOT NULL,
    refresh_token_enc  text        NOT NULL,
    status             text        NOT NULL DEFAULT 'connected',  -- 'connected' | 'error' | 'disconnected'
    installed_by       uuid        REFERENCES auth.users(id) ON DELETE SET NULL,
    installed_at       timestamptz NOT NULL DEFAULT now(),
    last_error         text,
    created_at         timestamptz NOT NULL DEFAULT now(),
    updated_at         timestamptz NOT NULL DEFAULT now(),

    UNIQUE(tenant_id, provider)
);

-- Lycert subscriber <-> CRM object identity mirror (Part 6.6). Write-back is keyed by HubSpot's internal
-- record id (batch/update does not support email), never by email.
CREATE TABLE crm_contact_links (
    id                 uuid        PRIMARY KEY DEFAULT gen_random_uuid(),
    tenant_id          uuid        NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
    subscriber_id      uuid        NOT NULL REFERENCES subscribers(id) ON DELETE CASCADE,
    provider           text        NOT NULL DEFAULT 'hubspot',
    crm_object_id      text        NOT NULL,
    last_inbound_at    timestamptz,
    last_writeback_at  timestamptz,
    writeback_hash     text,                      -- hash of last-written values; write-back diffs against this
    created_at         timestamptz NOT NULL DEFAULT now(),
    updated_at         timestamptz NOT NULL DEFAULT now(),

    UNIQUE(tenant_id, provider, crm_object_id)
);

CREATE INDEX idx_crm_contact_links_tenant      ON crm_contact_links(tenant_id);
CREATE INDEX idx_crm_contact_links_subscriber  ON crm_contact_links(subscriber_id);

-- Field mapping, both directions (Part 6.4 bootstrap writes created_by_lycert=true outbound rows; Part 6.5
-- segment discovery writes inbound rows for email/name/grad-date/institution/etc).
CREATE TABLE crm_property_mappings (
    id                 uuid        PRIMARY KEY DEFAULT gen_random_uuid(),
    tenant_id          uuid        NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
    provider           text        NOT NULL DEFAULT 'hubspot',
    direction          text        NOT NULL,       -- 'inbound' | 'outbound'
    lycert_field       text        NOT NULL,
    crm_property       text        NOT NULL,
    created_by_lycert  boolean     NOT NULL DEFAULT false,
    status             text        NOT NULL DEFAULT 'ok',  -- 'ok' | 'conflict' | 'missing'
    created_at         timestamptz NOT NULL DEFAULT now(),
    updated_at         timestamptz NOT NULL DEFAULT now(),

    UNIQUE(tenant_id, provider, direction, lycert_field)
);

CREATE INDEX idx_crm_property_mappings_tenant ON crm_property_mappings(tenant_id);

-- How the client defines "this is an EDU contact" (Part 6.5). M1 only ever writes mode='property';
-- 'list' and 'sheerid_sync' are valid values reserved for M2+/deferred modes, not built yet.
CREATE TABLE crm_segment_config (
    id          uuid        PRIMARY KEY DEFAULT gen_random_uuid(),
    tenant_id   uuid        NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
    provider    text        NOT NULL DEFAULT 'hubspot',
    mode        text        NOT NULL,              -- 'property' | 'list' | 'sheerid_sync'
    definition  jsonb       NOT NULL,
    created_at  timestamptz NOT NULL DEFAULT now(),
    updated_at  timestamptz NOT NULL DEFAULT now(),

    UNIQUE(tenant_id, provider)
);

-- Observability for backfill/reconcile/write-back runs (Part 11 — per-portal API usage, dead-letter counts).
CREATE TABLE crm_sync_runs (
    id           uuid        PRIMARY KEY DEFAULT gen_random_uuid(),
    tenant_id    uuid        NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
    provider     text        NOT NULL DEFAULT 'hubspot',
    kind         text        NOT NULL,             -- 'backfill' | 'reconcile' | 'writeback'
    started_at   timestamptz NOT NULL DEFAULT now(),
    finished_at  timestamptz,
    counts       jsonb,
    api_calls    integer     NOT NULL DEFAULT 0,
    status       text        NOT NULL DEFAULT 'running',  -- 'running' | 'completed' | 'failed'
    error        text,
    created_at   timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX idx_crm_sync_runs_tenant_started ON crm_sync_runs(tenant_id, started_at DESC);

ALTER TABLE crm_connections       ENABLE ROW LEVEL SECURITY;
ALTER TABLE crm_contact_links     ENABLE ROW LEVEL SECURITY;
ALTER TABLE crm_property_mappings ENABLE ROW LEVEL SECURITY;
ALTER TABLE crm_segment_config    ENABLE ROW LEVEL SECURITY;
ALTER TABLE crm_sync_runs         ENABLE ROW LEVEL SECURITY;

CREATE POLICY "crm_connections_tenant_isolation"
  ON crm_connections FOR ALL TO authenticated
  USING (tenant_id = (auth.jwt() ->> 'tenant_id')::uuid)
  WITH CHECK (tenant_id = (auth.jwt() ->> 'tenant_id')::uuid);

CREATE POLICY "crm_contact_links_tenant_isolation"
  ON crm_contact_links FOR ALL TO authenticated
  USING (tenant_id = (auth.jwt() ->> 'tenant_id')::uuid)
  WITH CHECK (tenant_id = (auth.jwt() ->> 'tenant_id')::uuid);

CREATE POLICY "crm_property_mappings_tenant_isolation"
  ON crm_property_mappings FOR ALL TO authenticated
  USING (tenant_id = (auth.jwt() ->> 'tenant_id')::uuid)
  WITH CHECK (tenant_id = (auth.jwt() ->> 'tenant_id')::uuid);

CREATE POLICY "crm_segment_config_tenant_isolation"
  ON crm_segment_config FOR ALL TO authenticated
  USING (tenant_id = (auth.jwt() ->> 'tenant_id')::uuid)
  WITH CHECK (tenant_id = (auth.jwt() ->> 'tenant_id')::uuid);

CREATE POLICY "crm_sync_runs_tenant_isolation"
  ON crm_sync_runs FOR ALL TO authenticated
  USING (tenant_id = (auth.jwt() ->> 'tenant_id')::uuid)
  WITH CHECK (tenant_id = (auth.jwt() ->> 'tenant_id')::uuid);

CREATE TRIGGER crm_connections_updated_at
  BEFORE UPDATE ON crm_connections
  FOR EACH ROW EXECUTE FUNCTION set_updated_at();

CREATE TRIGGER crm_contact_links_updated_at
  BEFORE UPDATE ON crm_contact_links
  FOR EACH ROW EXECUTE FUNCTION set_updated_at();

CREATE TRIGGER crm_property_mappings_updated_at
  BEFORE UPDATE ON crm_property_mappings
  FOR EACH ROW EXECUTE FUNCTION set_updated_at();

CREATE TRIGGER crm_segment_config_updated_at
  BEFORE UPDATE ON crm_segment_config
  FOR EACH ROW EXECUTE FUNCTION set_updated_at();
