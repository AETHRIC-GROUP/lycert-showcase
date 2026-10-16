-- 0030_enrichment_queue_runtime.sql
-- ENGINE_CONSOLIDATION_PLAN.md — job execution architecture (Supabase Queues / pgmq).
-- Enables pgmq + pg_cron + pg_net, creates the enrichment + scoring queues and their dead-letter
-- queues, and exposes SECURITY DEFINER `public.q_*` wrappers so the Node worker (Vercel route,
-- invoked by pg_cron via pg_net) can read/archive/enqueue over PostgREST RPC. The pgmq schema is
-- not exposed to PostgREST, so these wrappers are the controlled surface.

CREATE EXTENSION IF NOT EXISTS pgmq;
CREATE EXTENSION IF NOT EXISTS pg_net;
CREATE EXTENSION IF NOT EXISTS pg_cron;

-- Queues (idempotent across re-runs).
SELECT pgmq.create('enrichment_jobs_q') WHERE NOT EXISTS (SELECT 1 FROM pgmq.list_queues() WHERE queue_name = 'enrichment_jobs_q');
SELECT pgmq.create('scoring_q')         WHERE NOT EXISTS (SELECT 1 FROM pgmq.list_queues() WHERE queue_name = 'scoring_q');
SELECT pgmq.create('enrichment_dlq')    WHERE NOT EXISTS (SELECT 1 FROM pgmq.list_queues() WHERE queue_name = 'enrichment_dlq');
SELECT pgmq.create('scoring_dlq')       WHERE NOT EXISTS (SELECT 1 FROM pgmq.list_queues() WHERE queue_name = 'scoring_dlq');

-- ── Controlled RPC surface for the worker (service role only) ──────────────────

-- Enqueue: p_msgs is a JSON array; each element becomes one message.
CREATE OR REPLACE FUNCTION public.q_send(p_queue text, p_msgs jsonb)
RETURNS SETOF bigint
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pgmq, public AS $$
BEGIN
  RETURN QUERY
  SELECT pgmq.send(p_queue, elem)
  FROM jsonb_array_elements(coalesce(p_msgs, '[]'::jsonb)) elem;
END;
$$;

-- Read up to p_qty messages, hidden for p_vt seconds (visibility timeout).
CREATE OR REPLACE FUNCTION public.q_read(p_queue text, p_qty int, p_vt int)
RETURNS TABLE (msg_id bigint, read_ct int, enqueued_at timestamptz, vt timestamptz, message jsonb)
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pgmq, public AS $$
BEGIN
  RETURN QUERY SELECT r.msg_id, r.read_ct, r.enqueued_at, r.vt, r.message
  FROM pgmq.read(p_queue, p_vt, p_qty) r;
END;
$$;

CREATE OR REPLACE FUNCTION public.q_archive(p_queue text, p_msg_id bigint)
RETURNS boolean LANGUAGE sql SECURITY DEFINER SET search_path = pgmq, public AS $$
  SELECT pgmq.archive(p_queue, p_msg_id);
$$;

CREATE OR REPLACE FUNCTION public.q_delete(p_queue text, p_msg_id bigint)
RETURNS boolean LANGUAGE sql SECURITY DEFINER SET search_path = pgmq, public AS $$
  SELECT pgmq.delete(p_queue, p_msg_id);
$$;

-- Move a message to a dead-letter queue: send to DLQ, then archive from the source.
CREATE OR REPLACE FUNCTION public.q_to_dlq(p_from text, p_dlq text, p_msg_id bigint, p_msg jsonb)
RETURNS bigint LANGUAGE plpgsql SECURITY DEFINER SET search_path = pgmq, public AS $$
DECLARE new_id bigint;
BEGIN
  new_id := pgmq.send(p_dlq, p_msg);
  PERFORM pgmq.archive(p_from, p_msg_id);
  RETURN new_id;
END;
$$;

-- Queue depth (for dashboard observability).
CREATE OR REPLACE FUNCTION public.q_metrics()
RETURNS TABLE (queue_name text, queue_length bigint)
LANGUAGE sql SECURITY DEFINER SET search_path = pgmq, public AS $$
  SELECT m.queue_name, m.queue_length FROM pgmq.metrics_all() m;
$$;

REVOKE ALL ON FUNCTION public.q_send(text, jsonb), public.q_read(text, int, int),
  public.q_archive(text, bigint), public.q_delete(text, bigint),
  public.q_to_dlq(text, text, bigint, jsonb), public.q_metrics() FROM public, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.q_send(text, jsonb), public.q_read(text, int, int),
  public.q_archive(text, bigint), public.q_delete(text, bigint),
  public.q_to_dlq(text, text, bigint, jsonb), public.q_metrics() TO service_role;

-- NOTE: the pg_cron schedules that ping the worker routes (via pg_net) are created in a later
-- migration once the worker URL + shared secret are configured per environment, to avoid baking a
-- placeholder URL into schema. See ENGINE_CONSOLIDATION_PLAN.md rollout.
