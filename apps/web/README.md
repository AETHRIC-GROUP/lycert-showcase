# apps/web

The Lycert application: a Next.js 14 App Router project in strict TypeScript. It serves the dashboard, the
public verification pages, every API route, and the queue workers. It is the platform's only runtime.

## Layout

```
app/
  (auth)/            login, signup, password reset
  (onboarding)/      tenant setup + Data Processing Agreement gate
  (dashboard)/       subscribers, cases, verification review queue, settings, audit log, billing
  (verify)/          public, unauthenticated consent + verification flow (signed link token)
  api/
    crm/             HubSpot OAuth, webhook receiver, segment config, reconcile, worker
    enrichment/      enqueue, worker, FullEnrich webhook + timeout reconcile, provider registry
    scoring/         scoring worker
    verification/    enqueue, worker, consent, email loop, document upload/review/purge
    subscribers/     import, delete, restore
    billing/         Stripe checkout, portal, webhook
components/          UI components (subscribers, cases, verification, integrations)
lib/
  crm/               HubSpot client, OAuth state, webhook signature + event parsing,
                     backfill mapping, diffed write-back, sync worker
  enrichment/        cascade, providers, merge engine, pre-enrichment, queue workers
  scoring/           engine, tier A/B/C signals, field mapper, tenant config, regression fixture
  verification/      orchestrator, providers, consent, link tokens, cadence, document pipeline
  supabase/          server and browser clients
  utils/             CSV parsing, lifecycle helpers
middleware.ts        session refresh + route protection
```

## Conventions

- **Workers are pure, I/O is injected.** Every `worker.ts` is pure orchestration over an interface. The
  matching `worker-io.ts` binds it to Supabase, pgmq and HTTP. Tests use in-memory fakes.
- **Routes never run long jobs.** Workers are invoked by `pg_cron` through `pg_net`, and each one drains one
  bounded chunk. Worker routes are protected by a shared cron secret.
- **Server Components by default.** Client Components only where interaction requires them. Forms use
  react-hook-form with zod.
- **No `any`.** Database types are generated from the schema (`lib/database.types.ts`).
- Tests sit next to the code as `*.test.ts`.

## Commands

```bash
cp .env.local.example .env.local   # Supabase URL + anon key at minimum
npm install
npm run dev          # http://localhost:3000
npm test             # Vitest (335 tests)
npm run type-check   # tsc --noEmit
npm run build        # production build
```

## Configuration

The core app needs only the public Supabase URL and anon key. Each integration activates only when its
credentials are present, and some also need an explicit flag:

| Capability | Requires |
|---|---|
| Enrichment providers | `LYCERT_<PROVIDER>_API_KEY` per provider |
| HubSpot connector | HubSpot app client ID/secret, webhook target URL, encryption key |
| Queue workers | `CRON_SECRET` (shared with the `pg_cron` jobs through Supabase Vault) |
| Email-loop verification | `LYCERT_RESEND_API_KEY` **and** `LYCERT_EMAIL_LOOP_ENABLED=true` |
| Document review | `LYCERT_ANTHROPIC_API_KEY` **and** `LYCERT_DOC_REVIEW_ENABLED=true` |
| Billing | Stripe test-mode keys |

The complete list is in the repository root `.env.example`.
