-- 0047_crm_reconcile_watermark.sql
-- LYCERT_BRIDGE_ARCHITECTURE.md Part 6.6 M2: nightly reconcile needs a per-connection watermark
-- ("search lastmodifieddate > last_reconcile_at") to catch anything a missed/failed webhook didn't
-- deliver. NULL means "never reconciled" -> the reconcile worker treats it as epoch/unbounded on first run.

ALTER TABLE crm_connections ADD COLUMN last_reconcile_at timestamptz;
