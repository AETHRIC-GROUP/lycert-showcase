-- 0036: poll-based async support for V3 (LYCERT_WATERFALL_ENRICHMENT_V3.md Part 3 / 4.1).
--
-- NOTE ON NUMBERING: the spec labelled this `0026_v3_async_poll.sql` (Python V2 numbering). Repo is at
-- 0035, so this is 0036.
--
-- V2's async path was webhook-only (FullEnrich): columns pending_async_provider + async_reference +
-- async_submitted_at (migration 0034). V3 adds POLL-based async (Icypeas, Dropcontact) which submits a
-- job then polls a result route until terminal.
--
-- DELIBERATE REUSE (not a new synonym): the provider job id continues to live in the EXISTING
-- `async_reference` column for ALL async providers (FullEnrich enrichment_id, Icypeas _id, Dropcontact
-- request_id). The spec proposed a second `async_provider_ref` column; we do NOT add it — one column,
-- one meaning. This migration adds only the genuinely new POLL-scheduling state.
--
-- `pending_async_provider` already records WHICH provider is in flight; `async_provider_mode` records
-- HOW to resolve it ('webhook' vs 'poll') so the poll worker can select only poll-mode rows cheaply
-- without joining the registry on every tick. Single pending slot per row is intentional (one async
-- provider in flight at a time).

alter table public.subscriber_enrichment
  add column if not exists async_provider_mode text,          -- 'webhook' | 'poll' (null when not pending)
  add column if not exists async_next_poll_at  timestamptz,   -- when the poll worker should next poll this row
  add column if not exists async_poll_count    integer not null default 0;  -- polls so far (backoff + give-up)

comment on column public.subscriber_enrichment.async_provider_mode is
  'How the pending async result arrives: webhook (FullEnrich) or poll (Icypeas/Dropcontact). Null when no async is pending. V3 Part 4.1.';
comment on column public.subscriber_enrichment.async_next_poll_at is
  'Poll worker schedule: next time to poll this pending poll-mode row (backoff between polls). V3 Part 4.1.';
comment on column public.subscriber_enrichment.async_poll_count is
  'Number of poll attempts so far for the current pending job — drives backoff and the 24h give-up. V3 Part 4.1.';

-- Partial index for the poll worker''s hot query: due poll-mode rows only.
create index if not exists idx_subscriber_enrichment_async_poll
  on public.subscriber_enrichment (async_next_poll_at)
  where pending_async_provider is not null and async_provider_mode = 'poll';
