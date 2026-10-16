# Architecture decision log (condensed)

The working repository keeps a full decision log with about 50 entries. Each entry records the decision,
its reason, the alternatives considered, and the evidence. This page condenses the decisions that shaped
the system. Dates are when each decision was made.

---

### Product and legal foundation (June 2026)

**GDPR is the governing framework.** Lycert processes personal data about EU and non-EU students on behalf of
software vendors. It operates as a processor under a signed Data Processing Agreement, on a
legitimate-interests basis. The dashboard is unusable until a DPA signatory is recorded. Every third party
that touches personal data is listed in a sub-processor registry and stays inactive until its own agreement
is in place.

**A human in the loop is a legal requirement, not a UX choice.** Scoring someone for possible license misuse
is automated profiling. Lycert never takes an adverse action automatically. It produces a case, a
reviewer decides, review time is recorded, and compliance notices cannot be bulk-approved.

**Missing data is never penalized.** A signal whose input is missing scores zero and is listed as a data gap.
A thin record must never look worse than a complete one.

**Signal weights are configurable per tenant.** The reference model's weights are the defaults. Vendors in
other verticals override keyword sets and weights field by field.

---

### Runtime architecture (June 2026)

**Consolidate on one TypeScript engine and retire the Python runtime.**
*Context:* The first backend was a FastAPI service on Railway. It returned persistent 502s on long jobs. The
web app, meanwhile, ran on Vercel and Supabase without it. Two engines were drifting.
*Decision:* TypeScript in the Next.js app is the only runtime. The Python engine stays in the repo as a
parity oracle.
*Gate:* the cross-engine regression must pass on the TypeScript engine before any migration or retirement.

**Durable jobs run on a Postgres queue (pgmq + pg_cron + pg_net), never inside a request handler.**
*Alternatives:* running jobs in Vercel functions was rejected, because it repeats the timeout failure at
scale. Inngest or Trigger.dev was deferred, to be adopted only if pgmq showed a concrete gap.
*Consequences:* workers must be idempotent and checkpointed. Each subsystem has its own queue and an
observable dead-letter queue.

**Vitest is the TypeScript test runner.**

---

### Enrichment (June 2026)

**A registry-driven waterfall with a validation stage.** Providers, their order, priority gates and enabled
flags live in a database registry, so the cascade changes without a deploy. Tenants can override the order.

**ZeroBounce blocks only disposable mailboxes.** "Invalid" is recorded but does not stop enrichment, because a
deactivated student mailbox is itself evidence of graduation.

**Validation runs in the worker, not at enqueue.** The result is cached for 180 days, so re-runs are free.

**The FullEnrich webhook is authenticated with a shared secret in the URL.** FullEnrich does not sign
webhooks. A 15-minute reconcile job polls for results whose webhook never arrived.

**Benchmark before integration.** The first provider spot-check resolved about 3 of 5 hard cases. Three
additional EU-based providers were then built against their real APIs and benchmarked. On the
5-row gap sample of international students with personal emails, none of them resolved a single subscriber.
A later 20-row paid benchmark found FullEnrich at 50%, PDL at 20%, and the three new providers at 5% or
company-only data. They were kept out of the cascade. That run also found two client bugs: a wrong auth
header, and a mapper that silently dropped fields a provider did return.

**CSV dates are parsed with per-column day/month inference.** Source files mix US and European date formats.
Each column's order is inferred from its own values, and the importer only normalizes format. It never
guesses an ambiguous day/month swap.

**Subscriber deletion uses soft archive plus hard purge.** Owner and admin only, both audited.

---

### Verification layer (June–July 2026)

**Build the verification foundation separately from enrichment.** Enrichment is indicative, a LinkedIn-derived
signal. Verification is authoritative proof of enrollment. They share the queue runtime but nothing else.

**The asymmetry invariant.** Only a provider flagged as able to assert "not enrolled" may do so. A
non-authoritative result claiming non-enrollment is downgraded to "unable to confirm". An exhausted waterfall
means "unverified", never "ineligible".

**Registrar sources are stubbed, not invented.** The US and UK clearinghouses need agreements that require a
registered legal entity and a reference customer. Their adapters exist behind the interface and never return
a decision.

**Document review is built dormant and gated.** The design is process-and-purge: raw documents are destroyed
within 24 hours. Confidence is capped at "medium", there is no auto-approval, and every document goes to a
human. A Claude vision model handles classification and extraction. Forensic tamper analysis is a separate,
deferred backend. Upload is impossible until a feature flag, a document-specific consent, a sub-processor
agreement and a data protection impact assessment are all in place.

---

### The Bridge (October 2026)

**Orchestrate the client's CRM and verification provider instead of owning verification.**
*Context:* owning authoritative verification needed agreements, a legal entity, and per-check fees. Clients
already pay a verification provider, and that provider's own guidance tells them to run reverification from
their CRM.
*Decision:* HubSpot is the first and only CRM until the loop works end to end. SheerID is the first
verification provider. The client's CRM is the primary user surface, and Lycert's dashboard is secondary.
*Consequences:* the email loop, document review, registrar stubs and the three excluded providers are frozen
behind flags. Their code and tests stay green, and no migrations are dropped.

**SheerID success is authoritative-positive. SheerID failure is never proof of graduation.** SheerID can only
say "could not re-confirm eligibility".

**Lycert never requests SheerID personal data.** Results are correlated through Lycert's own opaque reference
and the provider's verification ID.

**Links are issued just in time.** A verification is created only when the student clicks.

**Milestones are gated.** Plan, approval, build, live verification, acceptance. External API details marked
"verify at build" must be confirmed against live documentation before code relies on them.

**M3 is unblocked by a free SheerID Test Mode account.** Development uses Lycert's own unbilled Test Mode
program. Real pilots always use the client's own program.

---

### Incidents worth recording (October 2026)

**Write-back pagination bug (found during M1 acceptance).** The candidate query had no filter for rows already
written, so the batch looped over the first 100 rows forever. The fix filters on a missing write-back hash.
The bug was invisible to fake-I/O unit tests.

**Webhook 401s (found during M2 live verification).** The first root cause found was real: the signature was
computed over the internal `http://` URL. The actual blocker was deployment protection on preview URLs, which
rejected HubSpot's requests at the edge. The fix used the documented automation-bypass parameter in the
configured target URL. The signature fix was kept. The investigation was recorded step by step, including
the two earlier diagnoses that turned out to be wrong.
