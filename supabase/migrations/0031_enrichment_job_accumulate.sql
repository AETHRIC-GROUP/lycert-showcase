-- 0031_enrichment_job_accumulate.sql
-- ENGINE_CONSOLIDATION_PLAN.md — worker job accounting.
-- enrichment_jobs.per_provider_stats + counters are written by every message in a job. Concurrent
-- worker chunks (overlapping cron invocations) would clobber each other on a read-modify-write in
-- the app. This SECURITY DEFINER function does the accumulate atomically in one UPDATE so the worker
-- never has to read-then-write the shared row.
--
-- p_stats shape: {"hunter":{"attempts":3,"hits":1,"cost_usd":0.012}, ...}. Each provider's
-- attempts/hits/cost_usd are ADDED to whatever is already on the row (deep numeric merge).

CREATE OR REPLACE FUNCTION public.q_job_accumulate(
  p_job_id        uuid,
  p_stats         jsonb DEFAULT '{}'::jsonb,
  p_success       int   DEFAULT 0,
  p_miss          int   DEFAULT 0,
  p_error         int   DEFAULT 0,
  p_low_quality   int   DEFAULT 0,
  p_pdl_credits   int   DEFAULT 0,
  p_cost          numeric DEFAULT 0,
  p_async_pending int   DEFAULT 0
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
    async_pending_count  = async_pending_count + p_async_pending
  WHERE id = p_job_id;
END;
$$;

REVOKE ALL ON FUNCTION public.q_job_accumulate(uuid, jsonb, int, int, int, int, int, numeric, int)
  FROM public, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.q_job_accumulate(uuid, jsonb, int, int, int, int, int, numeric, int)
  TO service_role;
