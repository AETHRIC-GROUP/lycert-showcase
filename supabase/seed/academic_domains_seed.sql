-- academic_domains_seed.sql
-- Seeds public.academic_domains from the Hipo university-domains-list. Idempotent (ON CONFLICT DO
-- NOTHING) and re-runnable to pick up upstream updates. Fetches + parses the dataset server-side via
-- the `http` extension so the ~10.5k rows never have to be shipped row-by-row from a client.
--
-- Run against STAGING via the Supabase MCP execute_sql (or `npx supabase db query -f <this> --linked`).
-- One row per lowercased base domain; single-label / public-suffix-only tokens are dropped on ingest.

create extension if not exists http with schema extensions;
select extensions.http_set_curlopt('CURLOPT_TIMEOUT_MS', '30000');

with resp as (
  select content from extensions.http_get(
    'https://raw.githubusercontent.com/Hipo/university-domains-list/master/world_universities_and_domains.json')
),
parsed as (
  select distinct on (domain)
    domain,
    e->>'name'               as name,
    nullif(e->>'country', '') as country
  from resp,
       lateral jsonb_array_elements(resp.content::jsonb) e,
       lateral jsonb_array_elements_text(e->'domains') as d(dom),
       lateral (select lower(trim(d.dom)) as domain) n
  where position('.' in n.domain) > 0       -- must contain a dot
    and split_part(n.domain, '.', 1) <> ''  -- no leading-dot / empty first label
  order by domain, e->>'name'
)
insert into academic_domains (domain, name, country, source)
select domain, name, country, 'hipo' from parsed
on conflict (domain) do nothing;
