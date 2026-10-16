-- 0035: V3 waterfall providers (LYCERT_WATERFALL_ENRICHMENT_V3.md Part 3).
--
-- NOTE ON NUMBERING: the V3 spec labelled this `0025_v3_providers.sql`, written against the dormant
-- Python engine's V2 numbering (0021–0024). The live repo is already at 0034, so this is 0035. Column
-- set verified live against enrichment_providers (2026-06-23) — matches the spec's INSERT exactly.
--
-- Adds three EU/GDPR-native providers with testable free tiers (Findymail/Icypeas/Dropcontact) to fix
-- the measured international + personal/academic gap, demotes Datagma (refuses personal/edu domains),
-- and registers Clay as a disabled FUTURE/Enterprise row (not built in V3).
--
-- POSITIONS HERE ARE THE HYPOTHESIS (Part 2.1). The benchmark (Part 8.2) is the verdict — final
-- default_position / min_priority get re-set from MEASURED data and recorded in DECISIONS.md.
--
-- Idempotent (ON CONFLICT on the UNIQUE provider_key) so it is safe to apply to staging AND prod.

-- New registry rows.
insert into public.enrichment_providers
  (provider_key, display_name, provider_type, execution_mode, enabled,
   default_position, cost_per_success_usd, returns_education, returns_employment_dates, notes)
values
  ('findymail',  'Findymail',  'enrichment', 'sync',  true,  2, null, false, false,
   'Reverse email->profile. 2 credits with_profile. EU/GDPR. Sync. Education/dates not in core response -> PARTIAL by default.'),
  ('icypeas',    'Icypeas',    'enrichment', 'async', true,  3, null, false, false,
   'Reverse lookup 10 credits. Poll-based async (submit -> bulk-single). EU. Gate to priority>=40.'),
  ('dropcontact','Dropcontact','enrichment', 'async', true,  4, null, false, false,
   'Name+company->email/profile (NOT reverse-email). Async batch poll (v1/enrich/all). EU-strong. Charge-on-success.'),
  ('clay',       'Clay',       'enrichment', 'async', false, 7, null, false, false,
   'FUTURE/Enterprise only - not built in V3. Webhook source + HTTP-API return. 50k/webhook cap off-Enterprise.')
on conflict (provider_key) do update set
  display_name             = excluded.display_name,
  provider_type            = excluded.provider_type,
  execution_mode           = excluded.execution_mode,
  enabled                  = excluded.enabled,
  default_position         = excluded.default_position,
  returns_education        = excluded.returns_education,
  returns_employment_dates = excluded.returns_employment_dates,
  notes                    = excluded.notes,
  updated_at               = now();

-- Reposition existing providers to make room: pdl 4->5, fullenrich 5->6.
update public.enrichment_providers set default_position = 5, updated_at = now() where provider_key = 'pdl';
update public.enrichment_providers set default_position = 6, updated_at = now() where provider_key = 'fullenrich';

-- Demote Datagma (confirmed: refuses personal/edu domains). Disabled + parked out of the active range.
update public.enrichment_providers set
  enabled = false, default_position = 21,
  notes = 'DEMOTED: refuses personal/edu domains (confirmed Run 3, 400 "not accepted"). Re-enable per-tenant for corporate verticals only.',
  updated_at = now()
where provider_key = 'datagma';

-- Park the other disabled legacy providers out of the active 1..7 band so positions don't collide
-- (both remain enabled=false, so they never enter the cascade; this is cleanliness only).
update public.enrichment_providers set default_position = 20, updated_at = now() where provider_key = 'reversecontact';
update public.enrichment_providers set default_position = 22, updated_at = now() where provider_key = 'apollo';

-- Per-provider priority gate: some providers only run for high-priority subscribers (expensive credits).
alter table public.enrichment_providers add column if not exists min_priority integer not null default 0;
update public.enrichment_providers set min_priority = 40 where provider_key in ('icypeas', 'fullenrich');

-- Per-provider input requirement: some providers can't run from a bare email (need name + company/domain).
alter table public.enrichment_providers add column if not exists requires_name_company boolean not null default false;
update public.enrichment_providers set requires_name_company = true where provider_key = 'dropcontact';

-- Merge trust ordering (Part 5 clarification 1): higher trust wins on conflicting employment data.
alter table public.enrichment_providers add column if not exists trust_rank integer not null default 50;
update public.enrichment_providers set trust_rank = 90 where provider_key = 'pdl';
update public.enrichment_providers set trust_rank = 85 where provider_key = 'dropcontact';
update public.enrichment_providers set trust_rank = 75 where provider_key = 'hunter';
update public.enrichment_providers set trust_rank = 70 where provider_key in ('findymail', 'icypeas', 'reversecontact', 'datagma');
update public.enrichment_providers set trust_rank = 50 where provider_key = 'fullenrich';  -- high error rate (independent benchmark)

comment on column public.enrichment_providers.min_priority is
  'Cascade gate: provider only runs when subscriber enrichment_priority >= this (expensive providers gated, e.g. Icypeas/FullEnrich = 40). V3 Part 1.2.';
comment on column public.enrichment_providers.requires_name_company is
  'Cascade gate: provider needs a name AND company/domain signal (cannot run from a bare email, e.g. Dropcontact). V3 Part 1.3.';
comment on column public.enrichment_providers.trust_rank is
  'Merge trust for conflicting employment data, high wins (PDL 90 > Dropcontact 85 > specialists 70 > FullEnrich 50). V3 Part 5.';
