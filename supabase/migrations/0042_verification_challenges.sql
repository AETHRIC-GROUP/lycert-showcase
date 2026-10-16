-- 0042_verification_challenges.sql
-- LYCERT_VERIFICATION_ARCHITECTURE.md Part 8.1 (email loop). Backing store for the one-time, expiring,
-- single-use email-loop challenge: a link is sent to a VERIFIED institutional address; clicking it within
-- the window proves CURRENT control of that inbox → CONTROL_PROVEN (semi_authoritative). This table holds
-- the issued challenge so the click route (and the verification worker's getCompletedChallenge) can
-- resolve it. The result itself is written to verification_results; this table is the transient token store.
--
-- STAGING-ONLY for now (same prod override + ledger as 0037–0042).

CREATE TABLE verification_challenges (
    id            uuid        PRIMARY KEY DEFAULT gen_random_uuid(),
    tenant_id     uuid        NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
    subscriber_id uuid        NOT NULL REFERENCES subscribers(id) ON DELETE CASCADE,
    email         text        NOT NULL,                 -- the institutional address the link was sent to
    token         text        UNIQUE NOT NULL,          -- single-use bearer secret (carried in the link)
    issued_at     timestamptz NOT NULL DEFAULT now(),
    expires_at    timestamptz NOT NULL,
    consumed_at   timestamptz,                          -- set when the link is clicked (single-use)
    outcome       text,                                 -- 'control_proven' | 'expired' | 'mismatch' once resolved
    created_at    timestamptz NOT NULL DEFAULT now()
);

-- One active (unconsumed) challenge per subscriber is the common case; the worker reissues if needed.
CREATE INDEX verification_challenges_subscriber_idx ON verification_challenges (subscriber_id);
CREATE INDEX verification_challenges_open_idx ON verification_challenges (subscriber_id) WHERE consumed_at IS NULL;

ALTER TABLE verification_challenges ENABLE ROW LEVEL SECURITY;

-- Tenant-scoped read (same pattern as verification_results, 0039). Writes are service-role only
-- (the worker / click route use the service client, which bypasses RLS); the click route looks tokens
-- up by the unique token, never by tenant, so no broad anon policy is granted.
CREATE POLICY "verification_challenges_tenant"
  ON verification_challenges FOR ALL TO authenticated
  USING (tenant_id = (auth.jwt() ->> 'tenant_id')::uuid);
