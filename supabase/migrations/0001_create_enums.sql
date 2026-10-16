-- 0001_create_enums.sql
-- All PostgreSQL enums used across the schema. Create these before any tables.

CREATE TYPE plan_tier AS ENUM ('starter', 'growth', 'pro', 'enterprise');

CREATE TYPE user_role AS ENUM ('owner', 'admin', 'manager', 'reviewer', 'viewer');

CREATE TYPE plan_type AS ENUM ('edu', 'nonprofit', 'startup', 'government');

CREATE TYPE lifecycle_stage AS ENUM (
  'active_student',
  'approaching_graduation',
  'post_graduation_unverified',
  're_verification_pending',
  'converted',
  'churned',
  'flagged_review',
  'dismissed'
);

CREATE TYPE enrichment_provider AS ENUM ('clay', 'pdl', 'apollo');

CREATE TYPE data_confidence_level AS ENUM ('high', 'medium', 'low');

CREATE TYPE case_status AS ENUM (
  'pending_review',
  'in_review',
  'approved_for_outreach',
  'dismissed',
  'resolved'
);

CREATE TYPE case_decision AS ENUM (
  'proceed_outreach',
  'dismiss_false_positive',
  'escalate',
  'pending'
);

CREATE TYPE actor_type AS ENUM ('user', 'system', 'api');

CREATE TYPE integration_type AS ENUM (
  'clay', 'pdl', 'apollo',
  'hubspot', 'salesforce',
  'slack', 'teams', 'jira',
  'stripe', 'zuora', 'chargebee'
);

CREATE TYPE integration_status AS ENUM ('connected', 'disconnected', 'error');

CREATE TYPE trust_tier AS ENUM ('high', 'medium', 'low', 'suspicious');

CREATE TYPE institution_type AS ENUM (
  'research_university',
  'teaching_university',
  'community_college',
  'vocational',
  'bootcamp',
  'private_academy',
  'online_only',
  'unknown'
);
