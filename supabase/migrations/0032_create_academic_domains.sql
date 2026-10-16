-- 0032_create_academic_domains.sql
-- Global academic-domain reference set (no tenant_id) used to resolve the "false-corporate" case:
-- when a subscriber's email domain does NOT match the PDL School Cleaner's resolved institution
-- domain (a known cleaner mis-resolution, e.g. campus.ul.pt submitted but PDL returns up.pt), we
-- check whether the email's OWN domain is a known academic domain. Presence — not name similarity —
-- is the verification key, which sidesteps the fuzzy-match failure mode of PDL school/clean.
--
-- Seeded from the Hipo `university-domains-list` (https://github.com/Hipo/university-domains-list),
-- one row per lowercased base domain. See supabase/seed/academic_domains_seed.sql for the loader.

CREATE TABLE academic_domains (
  domain     text        PRIMARY KEY,   -- lowercased base/registrable domain (or known academic subdomain)
  name       text        NOT NULL,      -- institution name from the source dataset
  country    text,                      -- country from the source dataset (authoritative for B3)
  source     text        NOT NULL DEFAULT 'hipo',
  created_at timestamptz NOT NULL DEFAULT now()
);

-- The PRIMARY KEY on domain is the lookup index: pre-enrichment queries `WHERE domain = ANY($candidates)`
-- with an exact-equality candidate list computed in TS (campus.ul.pt -> [campus.ul.pt, ul.pt]).

-- RLS: enabled with NO policy. The pre-enrichment lookup runs server-side via the service role
-- (which bypasses RLS), exactly like the pre-enrich batch route. No authenticated/anon access.
ALTER TABLE academic_domains ENABLE ROW LEVEL SECURITY;
