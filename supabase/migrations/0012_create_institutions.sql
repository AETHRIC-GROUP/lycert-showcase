-- 0012_create_institutions.sql
-- Proprietary institution trust database. Global (no tenant_id) — shared across all tenants.
-- Populated from IPEDS, HESA, GitHub Education list, Wikidata, and client submissions.

CREATE TABLE institutions (
  id                   uuid             PRIMARY KEY DEFAULT gen_random_uuid(),
  name                 text             NOT NULL,
  country              text,
  domain               text,
  trust_tier           trust_tier       NOT NULL DEFAULT 'medium',
  institution_type     institution_type NOT NULL DEFAULT 'unknown',
  accreditation_status text,
  degree_granting      boolean          NOT NULL DEFAULT false,
  ipeds_id             text,
  hesa_id              text,
  source               text             NOT NULL DEFAULT 'manual',
  -- Values: 'github_edu_list' | 'ipeds' | 'hesa' | 'wikidata' | 'manual' | 'client_submission'
  abuse_flag_count     integer          NOT NULL DEFAULT 0,
  created_at           timestamptz      NOT NULL DEFAULT now(),
  updated_at           timestamptz      NOT NULL DEFAULT now()
);

CREATE INDEX idx_institutions_domain  ON institutions(domain);
CREATE INDEX idx_institutions_name    ON institutions(name);
CREATE INDEX idx_institutions_country ON institutions(country);

-- RLS: institutions table is global/read-only for authenticated users. No tenant isolation needed.
ALTER TABLE institutions ENABLE ROW LEVEL SECURITY;

CREATE POLICY "institutions_read_all"
  ON institutions FOR SELECT TO authenticated
  USING (true);

-- Only service_role (system) can insert/update/delete institutions
-- No INSERT/UPDATE/DELETE policy for authenticated = they are blocked

CREATE TRIGGER institutions_updated_at
  BEFORE UPDATE ON institutions
  FOR EACH ROW EXECUTE FUNCTION set_updated_at();
