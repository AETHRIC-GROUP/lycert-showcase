-- 001_test_tenant.sql
-- Staging seed data only. NEVER apply to production.
-- Creates: Acme Software tenant, owner user, default configs, 10 synthetic subscribers.

-- ── Test tenant ───────────────────────────────────────────────────────────────
INSERT INTO tenants (id, name, slug, plan_tier, dpa_signed_at, dpa_signed_by, onboarding_complete)
VALUES (
  '00000000-0000-0000-0000-000000000001',
  'Acme Software',
  'acme-software',
  'pro',
  now(),
  'Jane Smith (DPA signed for staging test)',
  true
);

-- ── Default scoring config ─────────────────────────────────────────────────────
INSERT INTO tenant_scoring_config (tenant_id)
VALUES ('00000000-0000-0000-0000-000000000001');
-- Uses all column defaults (CEDS baseline weights)

-- ── Default brand config ───────────────────────────────────────────────────────
INSERT INTO tenant_brand_config (tenant_id, sender_name, sender_email, reply_to_email)
VALUES (
  '00000000-0000-0000-0000-000000000001',
  'Acme Software Licensing Team',
  'licensing@acme-test.com',
  'licensing@acme-test.com'
);

-- ── Canonical field mappings (partner/Zuora column names) ────────────────────────
-- Generic example field mappings for Acme Software (fictional test tenant).
-- Real tenants configure their own column names during onboarding via the column mapping UI.
-- client_field_name reflects what the client calls their column; canonical_field is Lycert's standard name.
INSERT INTO tenant_field_mappings (tenant_id, canonical_field, client_field_name, notes) VALUES
  ('00000000-0000-0000-0000-000000000001', 'external_id',             'subscriber_id',          'Client billing system ID'),
  ('00000000-0000-0000-0000-000000000001', 'renewal_delta_days',      'days_since_renewal',     'Negative = renewed after qualification end date'),
  ('00000000-0000-0000-0000-000000000001', 'stated_graduation_date',  'graduation_date',        NULL),
  ('00000000-0000-0000-0000-000000000001', 'proof_submission_date',   'proof_date',             NULL),
  ('00000000-0000-0000-0000-000000000001', 'subscription_start_date', 'sub_start',              NULL),
  ('00000000-0000-0000-0000-000000000001', 'subscription_end_date',   'sub_end',                NULL),
  ('00000000-0000-0000-0000-000000000001', 'email',                   'email',                  NULL),
  ('00000000-0000-0000-0000-000000000001', 'subscriber_name',         'full_name',              NULL),
  ('00000000-0000-0000-0000-000000000001', 'account_name',            'account_name',           NULL),
  ('00000000-0000-0000-0000-000000000001', 'plan_name',               'plan_name',              NULL),
  ('00000000-0000-0000-0000-000000000001', 'institution_name',        'institution',            NULL),
  ('00000000-0000-0000-0000-000000000001', 'institution_location',    'institution_location',   'City, Country format'),
  ('00000000-0000-0000-0000-000000000001', 'account_country',         'country',                NULL);

-- ── 10 synthetic subscribers (covers all lifecycle stages and tier distributions) ──

INSERT INTO subscribers (
  tenant_id, external_id, email, name, account_name, account_country,
  institution_name, institution_location, stated_graduation_date, plan_name, plan_type,
  subscription_start_date, subscription_end_date, days_before_last_renewal, lifecycle_stage
) VALUES

-- 1. Tier 1 candidate: graduated 18 months ago, renewed after graduation
(
  '00000000-0000-0000-0000-000000000001',
  'EXT-001', 'alex.johnson@gmail.com', 'Alex Johnson',
  'Alex Johnson', 'United States',
  'State University', 'New York, United States',
  (current_date - interval '18 months')::date, 'EDU Annual', 'edu',
  (current_date - interval '3 years')::date,
  (current_date + interval '3 months')::date,
  -410, 'flagged_review'
),

-- 2. Tier 1 candidate: graduated 1 year ago, using personal email, institution = account name
(
  '00000000-0000-0000-0000-000000000001',
  'EXT-002', 'maria.garcia@hotmail.com', 'Maria Garcia',
  'Maria Garcia', 'Spain',
  'Maria Garcia', 'Madrid, Spain',
  (current_date - interval '12 months')::date, 'EDU Annual', 'edu',
  (current_date - interval '2 years')::date,
  (current_date + interval '1 month')::date,
  -200, 'flagged_review'
),

-- 3. Tier 2 candidate: graduated 8 months ago, renewed after graduation
(
  '00000000-0000-0000-0000-000000000001',
  'EXT-003', 'john.smith@gmail.com', 'John Smith',
  'Smith Architecture', 'United Kingdom',
  'University of Manchester', 'Manchester, United Kingdom',
  (current_date - interval '8 months')::date, 'EDU Annual', 'edu',
  (current_date - interval '2 years')::date,
  (current_date + interval '4 months')::date,
  -90, 'post_graduation_unverified'
),

-- 4. Tier 3 / Watch List: approaching 1 year post-graduation, long subscription
(
  '00000000-0000-0000-0000-000000000001',
  'EXT-004', 'priya.patel@yahoo.com', 'Priya Patel',
  'Patel Designs', 'India',
  'IIT Bombay', 'Mumbai, India',
  (current_date - interval '5 months')::date, 'EDU Annual', 'edu',
  (current_date - interval '3 years')::date,
  (current_date + interval '6 months')::date,
  30, 'post_graduation_unverified'
),

-- 5. Likely Clean: currently a student, academic email, graduating in future
(
  '00000000-0000-0000-0000-000000000001',
  'EXT-005', 'emily.chen@student.tue.nl', 'Emily Chen',
  'Emily Chen', 'Netherlands',
  'TU Eindhoven', 'Eindhoven, Netherlands',
  (current_date + interval '8 months')::date, 'EDU Annual', 'edu',
  (current_date - interval '1 year')::date,
  (current_date + interval '8 months')::date,
  200, 'active_student'
),

-- 6. Approaching graduation: 45 days away
(
  '00000000-0000-0000-0000-000000000001',
  'EXT-006', 'luca.rossi@polimi.it', 'Luca Rossi',
  'Luca Rossi', 'Italy',
  'Politecnico di Milano', 'Milan, Italy',
  (current_date + interval '45 days')::date, 'EDU Annual', 'edu',
  (current_date - interval '18 months')::date,
  (current_date + interval '45 days')::date,
  150, 'approaching_graduation'
),

-- 7. Post-graduation unverified: 120 days post, no enrichment yet
(
  '00000000-0000-0000-0000-000000000001',
  'EXT-007', 'sophie.mueller@gmail.com', 'Sophie Müller',
  'Sophie Müller', 'Germany',
  'TU Berlin', 'Berlin, Germany',
  (current_date - interval '4 months')::date, 'EDU Annual', 'edu',
  (current_date - interval '2 years')::date,
  (current_date + interval '8 months')::date,
  -10, 'post_graduation_unverified'
),

-- 8. Converted: previously flagged, upgraded to commercial
(
  '00000000-0000-0000-0000-000000000001',
  'EXT-008', 'carlos.mendez@studio-mx.com', 'Carlos Mendez',
  'Studio MX', 'Mexico',
  'UNAM', 'Mexico City, Mexico',
  (current_date - interval '2 years')::date, 'EDU Annual', 'edu',
  (current_date - interval '4 years')::date,
  (current_date - interval '1 month')::date,
  -500, 'converted'
),

-- 9. Re-verification pending: replied to re-verification email
(
  '00000000-0000-0000-0000-000000000001',
  'EXT-009', 'anna.kowalski@pw.edu.pl', 'Anna Kowalski',
  'Anna Kowalski', 'Poland',
  'Warsaw University of Technology', 'Warsaw, Poland',
  (current_date - interval '2 months')::date, 'EDU Annual', 'edu',
  (current_date - interval '2 years')::date,
  (current_date + interval '10 months')::date,
  60, 're_verification_pending'
),

-- 10. Active student: mid-program, clean profile
(
  '00000000-0000-0000-0000-000000000001',
  'EXT-010', 'james.okafor@ucl.ac.uk', 'James Okafor',
  'James Okafor', 'United Kingdom',
  'University College London', 'London, United Kingdom',
  (current_date + interval '14 months')::date, 'EDU Annual', 'edu',
  (current_date - interval '6 months')::date,
  (current_date + interval '6 months')::date,
  180, 'active_student'
);
