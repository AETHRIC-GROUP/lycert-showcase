-- 0044_enrichment_job_completion.sql
-- V2 carry-over: the job-completion lifecycle. /api/enrichment/enqueue creates jobs as status='running'
-- and failJob sets 'failed' on DLQ, but nothing ever set 'completed' — so the dashboard MTD spend
-- (which filters status='completed') never surfaced the atomically-merged per_provider_stats.
--
-- Fix (NEXT_STEPS "always-called processed-count increment" option): every handled queue message ticks
-- processed_count via q_job_accumulate, which flips the job to 'completed' once processed >= total.
-- Completion deliberately does NOT wait on async_pending_count: the FullEnrich timeout sweep can't
-- decrement it (a timed-out row carries no job id), so gating on it would deadlock; late async merges
-- simply keep accumulating stats onto the completed row (spend stays accurate).
--
-- STAGING-ONLY (prod lacks the entire 0024+ enrichment chain; on the 0024→0044 prod-promotion ledger).

ALTER TABLE enrichment_jobs ADD COLUMN IF NOT EXISTS processed_count int NOT NULL DEFAULT 0;

-- Replace (not overload) the accumulate function: a second signature would make PostgREST rpc calls
-- that omit optional args ambiguous.
DROP FUNCTION IF EXISTS public.q_job_accumulate(uuid, jsonb, int, int, int, int, int, numeric, int);

CREATE OR REPLACE FUNCTION public.q_job_accumulate(
  p_job_id        uuid,
  p_stats         jsonb DEFAULT '{}'::jsonb,
  p_success       int   DEFAULT 0,
  p_miss          int   DEFAULT 0,
  p_error         int   DEFAULT 0,
  p_low_quality   int   DEFAULT 0,
  p_pdl_credits   int   DEFAULT 0,
  p_cost          numeric DEFAULT 0,
  p_async_pending int   DEFAULT 0,
  p_processed     int   DEFAULT 0
)
RETURNS void
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE
  merged jsonb;
  k text;
  v jsonb;
  existing jsonb;
BEGIN
  SELECT coalesce(per_provider_stats, '{}'::jsonb) INTO merged
  FROM enrichment_jobs WHERE id = p_job_id FOR UPDATE;
  IF merged IS NULL THEN
    RETURN; -- job row gone; nothing to accumulate
  END IF;

  FOR k, v IN SELECT * FROM jsonb_each(coalesce(p_stats, '{}'::jsonb)) LOOP
    existing := coalesce(merged -> k, '{}'::jsonb);
    merged := jsonb_set(merged, ARRAY[k], jsonb_build_object(
      'attempts', coalesce((existing ->> 'attempts')::numeric, 0) + coalesce((v ->> 'attempts')::numeric, 0),
      'hits',     coalesce((existing ->> 'hits')::numeric, 0)     + coalesce((v ->> 'hits')::numeric, 0),
      'cost_usd', round((coalesce((existing ->> 'cost_usd')::numeric, 0) + coalesce((v ->> 'cost_usd')::numeric, 0))::numeric, 4)
    ));
  END LOOP;

  UPDATE enrichment_jobs SET
    per_provider_stats   = merged,
    success_count        = success_count + p_success,
    miss_count           = miss_count + p_miss,
    error_count          = error_count + p_error,
    low_quality_count    = low_quality_count + p_low_quality,
    pdl_credits_consumed = pdl_credits_consumed + p_pdl_credits,
    estimated_cost_usd   = coalesce(estimated_cost_usd, 0) + p_cost,
    async_pending_count  = async_pending_count + p_async_pending,
    processed_count      = processed_count + p_processed,
    -- The completion flip: still running + every enqueued subscriber handled → completed. A rare
    -- crash-between-accumulate-and-archive retry can over-tick processed_count; that only flips the
    -- status a message early and never corrupts the money counters above.
    status       = CASE WHEN status = 'running' AND processed_count + p_processed >= total_count
                        THEN 'completed' ELSE status END,
    completed_at = CASE WHEN status = 'running' AND processed_count + p_processed >= total_count
                        THEN coalesce(completed_at, now()) ELSE completed_at END
  WHERE id = p_job_id;
END;
$$;

REVOKE ALL ON FUNCTION public.q_job_accumulate(uuid, jsonb, int, int, int, int, int, numeric, int, int)
  FROM public, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.q_job_accumulate(uuid, jsonb, int, int, int, int, int, numeric, int, int)
  TO service_role;

-- One-time repair: jobs stuck 'running' from before this fix (their queues drained long ago — the
-- 2026-06-21 live batch among them). Anything still 'running' after 24h is stale by construction
-- (queue drains in minutes; the async backstop ceiling is 24h).
UPDATE enrichment_jobs
SET status = 'completed',
    completed_at = coalesce(completed_at, started_at + interval '24 hours'),
    processed_count = total_count
WHERE status = 'running'
  AND started_at < now() - interval '24 hours';
