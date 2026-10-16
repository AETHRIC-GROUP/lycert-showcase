-- 0041_verification_queue.sql
-- LYCERT_VERIFICATION_ARCHITECTURE.md Part 9.1.3 / Part 9.2 step 2: the verification waterfall rides the
-- SAME consolidated Supabase Queue (pgmq) infrastructure as enrichment — NOT a new runtime. This adds the
-- verification queue + its dead-letter queue alongside the enrichment/scoring queues (0030). The generic
-- public.q_* SECURITY DEFINER wrappers from 0030 already operate on any queue name, so no new RPC surface
-- is needed — the Node verification worker reuses q_send / q_read / q_archive / q_to_dlq.
--
-- STAGING-ONLY for now (Joshua's "wait to push verification to prod" override; on the 0024→0042 prod
-- ledger for the gated prod-activation step, together with 0037–0040).

-- pgmq is already enabled by 0030; CREATE EXTENSION is idempotent and harmless if re-run.
CREATE EXTENSION IF NOT EXISTS pgmq;

-- Queues (idempotent across re-runs).
SELECT pgmq.create('verification_q')   WHERE NOT EXISTS (SELECT 1 FROM pgmq.list_queues() WHERE queue_name = 'verification_q');
SELECT pgmq.create('verification_dlq') WHERE NOT EXISTS (SELECT 1 FROM pgmq.list_queues() WHERE queue_name = 'verification_dlq');
