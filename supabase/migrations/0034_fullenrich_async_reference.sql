-- 0034: store the FullEnrich async job reference so results can be POLLED as a fallback when the
-- webhook never delivers (e.g. a misconfigured webhook URL — see the 2026-06-21 placeholder incident).
-- Before this, the async path was 100% webhook-dependent with no way to reconcile lost callbacks.
--
-- async_reference     = the provider's async job id (FullEnrich `enrichment_id`).
-- async_submitted_at  = submit time, a precise clock for the poll/timeout sweep that is independent of
--                       enriched_at (which gets refreshed when a result finally merges).
alter table public.subscriber_enrichment
  add column if not exists async_reference text,
  add column if not exists async_submitted_at timestamptz;

comment on column public.subscriber_enrichment.async_reference is
  'Provider async job id (FullEnrich enrichment_id) for the pending async sweep — enables GET-poll reconcile as a fallback to the webhook.';
comment on column public.subscriber_enrichment.async_submitted_at is
  'When the async (FullEnrich) lookup was submitted — poll/timeout clock for the pending sweep.';
