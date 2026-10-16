-- 0017_add_stripe_billing_fields.sql
-- Adds Stripe subscription tracking and enrichment usage metering to tenants.

ALTER TABLE tenants
  ADD COLUMN stripe_subscription_id      text,
  ADD COLUMN stripe_subscription_status  text,
  ADD COLUMN enrichment_credits_used     integer NOT NULL DEFAULT 0,
  ADD COLUMN enrichment_credits_limit    integer,
  ADD COLUMN billing_cycle_start         timestamptz;

COMMENT ON COLUMN tenants.stripe_subscription_status IS
  'Stripe subscription status: active | trialing | past_due | canceled | unpaid | null (no subscription yet)';
COMMENT ON COLUMN tenants.enrichment_credits_limit IS
  'Monthly enrichment cap derived from plan tier. NULL = unlimited (enterprise).';
COMMENT ON COLUMN tenants.billing_cycle_start IS
  'Start of current billing month. enrichment_credits_used resets when this rolls over.';
