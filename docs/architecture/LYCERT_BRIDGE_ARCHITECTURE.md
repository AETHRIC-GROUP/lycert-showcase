# LYCERT_BRIDGE_ARCHITECTURE.md
**Version:** 1.1 (2026-10-13 revision: M3 unblocked from the design partner via Lycert's own free SheerID Test Mode account — see Part 1 D1 exception and Part 12 M3)
**Date:** 2026-10-08 (original); 1.1 revised 2026-10-13
**Status:** AUTHORITATIVE. This document locks Lycert's new operating model ("the bridge") and defines what to keep, build on, improve, freeze, drop, and defer in the existing codebase.
**Supersedes:** the phase roadmap in `LYCERT_ARCHITECTURE.md` Part 5 (Phases 2–6), the build sequence in `LYCERT_VERIFICATION_ARCHITECTURE.md` Part 9, and the build gate in `LYCERT_DOCUMENT_REVIEW_ARCHITECTURE.md` Part 9. Everything in those documents NOT contradicted here (legal spine, RLS, audit log, banned-phrase list, asymmetry rule, queue architecture) remains in force.
**For Claude Code:** Read this whole document before writing any code. Then (1) verify the "Current baseline" in Part 3 against the actual repo, (2) write a short plan for Milestone M0 + M1 only, (3) wait for Joshua's approval. Do not start M2+ until M1's acceptance criteria pass and Joshua confirms.

---

## PART 0 — THE ONE-PARAGRAPH VERSION

Lycert stops trying to *own* verification data and stops asking clients to *work inside* Lycert. Instead, Lycert becomes the intelligence-and-orchestration layer that sits between three systems the client already pays for: their **CRM** (HubSpot first), their **education-verification provider** (SheerID first), and their **billing/license records**. Lycert reads EDU contacts from the CRM, estimates each student's graduation status (scoring + lifecycle + enrichment), decides who is due or at risk, issues tracked reverification links that route students into the client's own SheerID program, ingests the SheerID outcome, and writes everything back into CRM contact properties and workflow actions so the client's existing marketing automation does the sending. Lycert-sent email (Resend) remains an optional channel, not the default. Everything that required Lycert to sign registrar agreements, store student IDs, or run its own OCR is frozen.

---

## PART 1 — WHY THIS STRUCTURE (DECISIONS LOCKED)

| # | Decision | Reason |
|---|---|---|
| D1 | Lycert orchestrates the client's existing verification provider instead of operating its own authoritative verification. **Exception: Lycert holds its own free, self-serve SheerID account (Test Mode only) purely for M3 development/testing** — every production/pilot deployment still uses the client's own SheerID program; Lycert's account is never used to verify a real client's students. (2026-10-13, Joshua) | NSC/HEDD/NAD require a registered entity, reference customer, legal review, and per-check fees ($4.95/enrollment check at NSC retail). Clients like the design partner already pay SheerID for exactly this. SheerID's own guidance tells brands to run reverification themselves via emailed links and CRM-logged due dates — Lycert automates that guidance. SheerID's self-serve signup is free and every new program starts in Test Mode (unbilled), so M3 no longer needs to wait on the design partner. |
| D2 | HubSpot is the first and only CRM until the full loop works end to end. Salesforce and others come after. | Focus. HubSpot offers free developer test accounts, custom properties via API, custom workflow actions, and OAuth multi-account install. |
| D3 | The client's CRM is the primary user surface; Lycert's dashboard is secondary (configuration, audit, case review). | The bridge thesis: automate what large teams do manually, inside tools they already use. |
| D4 | Default outbound channel = the client's own HubSpot marketing email, personalised with Lycert-written properties. Resend stays optional. | Client keeps branding, deliverability, consent records, and unsubscribe handling. Lycert builds no email engine for the default path. |
| D5 | Lycert never needs SheerID PII. It correlates results through its own opaque reference and the SheerID `verificationId`. | SheerID's `/details` endpoint only returns `personInfo` to tokens with the Customer PII role. Least privilege = smallest GDPR surface and an easier yes from the client's security team. |
| D6 | SheerID success counts as authoritative-positive. SheerID failure / non-response is NEVER treated as proof of graduation. | The client already trusts SheerID's standard to grant the discount, so the same standard is sufficient to keep it. But SheerID can only say "could not re-confirm eligibility", not "this person graduated". The existing asymmetry invariant stays: only providers with `can_assert_not_enrolled = true` may assert not-enrolled, and SheerID is configured `false`. |
| D7 | Links are issued just-in-time: a SheerID verification is created only when the student clicks. | Pre-created SheerID verifications that are started but not finished expire after 7 days. JIT creation also means a student who never clicks never creates a SheerID verification — so non-responders cost the client nothing in SheerID volume. |
| D8 | Clay is not used via a Lycert-owned account. | Clay ToS prohibits reselling data obtained from Clay. A client-owned Clay connection (BYO) may be added much later; not in scope. |

---

## PART 2 — VERIFIED GROUND TRUTH (research, 2026-10-08)

Every architectural claim below is backed by the provider's official documentation. URLs are in Part 15. Where a detail could not be confirmed from official docs, it is marked **[VERIFY AT BUILD]** and Claude Code must confirm it in the provider's live docs or Test Mode before relying on it.

### 2.1 SheerID — what it provides to its customers

1. **Reverification is a documented customer practice, not a separate product.** A reverification is simply a new verification on the same program. SheerID recommends reverifying every 11 months, starting about one month before the offer expires, sending automated emails or in-app messages with a direct link to the verification form, sending reminders (e.g. 30, 15, 5 days before expiry), and not deactivating access automatically at the due date.
2. **Brands are explicitly told to store the verification timestamp in their CRM, compute the due date, and trigger reminders** — this is precisely what Lycert automates.
3. **Tagging reverifications:** SheerID recommends adding a metadata entry (suggested value: the consumer's `previousVerificationId`) or the `externalUserId` to reverification requests so they can be isolated in reporting.
4. **Hosted landing page metadata:** the hosted landing page saves any key-value pair present in its URL query string as metadata on the verification.
5. **Server-side creation ("Secure Verification Creation"):** a backend with an API token can `POST /rest/v2/verification` with `{ "programId": ... }`, receive a `verificationId`, and redirect the user to `https://services.sheerid.com/verify/{programId}/?verificationId={id}`; the hosted form resumes that verification. If the program has API Access Control (`requireToken`), creation without a token returns 401.
6. **Status:** `GET /rest/v2/verification/{verificationId}` returns the current step (`success`, `docUpload`, `pending`, `error`, …). `GET /rest/v2/verification/{verificationId}/details` returns the full record; `personInfo` only for tokens with the Customer PII role. `POST /verification` is NOT idempotent — persist and reuse the returned id.
7. **Webhooks:** configured per program by the customer in MySheerID. Payload contains only `verificationId` and `notifierEventType` (never PII). Events include SUCCESS, MAX_DOC_UPLOAD_ATTEMPTS, EXPIRATION (start-but-not-finish within 7 days), REMINDER, DOCUMENT_REJECTED, ERROR, EMAIL_LOOP, CONSOLATION. Signed with an account-scoped secret token via HMAC. Retries: immediately, then +1h, +3h, +7h, then permanently failed.
8. **Auth:** OAuth 2.0 Client Credentials is preferred. Customer creates an "Application" in MySheerID (Access Management) → Client ID + Client Secret + assigned roles. Token endpoint `POST https://auth.sheerid.com/oauth/token`, body `grant_type=client_credentials&audience=https://services.sheerid.com/rest/&client_id=…&client_secret=…`. Tokens last 30 days; no refresh or introspection — on 401, request a new token and retry once. **Static (long-lived) tokens are a second, supported auth type** (2026-10-13 revision) because the Access Management / Application-creation screen is not guaranteed to exist on a free self-serve account (the Access Tokens tab may be the only option) — the adapter must accept either credential type, selectable per `verification_provider_connections` row. **Static tokens stop working January 31, 2027 — client-credentials remains the default/preferred type for any real pilot connection; static tokens are a fallback, not the default.**
9. **Test Mode:** there is no separate sandbox host; outcomes are simulated per program in Test Mode, driven by the `firstName` submitted (e.g. any name → success, `REJECTED` → docUpload).
10. **Reporting API:** `POST /rest/v2/report/verification` (CSV, date range, programIds, eligibility filters, chosen standard + metadata fields), poll `/report/{id}/status`, download `/report/{id}`. Requires REPORTER role. PII columns only with `isPiiIncluded` + `piiReason` + PERSON_DATA role. Column order is not fixed — parse by header.
11. **CRM Sync (formerly DataConnectors):** for customers on an annual package, SheerID's Professional Services can push verification data into 400+ destinations including CRMs. If the design partner has this enabled for HubSpot, verification fields may already exist on HubSpot contacts. **[VERIFY with the design partner]**
12. **Data retention:** PII default 400 days (configurable 30/90/400/730). Verification results become final after 180 days.
13. **Consent:** SheerID collects data only after the consumer opts in. For the SheerID path, the consent to verification is captured by SheerID in its own form.
14. **Cost:** SheerID pricing is contract-based (base fee + per-verification volume tiers). Whether a reverification counts against the customer's contracted volume is NOT publicly documented. Assume yes until the design partner's SheerID CSM confirms. **[VERIFY with partner/SheerID CSM]** Lycert does not pay SheerID; the client does.
15. **Multiple webhook endpoints per program:** NOT confirmed in docs. **[VERIFY]** — design must work without taking over the client's webhook (Part 7.5).

### 2.2 HubSpot — what the platform allows

1. **Free developer environment:** a free HubSpot account gives developer test accounts with sample CRM data; up to 10 test accounts with a 90-day trial of many Enterprise features; a test account expires after 90 days without API calls and can be renewed.
2. **Platform:** all apps are built on the Projects framework via the HubSpot CLI. Latest platform version is **2026.03** (GA March 30, 2026), first date-based version, with serverless functions. Legacy developer accounts were migrated to standard accounts on March 9, 2026. Date-based API versioning (2026-03) is GA — pin API versions.
3. **App features available in a project:** app cards (CRM record UI), settings page, app pages, webhook subscriptions, custom workflow actions, app events, app objects, app functions. **Classic CRM cards sunset October 31, 2026** — use App Cards only.
4. **Distribution & install limits:** static-token apps → 1 standard account + up to 10 developer test accounts. Privately distributed OAuth apps → up to 10 allowlisted accounts. Marketplace OAuth apps before listing → up to 25 accounts; after listing → unlimited. Marketplace path requires signing HubSpot's Acceptable Use Policy and passing Ecosystem Quality review for listing. A verified domain (DNS TXT) removes the "unverified app" install warning.
5. **Properties API:** `POST /crm/v3/properties/{objectType}` with `groupName`, `name`, `label`, `type`, `fieldType`. Types: `bool`, `enumeration`, `date`, `datetime`, `string`, `number`. HubSpot recommends integrations put their properties in a custom property group. `date` values must be midnight UTC (ISO `YYYY-MM-DD` recommended). Requires `crm.schemas.contacts.write`.
6. **Custom property limits:** Free tools = 10 custom properties per ACCOUNT total. Paid tiers = 1,000 per object.
7. **Workflows** are not available on Free/Starter; custom workflow actions and the callbacks API require the `automation` scope, which in practice requires a Professional+ hub. The design partner is believed to be on the top tier → fine.
8. **Custom workflow actions:** defined in `src/app/workflow-actions/*-hsmeta.json` with `actionUrl`, `inputFields`, `outputFields`, `objectTypes`, `labels`, `executionRules`. HubSpot POSTs an execution request (incl. `callbackId`, the enrolled object, input values) to `actionUrl`. Response returns `outputFields` with optional `hs_execution_state`: `SUCCESS`, `FAIL_CONTINUE`, `BLOCK`, `ASYNC`. A BLOCKed execution is completed via `POST /automation/v4/actions/callbacks/{callbackId}/complete`. Default block expiry is ~1 week; community reports that custom `hs_expiration_duration` is not reliably honoured — **do not depend on long blocks** (Part 6.6). Responses must be fast (treat 20 s as the hard ceiling). **[VERIFY signature version and timeout in 2026-03 docs at build]**
9. **Rate limits:** marketplace-distributed OAuth apps → 110 requests / 10 s per installed account (cannot be raised). Privately distributed apps → tier-dependent per-app limits. Batch CRM endpoints → max 100 records per request. Search API → 5 requests/s per token, 200 records per page.
10. **Agent tools (beta):** enhanced custom workflow actions that HubSpot AI agents can call. Out of scope now; the workflow-action design must not preclude exposing them later.

### 2.3 Enrichment (unchanged facts, carried forward)
- No provider returns authoritative enrollment status from an email. Enrichment = LinkedIn-derived signal only.
- Benchmarks on the design-partner sample: FullEnrich best single performer (~50% on a 20-row paid run); V3 providers (Findymail/Icypeas/Dropcontact) 0/5 useful on the 5-row run.
- Clay ToS forbids reselling data obtained via Clay.

---

## PART 3 — CURRENT BASELINE (from Claude Code's 2026-07-07 assessment — VERIFY BEFORE PLANNING)

Claude Code must confirm each line against the repo and correct this table in STATUS.md if anything differs.

| Area | State |
|---|---|
| Phase 1 (auth, multi-tenant RLS, scoring engine regression-identical to CEDS, dashboard, CSV import, subscriber list/detail, case management with review timer, audit log + CSV export, DPA/FCRA gate, Stripe test mode, lifecycle engine) | Built, on `main`, in production since 2026-06-06 |
| Enrichment engine (TypeScript, `apps/web/lib/enrichment/`) on pgmq + pg_cron + pg_net; cascade ZeroBounce → Hunter → PDL → Apollo (gap-fill) → FullEnrich (async webhook + 15-min reconcile) | Live on staging only |
| V3 providers (Findymail, Icypeas, Dropcontact) | Built, paused, not wired |
| Verification layer (`lib/verification/`, migrations 0037–0045): orchestrator with asymmetry invariants; email-loop (wired, gated off); document review / Claude-vision OCR + review queue + process-and-purge (gated off); NSC/HEDD stubs; scoring V1 integration; reverification cadence in lifecycle engine | Built, 100% inert |
| Python/Railway | Dormant reference oracle |
| Production DB | Phase-1 schema only; migrations 0024→0045 never applied to prod |
| Vercel | Downgraded to Hobby; staging frozen at commit `1d497c7` |
| Tests | 254/254 passing on `develop` at commit `6e353fc` |

**Note:** confirm which runtime currently produces authoritative `subscriber_scores` (TS port vs Python oracle). Whichever is live stays live; this document does not authorise a scoring rewrite.

---

## PART 4 — KEEP / BUILD ON / IMPROVE / FREEZE / DROP / DEFER

### 4.1 KEEP (no functional change)
- Multi-tenant schema, RLS-on-every-table, append-only `audit_logs` and `subscriber_scores`.
- Legal spine: DPA hard gate, banned-phrase enforcement, Art. 22 human-in-the-loop for adverse actions, review-duration tracking, no bulk approval of compliance notices.
- Scoring engine and its CEDS regression gate.
- Queue architecture (pgmq read/archive, visibility-timeout redelivery, Postgres as truth, checkpointing, separate queues, observable dead-letter).
- Verification orchestrator and its invariants (only `can_assert_not_enrolled = true` providers may assert not-enrolled; non-authoritative "not enrolled" is downgraded to `unable_to_confirm`; absence of confirmation is never adverse).
- Case management, audit log UI, Stripe integration (test mode until first paid contract).

### 4.2 BUILD ON (existing component extended)
- **Verification provider registry** → add provider `sheerid` (class `provider_orchestrated`, `can_assert_not_enrolled = false`, `consent_mode = provider_managed`). See Part 7.
- **Lifecycle engine** → compute `reverification_due_at` from the last provider-confirmed verification date (default +11 months, configurable per tenant) in addition to graduation-date logic.
- **Scoring V1 integration** → consume SheerID outcomes through the existing `verification_results` path (Part 7.7).
- **Subscriber model** → becomes the mirror of CRM contacts (Part 5); CSV import remains as a fallback ingestion path.

### 4.3 IMPROVE
- **Enrichment cascade**: keep ZeroBounce → Hunter → PDL → FullEnrich. Apollo stays registered but enabled only when a paid key is configured. Enrichment runs only on EDU contacts whose estimated graduation is within −90 days to the past (i.e. approaching or after), or on manual trigger. Enrichment output feeds the *estimate* and the score — never a verification outcome.
- **Outbound**: Lycert-generated personalisation sentence (existing design) becomes a HubSpot property value rather than a Lycert-sent email body by default.

### 4.4 FREEZE (keep code + tests, disabled by flag, no further work, removed from roadmap)
| Component | Flag / state | Note |
|---|---|---|
| Document review / OCR pipeline + review queue UI | `LYCERT_DOC_REVIEW_ENABLED=false` permanently for now | SheerID performs document review for its customers. Keep code for a possible future "no verification provider" segment. |
| Email-loop verification | `LYCERT_EMAIL_LOOP_ENABLED=false` | Fallback only for future clients with NO verification provider. |
| NSC / HEDD stubs | registry `enabled=false` | No agreements will be pursued now. |
| V3 providers (Findymail, Icypeas, Dropcontact) | registry `enabled=false` | Measured 0/5. Delete in a cleanup PR after M5 unless Joshua says otherwise. |

Frozen code must stay green in CI. Do not delete migrations; do not drop tables.

### 4.5 DROP (from roadmap; do not build)
- Direct registrar/clearinghouse integrations (NSC, HEDD, NAD/DigiLocker).
- Building or buying a "global student database".
- Lycert-owned Clay workspace used to enrich client data.
- Lycert-owned email sequence engine as the default activation path.

### 4.6 DEFER (after HubSpot + SheerID loop is fully working in production for the design partner)
- Salesforce connector (then others).
- Additional verification providers (each via the same `provider_orchestrated` adapter pattern).
- HubSpot App Card on the contact record, app events (timeline), agent tools.
- WorkOS SSO, Slack/Teams alerts, public API, configurable scoring UI, outcome-learning email engine.
- BYO-Clay connector.

---

## PART 5 — TARGET ARCHITECTURE

```
                 CLIENT-OWNED SYSTEMS                                 LYCERT
 ┌────────────────────────────┐                     ┌─────────────────────────────────────────────┐
 │ HubSpot (CRM + marketing)  │◀── OAuth app ──────▶│ CONNECTOR LAYER                              │
 │  • EDU contacts             │   read / write      │  hubspot/   (auth, sync, properties,         │
 │  • Lycert property group    │   workflow actions  │              webhooks, workflow actions)     │
 │  • Workflows + emails       │   webhooks          │  sheerid/   (auth, link issuance, status,    │
 └────────────────────────────┘                     │              webhook, report backfill)       │
 ┌────────────────────────────┐                     │  billing/   (CSV/Stripe today; later Zuora)  │
 │ SheerID (verification)     │◀── client-created ─▶│                                              │
 │  • Student program          │   OAuth app         ├─────────────────────────────────────────────┤
 │  • Hosted form + consent    │   (no PII role)     │ CORE                                         │
 │  • Document review          │                     │  contact mirror + identity resolution        │
 └────────────────────────────┘                     │  lifecycle + reverification scheduler        │
 ┌────────────────────────────┐                     │  enrichment cascade (signal only)            │
 │ Billing / license records  │── CSV / API ───────▶│  scoring engine (CEDS) + V1 verification sig │
 └────────────────────────────┘                     │  decision engine (who/when/which action)     │
                                                     │  case management + audit (human-in-loop)     │
         STUDENT                                     ├─────────────────────────────────────────────┤
  receives email from client's HubSpot ───click───▶  │ ACTIVATION                                   │
  go.lycert.com/v/{ref} ──JIT create──▶ SheerID form │  CRM property write-back (diffed, batched)   │
                                                     │  HubSpot custom workflow actions             │
                                                     │  tracked redirect go.lycert.com               │
                                                     │  optional Resend channel (frozen default)    │
                                                     └─────────────────────────────────────────────┘
```

All long-running work (sync, enrichment, scoring, status polling, write-back) runs on the existing pgmq queues — never inside a Vercel request handler. New queues: `crm_sync_q`, `crm_writeback_q`, `verification_poll_q`.

---

## PART 6 — HUBSPOT CONNECTOR SPECIFICATION

### 6.1 App definition
- HubSpot Project, `platformVersion: "2026.03"`, created with the HubSpot CLI, committed under `integrations/hubspot-app/` in the repo.
- `auth.type = oauth`, distribution `private` for M1–M5 (≤10 allowlisted accounts: developer test accounts for dev, then the design partner's portal). Marketplace distribution only when >10 clients (separate decision; requires AUP signature and review).
- Verify domain `lycert.com` in the HubSpot developer account (DNS TXT via Cloudflare) before installing into any non-test portal.
- Separate apps (or separate client credentials) for staging and production. Staging app installs only into developer test accounts.

### 6.2 Scopes (request only these)
Required: `oauth`, `crm.objects.contacts.read`, `crm.objects.contacts.write`, `crm.schemas.contacts.read`, `crm.schemas.contacts.write`, `automation` (custom workflow actions + callbacks).
Optional (M2+ only if mapping needs them): `crm.lists.read` (if the client defines the EDU segment as a list).
Do not request sensitive / highly-sensitive scopes.

### 6.3 Install flow
1. Tenant admin clicks "Connect HubSpot" in Lycert Settings → Integrations.
2. Redirect to HubSpot OAuth authorize URL with the scopes above and a signed `state` (tenant_id + nonce, 10-minute expiry).
3. Callback exchanges code for tokens using the OAuth endpoints documented for platform 2026.03 **[VERIFY v1 vs v3 token endpoint at build]**.
4. Store in `crm_connections` (Part 6.9): portal id, hub domain, granted scopes, encrypted refresh token, access token + expiry. Encrypt with Supabase Vault (or the repo's existing secret-encryption utility — reuse, don't invent).
5. Refresh access tokens proactively at 80% of `expires_in`; on 401 refresh once then mark connection `error`.
6. Immediately enqueue: property bootstrap (6.4) → segment discovery (6.5).
7. Uninstall / revoke → mark `disconnected`, stop all jobs for that tenant, keep mirror data per DPA retention, purge per DPA schedule.

### 6.4 Property bootstrap (idempotent)
- Create group `lycert` (label "Lycert") if absent.
- For each property in 6.7: GET by name → create if 404 → if exists with a different type, DO NOT overwrite; mark mapping `conflict` and surface in Settings.
- Record each property in `crm_property_mappings` with `created_by_lycert = true`.
- If the portal hits the custom property limit (Free tools = 10 per account), stop, record `property_limit_reached`, and show a clear message: Lycert requires a paid HubSpot tier for full functionality.

### 6.5 Segment discovery (which contacts are EDU)
Onboarding wizard asks the client to define the EDU segment using ONE of:
- (a) a contact property + value (e.g. `license_type = Education`), or
- (b) an existing HubSpot list, or
- (c) SheerID CRM Sync properties already on contacts (if present — auto-detect candidate properties whose names contain `sheerid`).
Also map inbound fields: email (required), first/last name, stated graduation date (if held), institution, country, last SheerID verification date and id (if held), plan/renewal fields. Mappings stored in `crm_property_mappings` with `direction = 'inbound'`.

### 6.6 Sync model
- **Initial backfill:** CRM Search API with the segment filter, 200 per page, ≤5 req/s, cursor pagination; upsert into `subscribers` + `crm_contact_links`. Large portals are chunked through `crm_sync_q`.
- **Incremental:** webhook subscriptions (`webhooks/*-hsmeta.json`) for contact creation, property change on mapped inbound properties, deletion, merge **[VERIFY exact event names on 2026.03]**. Validate HubSpot request signatures. Webhook handler only enqueues; never processes inline.
- **Nightly reconcile:** search by `lastmodifieddate > last_reconcile_at` to catch missed webhooks.
- **Deletion:** contact deleted in HubSpot → delete Lycert mirror row + enrichment for that subscriber (keep anonymised audit entries).
- **Write-back:** `crm_writeback_q` batches up to 100 contacts per `batch/update`; only properties whose value changed since last write (store a per-contact hash of written values). Token-bucket limiter per portal: default 100 req / 10 s (keeps headroom under 110), configurable.
- **Workflow action pattern:** primary pattern is property-triggered workflows in the client's HubSpot (e.g. "when `lycert_reverification_status` becomes `due`"). Custom workflow actions are secondary conveniences. Do not rely on BLOCKed actions lasting more than a few days.

### 6.7 Lycert property group (contact object)
All enumerations use neutral language (banned-phrase list applies to labels and option values).

| Internal name | Type / fieldType | Values / meaning |
|---|---|---|
| `lycert_education_status` | enumeration / select | `enrolled_confirmed`, `likely_enrolled`, `likely_graduated`, `graduation_confirmed_by_student`, `unknown` |
| `lycert_estimated_graduation_date` | date / date | best current estimate |
| `lycert_status_confidence` | enumeration / select | `provider_confirmed`, `high`, `medium`, `low` |
| `lycert_status_source` | enumeration / select | `verification_provider`, `signup_declaration`, `enrichment`, `combined` |
| `lycert_lifecycle_stage` | enumeration / select | `active_student`, `approaching_graduation`, `recent_graduate`, `post_graduation`, `converted` |
| `lycert_conversion_score` | number / number | 0–100 readiness for commercial offer |
| `lycert_recommended_offer` | enumeration / select | tenant-configurable list (e.g. `graduate_discount`, `startup_plan`, `team_plan`, `none`) |
| `lycert_eligibility_review` | enumeration / select | `none`, `review_recommended`, `under_review`, `cleared` |
| `lycert_reverification_status` | enumeration / select | `not_required`, `due`, `link_issued`, `in_progress`, `reconfirmed`, `not_completed` |
| `lycert_reverification_due_date` | date / date | from last confirmed verification + tenant interval |
| `lycert_reverification_url` | string / text | per-contact tracked link `https://go.lycert.com/v/{ref}`; used as a personalisation token in the client's HubSpot emails |
| `lycert_last_verified_date` | date / date | last provider-confirmed eligibility |
| `lycert_personalization_line` | string / textarea | optional AI-generated sentence for email personalisation (existing Haiku design) |
| `lycert_last_synced` | datetime / date | freshness |

Rules:
- `lycert_eligibility_review` is the ONLY compliance-flavoured field written to the CRM. Evidence, signals, and reasons stay inside Lycert's audit-logged case system.
- `review_recommended` may be written automatically; `under_review` / `cleared` only follow a human action in Lycert.
- Never write `not_completed` as a reason to remove a discount — the client's own policy and a human decide that.

### 6.8 Custom workflow actions (M4)
| Action | Inputs | Outputs | Behaviour |
|---|---|---|---|
| `Lycert: Issue reverification link` | none (enrolled contact) | `reverification_url`, `issued` (bool) | Creates/reuses a `reverification_requests` row, writes `lycert_reverification_url` + status `link_issued`, returns SUCCESS synchronously. Never creates a SheerID verification (JIT at click). |
| `Lycert: Refresh education status` | none | `education_status`, `lifecycle_stage`, `conversion_score` | Enqueues a re-score; returns current values immediately (SUCCESS). |
| `Lycert: Request eligibility review` | optional note | `case_id` | Opens a case in Lycert for human review; never takes adverse action. |
Validate HubSpot's request signature on every call. Respond within the HubSpot timeout; heavy work goes to the queue. Use `executionRules` to surface readable errors (e.g. "SheerID not connected").

### 6.9 New tables (all tenant-scoped, RLS)
```
crm_connections        (id, tenant_id, provider='hubspot', portal_id, hub_domain, scopes text[],
                        access_token_enc, access_expires_at, refresh_token_enc, status, installed_by,
                        installed_at, last_error, created_at, updated_at)
crm_contact_links      (id, tenant_id, subscriber_id, provider, crm_object_id, last_inbound_at,
                        last_writeback_at, writeback_hash, UNIQUE(tenant_id, provider, crm_object_id))
crm_property_mappings  (id, tenant_id, provider, direction 'inbound'|'outbound', lycert_field,
                        crm_property, created_by_lycert bool, status 'ok'|'conflict'|'missing', updated_at)
crm_segment_config     (id, tenant_id, provider, mode 'property'|'list'|'sheerid_sync', definition jsonb)
crm_sync_runs          (id, tenant_id, kind 'backfill'|'reconcile'|'writeback', started_at, finished_at,
                        counts jsonb, api_calls int, status, error)
```

---

## PART 7 — SHEERID ORCHESTRATION SPECIFICATION

### 7.1 Provider registration
Add to `verification_providers`:
```
provider_key = 'sheerid'
method_class = 'provider_orchestrated'
can_assert_not_enrolled = false
consent_mode = 'provider_managed'      -- new column; existing providers = 'lycert_managed'
requires_consent = true                 -- satisfied by provider_managed consent (see 7.8)
enabled = false until a tenant connects it
```
The orchestrator must treat `consent_mode = provider_managed` as satisfying the consent invariant ONLY for this provider; it must still refuse to run any `lycert_managed` provider without a consent row.

### 7.2 What the client must provide at onboarding (checklist shown in Settings)
1. SheerID **program id(s)** for the student offer.
2. A MySheerID **Application** (Client ID + Secret) created by the client with the minimum roles:
   - permission to create verifications and read verification status (exact role names per SheerID role docs **[VERIFY with client's MySheerID admin]**),
   - **REPORTER** (optional, only for backfill — 7.6),
   - explicitly **NOT** Customer PII / PERSON_DATA.
3. Whether the program has **API Access Control** (`requireToken`).
4. The program's **hosted landing page URL**.
5. Whether **SheerID CRM Sync to HubSpot** is active and which contact properties it writes.
6. Result-ingestion mode (7.5) and, if mode C, a webhook arrangement.
7. Confirmation from the client's SheerID CSM on whether reverifications consume contracted volume (recorded as a tenant note; affects how aggressively reminders run).

### 7.3 Tables
```
verification_provider_connections (id, tenant_id, provider='sheerid', program_ids text[],
        auth_type 'client_credentials'|'static_token',   -- added 2026-10-13; see Part 2.1 item 8
        client_id_enc NULL, client_secret_enc NULL,      -- set when auth_type='client_credentials'
        static_token_enc NULL,                           -- set when auth_type='static_token'
        cached_token_enc, token_expires_at,
        api_access_control bool, landing_page_url, ingestion_mode 'crm_sync'|'poll'|'webhook',
        webhook_secret_enc NULL, roles_declared text[], status, last_error, created_at, updated_at)

reverification_requests (id, tenant_id, subscriber_id, provider='sheerid',
        ref text UNIQUE,                 -- opaque, unguessable, used in go.lycert.com/v/{ref}
        previous_verification_id text,   -- if known
        provider_verification_id text,   -- set at JIT click
        trigger 'due'|'risk'|'manual'|'workflow_action',
        channel 'hubspot_email'|'resend'|'manual',
        status 'scheduled'|'link_issued'|'clicked'|'in_progress'|'reconfirmed'|'not_completed'|'expired'|'cancelled',
        provider_step text,              -- last raw currentStep from SheerID
        due_at, issued_at, first_clicked_at, resolved_at, reminder_count int,
        created_at, updated_at)
```
Add to `subscribers`: `last_verified_at`, `last_verified_provider`, `reverification_due_at`.
`verification_results` gains rows with `provider_key='sheerid'` (reuse existing table; no PII columns).

### 7.4 Link issuance and the tracked redirect (JIT)
1. Decision engine (Part 8) or a HubSpot workflow action creates a `reverification_requests` row → `ref` = 32+ bytes random, URL-safe. Store only a hash of `ref` if the codebase already uses hashed tokens for email-loop; reuse that utility.
2. Lycert writes `lycert_reverification_url = https://go.lycert.com/v/{ref}` and `lycert_reverification_status = link_issued` to HubSpot.
3. Student clicks → `GET go.lycert.com/v/{ref}` (Next.js route, edge-safe, no PII rendered):
   - unknown/cancelled ref → neutral page with client's support contact;
   - open request with a non-terminal `provider_verification_id` → reuse it;
   - otherwise, **if the connection has API credentials:** `POST /rest/v2/verification {programId}` with Bearer token → store `provider_verification_id`, status `clicked` → 302 to `https://services.sheerid.com/verify/{programId}/?verificationId={id}&lycert_ref={ref}&previousVerificationId={prev}`;
   - **if no API credentials (CRM-Sync-only client):** 302 to `{landing_page_url}?lycert_ref={ref}&previousVerificationId={prev}` (hosted landing page saves query params as metadata).
   - log click in audit log (no IP stored beyond what existing audit policy allows).
4. Whether query params are saved as metadata when `verificationId` is also present is **[VERIFY in Test Mode]**. Correlation never depends on it when API credentials exist (Lycert already holds `provider_verification_id`).
5. Token handling: cache the 30-day SheerID token encrypted; on 401 fetch a new one and retry once; never expose tokens to the browser.

### 7.5 Result ingestion — three modes (configurable per tenant)
| Mode | Requires | How | Latency |
|---|---|---|---|
| **A. `crm_sync`** | Client's SheerID CRM Sync writes verification fields to HubSpot | Lycert reads the mapped SheerID properties via the HubSpot webhook/reconcile path and matches by contact | Depends on CRM Sync |
| **B. `poll`** (default when API creds exist) | Client OAuth app (no PII role) | `verification_poll_q` polls `GET /rest/v2/verification/{id}` for every open request: every 15 min for 1 h, hourly to 24 h, every 6 h until day 8, then mark `expired` | ≤15 min early |
| **C. `webhook`** | Client adds Lycert's endpoint to the program's webhooks (or forwards events) and shares the account secret token | `POST /api/v1/verification/webhook/sheerid` → verify HMAC → enqueue → fetch status | near real time |
Mode C never replaces B: when webhooks are on, polling backs off to a daily safety sweep. Webhook handler is idempotent on `(verificationId, notifierEventType)` and returns 2xx immediately.
**Constraint confirmed 2026-10-13:** a SheerID program/account appears to support only one webhook address (no documented API for multiple), and the signing secret is account-scoped, not per-program. A client who already forwards their program's webhooks elsewhere may have no room for Lycert's endpoint. **Polling (Mode B) and CRM Sync (Mode A) stay the defaults**; recommend clients that want webhook-speed updates create a separate "Reverification" program pointed at Lycert's endpoint (also gives them cleaner reporting, isolated from their primary program).

### 7.6 Backfill of historical verification dates (M3, optional)
Goal: compute `reverification_due_at` for students verified before Lycert was connected.
Preferred sources, in order:
1. SheerID verification date already present on HubSpot contacts (CRM Sync or client's own property) → map inbound.
2. Client's billing/license system (date the EDU license was granted after verification).
3. SheerID Report API with REPORTER role, `rewardEligibilities: ["ELIGIBLE"]`, standard + metadata fields only. Joining report rows to contacts needs a shared key: `externalUserId` (if the client passed one) — otherwise EMAIL, which requires PII access. **Do not request PII by default**; if the client wants email-joined backfill, that is a separate, documented opt-in with `piiReason`, and the downloaded file is processed and discarded within the job (never stored).
Parse CSV by header name (column order is not fixed).

### 7.7 Outcome mapping (single source of truth — implement as a pure, tested function)
| SheerID state | `reverification_requests.status` | `verification_results` | HubSpot `lycert_reverification_status` / `lycert_education_status` | Scoring |
|---|---|---|---|---|
| `success` | `reconfirmed` | status `enrolled`, confidence `provider_confirmed` | `reconfirmed` / `enrolled_confirmed`; set `lycert_last_verified_date`, new due date | V1 = verified-enrolled → suspicion capped below Tier 2 (existing behaviour) |
| `pending` / `docUpload` / `collect*` | `in_progress` | none yet | `in_progress` | no change |
| `error` incl. MAX_DOC_UPLOAD_ATTEMPTS | `not_completed` | status `unable_to_confirm` | `not_completed` / unchanged education status | no adverse score change; creates a case only if tenant policy says so; human decides |
| EXPIRATION (started, not finished in 7 days) | `expired` → eligible for a new reminder | none | stays `link_issued`/`due` | none |
| never clicked by deadline | `not_completed` after final reminder | none | `not_completed` | none |
Hard rule: no SheerID state ever produces `not_enrolled`, `graduated_confirmed`, or any adverse automated action. "Not completed" is a business-policy input for a human, matching SheerID's own guidance to maintain access while prompting.

### 7.8 Consent and GDPR for this path
- Lycert (processor for the client) issues links and stores: subscriber id, CRM object id, `ref`, SheerID `verificationId`, status, timestamps. No SheerID PII.
- The student's consent to verification is captured by SheerID in its form (`consent_mode = provider_managed`); Lycert records the provider and verificationId as the consent reference.
- The reverification request email is a re-check prompt under the client's existing offer terms, not an automated decision. It may be automated per tenant configuration (consistent with the original architecture's "may be automated" list). Compliance notices and any pricing change remain human-gated.
- Add SheerID to the tenant's records as the client's own processor (not a Lycert sub-processor — Lycert never receives SheerID PII). Update the DPA template annex to describe the orchestration role. **[Legal review]**

### 7.9 Reminder cadence (tenant-configurable defaults, mirrors SheerID guidance)
- `due` status at `reverification_due_at − 30 days` (default due = last verification + 11 months).
- Reminders at −30, −15, −5 days if not reconfirmed (HubSpot workflow re-enrolment on status, or Resend if that channel is chosen).
- Final follow-up at the due date; then `not_completed`.
- Risk-triggered early reverification (Part 8) uses the same request object with `trigger = 'risk'`; max one open request per subscriber.

---

## PART 8 — DECISION ENGINE (who gets what, when)

Runs nightly on the queue per tenant, plus on relevant webhooks.

1. **Due-based (baseline, applies to everyone):** `reverification_due_at − 30d ≤ today` and no open request → create request (`trigger='due'`) → status `due` in HubSpot.
2. **Risk-based (Lycert's differentiation):** score Tier 1/2 OR estimated graduation date passed by > tenant grace period, AND last verification older than tenant minimum (default 90 days) → create request (`trigger='risk'`). Writes `lycert_eligibility_review = review_recommended` only if the tenant enabled that.
3. **Conversion-based:** `lifecycle_stage ∈ {approaching_graduation, recent_graduate}` → update `lycert_recommended_offer`, `lycert_conversion_score`, `lycert_personalization_line` (no verification request needed for marketing).
4. **Suppression:** contacts that converted, unsubscribed (read HubSpot subscription status if exposed via mapped property), or have an open case under review are skipped.
5. **Volume guard:** per-tenant daily cap on new reverification requests (protects the client's SheerID volume); default 500/day.
6. Every decision writes an `audit_logs` row with the rule that fired.

---

## PART 9 — ENRICHMENT'S ROLE AFTER THIS CHANGE
- Purpose: improve `lycert_estimated_graduation_date`, `lycert_education_status` (likely_* values only), `lycert_conversion_score`, and offer selection.
- Cascade: ZeroBounce (gate) → Hunter → PDL → FullEnrich (async); Apollo only with a paid key; V3 disabled.
- Trigger: only EDU contacts approaching/after estimated graduation, or flagged by score, or manual; respects existing monthly budget caps.
- Enrichment can raise a reverification request (risk-based) but can never set a verification outcome.
- 30-day deletion of enrichment fields and all GDPR field exclusions remain unchanged.

---

## PART 10 — ACTIVATION RECIPES (documentation Lycert ships to clients, not code)
Write these as markdown guides in `docs/client-guides/hubspot/` (M4):
1. **Reverification campaign:** workflow triggered when `lycert_reverification_status = due` → marketing email containing `{{ contact.lycert_reverification_url }}` → delay 15 d → if status still `due`/`link_issued`, reminder → delay 10 d → reminder → at due date final email.
2. **Graduate conversion:** trigger `lycert_lifecycle_stage = recent_graduate` and `lycert_recommended_offer` known → offer email using `lycert_personalization_line`.
3. **Eligibility review routing:** trigger `lycert_eligibility_review = review_recommended` → create task for the license-compliance owner with a link to the Lycert case. No automated customer-facing message.
Each recipe states that the client controls content, timing, and consent; Lycert supplies data.

---

## PART 11 — SECURITY & OPERATIONS
- All third-party credentials encrypted at rest; decrypted only in server code; never logged.
- Separate HubSpot apps, SheerID credentials, and secrets for staging vs production (existing env discipline).
- Signature validation on every inbound webhook/action (HubSpot, SheerID, FullEnrich).
- Idempotency keys on all inbound handlers.
- Observability: `crm_sync_runs`, dead-letter counts, per-portal API usage, SheerID 401/429 rates surfaced in an admin health panel.
- SheerID `429 apiRateLimitExceeded` → exponential backoff; other 429 `errorId`s are not retryable.
- HubSpot developer test accounts must receive at least one API call per 90 days (schedule a weekly no-op call from staging).

---

## PART 12 — MILESTONES (build in order; each ends with Joshua's review)

### M0 — Unblock and lock the new direction (no product code)
- Joshua: restore Vercel Pro (staging deploys are frozen on Hobby).
- Claude Code: verify Part 3 baseline; set freeze flags per Part 4.4 and confirm tests still pass; record decisions D1–D8 in `DECISIONS.md`; update `STATUS.md`, `NEXT_STEPS.md`, `CLAUDE.md` (pointer to this file as the current roadmap).
- Do NOT promote migrations to production yet.
**Accept:** 254+ tests green, freeze flags verified off, docs updated.

### M1 — HubSpot connector foundation (developer test account only)
- HubSpot project (2026.03), OAuth install, token storage + refresh, verified domain.
- Property bootstrap (6.4) with idempotency and conflict detection.
- Segment config UI (property mode only for M1) + inbound mapping.
- Backfill via Search API into `subscribers` + `crm_contact_links`.
- Write-back of `lycert_estimated_graduation_date`, `lycert_lifecycle_stage`, `lycert_education_status` (from stated graduation date only), `lycert_last_synced`.
**Accept:** in a test account seeded with 200 synthetic EDU contacts: install → properties created once (re-run creates nothing) → all 200 mirrored → fields written back → visible in a HubSpot list filtered on Lycert properties → uninstall stops jobs. Rate limiter never exceeds configured budget. Unit + integration tests (HubSpot calls mocked; one live smoke test against the test account behind a flag).

### M2 — Scoring, enrichment, and incremental sync
- Webhook subscriptions + nightly reconcile; deletion handling.
- Score + conversion fields + recommended offer + personalization line written back with diffing.
- Enrichment triggered per Part 9.
**Accept:** editing a mapped property in HubSpot updates Lycert within minutes and re-writes only changed Lycert fields; deleting a contact removes the mirror; CEDS regression still byte-identical.

### M3 — SheerID connector (Test Mode)
**Revised 2026-10-13 — no longer blocked on the design partner.** Lycert sets up its own free, self-serve SheerID
account (Student program, starts in Test Mode automatically, Test Mode verifications are never billed) —
see Part 1 D1 exception. The design partner's HubSpot-tier / EDU-contact-identification / CRM-Sync questions (Part 14
#2) remain useful to ask ahead of a real pilot, but none of them block building or accepting M3.
- `verification_provider_connections` (now with `auth_type` — Part 7.3), `reverification_requests`,
  provider `sheerid` registration.
- Token handling for **both** credential types (client-credentials OAuth, cached ≤30 days; static token —
  Part 2.1 item 8), JIT redirect `go.lycert.com/v/{ref}`, poll mode (default), outcome mapping (7.7) as a
  pure function with exhaustive tests, write-back of reverification fields, V1 scoring integration.
- **Two build tracks, both in scope for M3:**
  (a) A mock SheerID server implementing the documented contract (token endpoint, `POST
  /rest/v2/verification`, `GET /verification/{id}`, `/details`, HMAC-signed webhook with SheerID's
  documented retry schedule) covering every Test Mode `firstName` outcome (success / `REJECTED` /
  `UPLOAD` / `INCONCLUSIVE` / `EMAILLOOP` / `LIMIT` / `__ERROR__`) — used in unit/integration tests and CI.
  No live SheerID dependency; can be built immediately.
  (b) Live integration tests against the real Test Mode program, behind an env flag, **never run in CI**
  (same pattern as the one HubSpot live-smoke-test exception in M1).
- Mode A (CRM Sync read) stays available but isn't testable without a client's real CRM Sync setup; Mode C
  behind a flag per the one-webhook-per-account constraint (7.5).
**Testing without a client:** HubSpot-side tests run on Lycert's own developer test account(s) with
synthetic contacts whose property *structure* (names/formats, fill-rate) mirrors what's publicly knowable
about a typical client setup — never real client data. The EDU-contact filter stays tenant-configurable
(not hardcoded to any one property/value — `role = student` is an example seed value, not a requirement).
**Accept:** in Test Mode, a synthetic student clicks the link → success path updates HubSpot to
`reconfirmed` + new due date; `REJECTED` path → `in_progress` then (after simulated max attempts) →
`not_completed` with no adverse automation; unclicked link creates no SheerID verification; expired
verification re-eligible for reminder. Mock-server tests (track a) passing is necessary but not
sufficient — at least one live Test Mode run (track b) is required before Joshua's acceptance sign-off,
same eyes-on-it standard as M1/M2.

### M4 — HubSpot workflow actions + client recipes
- The three custom workflow actions (6.8), signature validation, execution rules.
- Client guides (Part 10).
**Accept:** end-to-end in the test account: workflow enrols contact → "Issue reverification link" → HubSpot email with token → click → SheerID Test Mode success → property flips → workflow branch fires.

### M5 — Design-partner pilot and production promotion
**Renamed 2026-10-13** (was named after the first partner) — generalized since M3/M4 no longer depend on the design partner
specifically; the actual pilot partner (the design partner or otherwise) is confirmed when M5 starts, not baked into
the milestone name.
- Joshua: pilot partner signs pilot terms + DPA; FCRA opinion if any US subscribers are processed (existing rule); legal review of DPA annex for orchestration role.
- Promote migrations 0024→latest to production with a written runbook (pg_cron schedules with prod secrets, rollback plan); install private OAuth app in the pilot partner's HubSpot portal; pilot on a small segment (e.g. 500 contacts) with daily caps; pilot uses the partner's own SheerID program, never Lycert's free Test Mode account.
**Accept:** one full reverification cycle completed for the pilot segment with zero adverse automated actions, audit trail complete, pilot partner sign-off.

---

## PART 13 — WHAT CLAUDE CODE MUST NOT DO
- Do not build anything in Part 4.5 (DROP) or 4.6 (DEFER).
- Do not delete frozen code, tables, or migrations.
- Do not request SheerID PII roles or store SheerID `personInfo`.
- Do not default new production/pilot connections to static tokens — client-credentials is the preferred
  auth type (Part 2.1 item 8); static tokens are a supported fallback for self-serve accounts only, and
  retire 2027-01-31.
- Do not copy real client contact data into Lycert's own systems for M3/M4 testing — only structural
  patterns (property names, value formats, typical fill-rates) may be replicated, with synthetic data.
- Do not create SheerID verifications before the student clicks.
- Do not let any SheerID outcome, non-response, or enrichment result trigger an automated adverse action or write `not_enrolled`.
- Do not write evidence, signal names, or banned phrases into HubSpot.
- Do not run sync, enrichment, polling, or write-back inside a request handler.
- Do not exceed configured HubSpot or SheerID rate budgets; never retry non-retryable SheerID 429s.
- Do not invent endpoint paths or event names marked **[VERIFY]** — confirm in live docs/Test Mode and record the confirmation in `DECISIONS.md`.
- Do not install the app into any non-test HubSpot portal before M5 approval.

---

## PART 14 — OPEN ITEMS FOR JOSHUA (blocking where noted)
1. Restore Vercel Pro — blocks all staging deploys (M0).
2. Ask the design partner (useful ahead of a real pilot — **no longer blocks M3**, see Part 1 D1 / Part 12 M3): HubSpot tier confirmation; how EDU contacts are identified in HubSpot; whether SheerID CRM Sync to HubSpot is active and which properties; whether the design partner passes `externalUserId` to SheerID.
3. Ask the design partner's SheerID CSM: does a reverification consume contracted verification volume? (One program
   appears limited to a single webhook address per the docs — see 7.5 — so default to polling/CRM Sync
   regardless; confirm with a CSM only if a client specifically wants webhook-speed updates.)
4. Legal: DPA annex wording for the orchestration role; confirm automated reverification prompts are acceptable under the design partner's offer terms.
5. Business: legal entity status — HubSpot AUP / marketplace listing and SheerID-related contracts should be signed by the entity, not an individual.

---

## PART 15 — SOURCES (official, checked 2026-10-08; SheerID self-serve/pricing items added 2026-10-13)
**SheerID**
- Account Setup (free self-serve signup, work email required) — https://developer.sheerid.com/getting-started/account-setup
- Testing Your Integration (Test Mode `firstName`/`lastName` scenario table) — https://developer.sheerid.com/tutorials/testing
- Authentication overview — https://developer.sheerid.com/authentication
- Start Here / Getting Started — https://developer.sheerid.com/start-here, https://developer.sheerid.com/getting-started
- Clients FAQ (sandbox account mention, no formal partner program found) — https://sheerid.com/wp-content/uploads/2017/11/sheerid-clients-frequently-asked-questions.pdf
- Pricing — not officially published; buyer-reported figures via Vendr (median ~$70.8k/yr, ~$11.6k–$198k range, volume-tiered) — https://www.vendr.com/buyer-guides/sheerid — and reverification cost complaints via G2 reviews — https://www.g2.com/products/sheerid/reviews — treated as informational/unverified, not authoritative
- Best practices for reverification — https://sheerid.zendesk.com/hc/en-us/articles/14922926354075-Best-practices-for-reverification
- Setting up webhooks — https://sheerid.zendesk.com/hc/en-us/articles/6955976683035-Setting-up-webhooks
- Utilizing DataConnectors (CRM Sync) — https://sheerid.zendesk.com/hc/en-us/articles/23021467475483-Utilizing-DataConnectors-with-SheerID
- Hosted landing page (URL query params saved as metadata) — https://sheerid.zendesk.com/hc/en-us/articles/6993741394203-How-to-use-and-update-a-hosted-landing-page
- REST API quickstart (status, details, idempotency, Test Mode) — https://developer.sheerid.com/api-quickstart
- Secure Verification Creation — https://developer.sheerid.com/tutorials/secure-verification-creation
- API Tokens (client credentials, 30-day tokens, static retirement 2027-01-31) — https://developer.sheerid.com/tutorials/api-tokens-detail
- Data Handling & Privacy (PII role, retention, purge) — https://developer.sheerid.com/reference/data-handling
- Verification Report API — https://developer.sheerid.com/tutorials/verifications/verification-report
- Verification Service Definition (consent, 180-day finality) — https://developer.sheerid.com/reference/verification-service-definition
- Verification Tracking — https://sheerid.zendesk.com/hc/en-us/articles/38942259100571-Verification-Tracking

**HubSpot**
- Account types / developer test accounts — https://developers.hubspot.com/docs/getting-started/account-types
- Developer platform basics (Projects, CRM card sunset) — https://developers.hubspot.com/developer-platform-basics
- Spring 2026 Spotlight (2026.03 GA, serverless, agent tools) — https://developers.hubspot.com/changelog/spring-2026-spotlight
- Create an app with the CLI — https://developers.hubspot.com/docs/apps/developer-platform/build-apps/create-an-app
- Manage apps (install limits, AUP, verified domain) — https://developers.hubspot.com/docs/apps/developer-platform/build-apps/manage-apps-in-hubspot
- App configuration (project structure) — https://developers.hubspot.com/docs/apps/developer-platform/build-apps/app-configuration
- Properties API — https://developers.hubspot.com/docs/api-reference/crm-properties-v3/guide
- Custom workflow actions — https://developers.hubspot.com/docs/apps/developer-platform/add-features/custom-workflow-actions
- Custom workflow actions reference (execution states, callbacks) — https://developers.hubspot.com/docs/api-reference/2026-03/automation/workflow-actions/custom-action-reference
- Complete a callback — https://developers.hubspot.com/docs/api-reference/legacy/automation/workflow-actions/callbacks/complete-callback
- API usage guidelines and limits — https://developers.hubspot.com/docs/developer-tooling/platform/usage-guidelines
- Product & Services Catalog (custom property limits) — https://legal.hubspot.com/hubspot-product-and-services-catalog

**Other**
- Clay Terms of Service (no resale of data) — https://www.clay.com/terms-of-service
- National Student Clearinghouse verification pricing — https://www.studentclearinghouse.org/verify/

*End of LYCERT_BRIDGE_ARCHITECTURE.md — v1.0*
