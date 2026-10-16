-- 0010_create_case_comments.sql

CREATE TABLE case_comments (
  id         uuid        PRIMARY KEY DEFAULT gen_random_uuid(),
  case_id    uuid        NOT NULL REFERENCES cases(id) ON DELETE CASCADE,
  tenant_id  uuid        NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  author_id  uuid        NOT NULL REFERENCES tenant_users(id) ON DELETE CASCADE,
  body       text        NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX idx_case_comments_case ON case_comments(case_id, created_at);

-- RLS
ALTER TABLE case_comments ENABLE ROW LEVEL SECURITY;

CREATE POLICY "case_comments_tenant_isolation"
  ON case_comments FOR ALL TO authenticated
  USING (tenant_id = (auth.jwt() ->> 'tenant_id')::uuid)
  WITH CHECK (tenant_id = (auth.jwt() ->> 'tenant_id')::uuid);
