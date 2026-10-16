# supabase

PostgreSQL schema for Lycert as ordered, immutable migrations. A migration is never edited after it has run.
Every change is a new file.

## Rules the schema follows

- **Row-level security on every table**, enabled in the migration that creates it. Policies scope access to
  the caller's tenant, read from the JWT. The custom access-token hook (`0016`) places the tenant and
  application role into the token.
- **Append-only history.** `audit_logs` and `subscriber_scores` are never updated in place.
- **Explicit foreign keys** with stated `ON DELETE` behavior, `timestamptz` for every timestamp, and no
  nullable booleans.
- **Secrets stay out of tables and cron definitions.** Scheduled jobs read their credentials from Supabase
  Vault at run time.

## Migration map

| Range | Area |
|---|---|
| `0001`–`0017` | Core platform: enums, tenants and users, scoring and brand config, subscribers, enrichment, scores, cases and comments, audit log, institutions, sub-processor registry, field mappings, integrations, auth hook fix, Stripe billing |
| `0018`–`0023` | Pre-enrichment columns, enrichment jobs, employer enrichment, budgets |
| `0024`–`0036` | Enrichment waterfall: provider registry, per-tenant cascade config, field provenance, email validation, pgmq queue runtime, academic domains, soft delete, async provider references, additional provider registration |
| `0037`–`0045` | Verification layer: providers, consents, results, subscriber status, queue, email challenges, document storage (private bucket), job completion, sub-processors |
| `0046`–`0047` | HubSpot connector: connections, contact links, sync runs, `crm_sync_q`, reconcile watermark |

## Applying

```bash
supabase link --project-ref <your-project-ref>
supabase db push
```

The queue migrations need the `pgmq`, `pg_cron` and `pg_net` extensions, which are available on Supabase.
The `pg_cron` schedules that invoke the workers are created per environment, because they need that
environment's URL and secret. They are deliberately not part of the migrations.

`seed/` contains synthetic staging data only: a test tenant, fictional subscribers, and an academic-domain
seed list. It is never applied to production.
