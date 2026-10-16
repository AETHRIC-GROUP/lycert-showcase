-- 0013_create_sub_processor_registry.sql
-- Documents all third-party services processing personal data.
-- Required for GDPR Article 28 compliance. Global (Lycert-managed, not per-tenant).

CREATE TABLE sub_processor_registry (
  id                  uuid        PRIMARY KEY DEFAULT gen_random_uuid(),
  name                text        NOT NULL,
  purpose             text        NOT NULL,
  data_categories     text        NOT NULL,
  country             text        NOT NULL,
  transfer_mechanism  text,
  dpa_signed_at       timestamptz,
  dpa_document_url    text,
  active              boolean     NOT NULL DEFAULT true,
  created_at          timestamptz NOT NULL DEFAULT now(),
  updated_at          timestamptz NOT NULL DEFAULT now()
);

-- RLS: read-only for authenticated users (Lycert-managed data)
ALTER TABLE sub_processor_registry ENABLE ROW LEVEL SECURITY;

CREATE POLICY "sub_processor_registry_read_all"
  ON sub_processor_registry FOR SELECT TO authenticated
  USING (true);

CREATE TRIGGER sub_processor_registry_updated_at
  BEFORE UPDATE ON sub_processor_registry
  FOR EACH ROW EXECUTE FUNCTION set_updated_at();

-- Seed with known sub-processors
INSERT INTO sub_processor_registry (name, purpose, data_categories, country, transfer_mechanism, active) VALUES
  ('Supabase Inc.',    'Database hosting and authentication',                          'All personal data',                                     'United States', 'Standard Contractual Clauses (SCCs)', true),
  ('Vercel Inc.',      'Frontend hosting and CDN',                                     'IP address, session data',                              'United States', 'Standard Contractual Clauses (SCCs)', true),
  ('Railway Corp.',    'Backend API hosting',                                          'All personal data processed by the API',                'United States', 'Standard Contractual Clauses (SCCs)', true),
  ('Anthropic PBC',   'AI explanation generation for compliance cases',               'Subscriber profile data (anonymised where possible)',   'United States', 'Standard Contractual Clauses (SCCs)', true),
  ('Resend Inc.',      'Transactional email delivery',                                 'Name, email address',                                   'United States', 'Standard Contractual Clauses (SCCs)', false),
  ('Stripe Inc.',      'Billing and payment processing',                               'Billing contact data',                                  'United States', 'Standard Contractual Clauses (SCCs)', false),
  ('Cloudflare Inc.',  'DNS, CDN, and DDoS protection',                               'IP address',                                            'United States', 'Standard Contractual Clauses (SCCs)', true);
-- Clay and PDL added when integrations are connected (Phase 2)
