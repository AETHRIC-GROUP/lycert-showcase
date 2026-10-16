# LYCERT — Master Architecture & Product Roadmap
**Version:** 1.0  
**Date:** June 2026  
**Status:** Authoritative. All implementation must conform to this document.  
**Maintainer:** Aethric Group / Lycert  
**Repo:** github.com/aethric-group/lycert  

---

> ⚠️ **SUPERSEDED (2026-10-08) — see `LYCERT_BRIDGE_ARCHITECTURE.md`, now the authoritative roadmap.**
> The Bridge doc supersedes **Part 5 (Phases 2–6) below** — Lycert no longer builds its own authoritative
> verification, email engine, or standalone enterprise/integration roadmap as originally sequenced. Instead
> Lycert orchestrates the client's existing CRM (HubSpot) + verification provider (SheerID). **Parts 1–4
> (vision, legal constraints, data model) and Part 1 of this doc remain in force** except where the Bridge
> doc explicitly amends them (e.g. `subscribers` now mirrors CRM contacts; see Bridge Part 4.2/6.9/6.7).
> Do not resume Phase 3–6 as written here without a new decision superseding the Bridge doc.

---

## PART 0 — HOW TO USE THIS DOCUMENT

This document is the single source of truth for Lycert's product, architecture, legal posture, and build sequence. It is read by Claude Code before any implementation session begins. It is updated whenever a product or architecture decision changes — never silently.

**Rules for Claude Code reading this document:**
1. Do not implement any feature not described here
2. Do not assume any UI element, button, field, or label — if it is not named here, ask before creating it
3. Do not skip a phase to get to a more interesting one
4. Every database table, column, API endpoint, and UI screen must trace back to a requirement stated in this document
5. When in doubt, build less and ask — over-building is as dangerous as under-building

---

## PART 1 — WHAT LYCERT IS

Lycert is a multi-tenant B2B SaaS compliance intelligence and revenue recovery platform for software companies that offer discounted license plans (starting with education/EDU licenses, expanding later to nonprofit, startup, and government).

**The product does two things, in this order of priority:**
1. **Revenue Recovery (primary):** Identifies subscribers approaching or past their graduation date and runs a structured, personalized conversion sequence to move them from discounted EDU pricing to commercial pricing — treating graduation as a revenue event, not a churn event
2. **Compliance Monitoring (secondary):** Continuously scores existing EDU subscribers for potential license misuse using billing signals, user-submitted data, and LinkedIn enrichment — surfacing high-confidence cases for human review and outreach

**What Lycert is NOT:**
- Lycert is not a front-door verification tool (that is SheerID's domain). Lycert operates post-verification, on existing subscribers
- Lycert is not a marketing automation tool. It uses email as a delivery mechanism, but the intelligence layer is its own
- Lycert is not an automated enforcement system. Every flagged account and every outreach action requires a documented human approval step

**First client:** the design partner (AEC software — rendering and visualization tools)  
**First use case:** EDU license compliance monitoring and graduation-to-commercial conversion  
**Target market (Phase 1):** Mid-market software companies with 1,000–100,000 active EDU subscribers

---

## PART 2 — LEGAL CONSTRAINTS THAT SHAPE EVERY ARCHITECTURAL DECISION

These are not afterthoughts. They constrain the data model, the UI, the API, and the email system from day one. Violating them cannot be fixed by patching later.

### 2.1 GDPR (Governing Framework)
- Lycert operates under GDPR as its primary legal framework. GDPR is the most demanding; compliance with it satisfies CCPA (US/California), LGPD (Brazil), and PIPEDA (Canada) by extension
- **Lawful basis:** Legitimate interests (Article 6(1)(f)) — the software company has a legitimate commercial interest in verifying that subscribers still qualify for their pricing tier
- **Every client must sign a Data Processing Agreement (DPA) before any data is processed.** This is a hard gate in the onboarding flow — no data ingestion without a countersigned DPA on file
- **Automated decision-making (Article 22):** Lycert's scoring engine constitutes automated processing that produces significant effects on individuals. The human-in-the-loop approval gate is therefore not a UX choice — it is a legal requirement. The system must make rubber-stamping difficult. Bulk approval of cases without individual review is prohibited and must be technically prevented in the UI
- **Data minimisation:** Only data fields necessary for scoring are stored. Raw LinkedIn enrichment JSON is never stored. Only extracted signal fields are persisted (employer name, employment status, employment start date, job title, employer domain). Fields not used in scoring are discarded at ingestion
- **Right to erasure:** Every subscriber record must be individually deletable. The system must support Subject Access Requests (SARs) — a compliance manager must be able to retrieve all data held on a specific subscriber by email address within 30 days
- **Cross-border transfers:** Supabase must be configured to use EU region (Frankfurt). PDL's DPA and Standard Contractual Clauses (SCCs) must be documented in the platform's sub-processor registry before PDL integration goes live
- **Retention limits:** Raw enrichment data: deleted within 30 days of scoring. Outcome metadata (score, tier, signals fired, timestamp, action taken): retained for 24 months for audit trail. Email content generated: retained for 90 days then deleted

### 2.2 Language Constraints — Enforced in All UI and All Generated Content
These phrases are PROHIBITED anywhere in the product — in UI labels, in generated emails, in dashboard copy, in API responses, in documentation shown to end-users:
- "violation confirmed"
- "fraud detected"  
- "illegal usage"
- "breach confirmed"
- "cheater" / "cheat"
- "this person is a violator"

These phrases are REQUIRED in their place:
- "potential eligibility concern"
- "eligibility review recommended"
- "license status unclear"
- "flagged for human review"
- "potential mismatch identified"

This constraint applies to the AI explanation layer (Claude API output must be post-processed to verify compliance), to email templates, to dashboard labels, and to any notification text.

### 2.3 Human-in-the-Loop as Legal Architecture
The following actions are NEVER automated, regardless of confidence score, regardless of client configuration:
- Sending a compliance notice email to a subscriber
- Sending a commercial upgrade offer to a subscriber flagged as a potential violator
- Revoking or suspending a license
- Creating a Salesforce/HubSpot record that marks a subscriber as non-compliant

The following actions MAY be automated after explicit client configuration and documented audit trail:
- Sending graduation transition emails to subscribers approaching (not past) their graduation date, where no compliance flag has been raised
- Sending re-verification request emails to subscribers whose graduation date has passed but who have not been scored as Tier 1 or Tier 2
- Scheduling enrichment re-runs

### 2.4 FCRA Notice (US Market)
Before any US client is onboarded, Lycert must obtain a legal opinion on whether Lycert constitutes a Consumer Reporting Agency under the Fair Credit Reporting Act (FCRA). This review must be completed and documented before the first US client goes live. This is a hard prerequisite, not optional.

---

## PART 3 — COMPLETE DATA MODEL

Every table, every column. Nothing assumed.

### 3.1 `tenants`
The top-level entity. One row per software company using Lycert.

| Column | Type | Description |
|---|---|---|
| id | UUID | Primary key |
| name | text | Company name (e.g. "Acme Software") |
| slug | text | URL-safe identifier (e.g. "design-partner") |
| plan_tier | enum | 'starter' / 'growth' / 'pro' / 'enterprise' |
| stripe_customer_id | text | Stripe customer reference |
| dpa_signed_at | timestamptz | Timestamp of countersigned DPA. NULL = DPA not signed. Data processing is BLOCKED until this is set |
| dpa_signed_by | text | Name of signatory |
| fcra_review_completed | boolean | US clients: legal review completed. Default false |
| onboarding_complete | boolean | All required setup steps finished |
| created_at | timestamptz | |
| updated_at | timestamptz | |

### 3.2 `tenant_brand_config`
Brand tokens for email rendering. One row per tenant.

| Column | Type | Description |
|---|---|---|
| id | UUID | Primary key |
| tenant_id | UUID | FK → tenants |
| logo_url | text | URL to logo image (hosted on Supabase Storage) |
| primary_color | text | Hex color (e.g. "#1A2E4A") |
| secondary_color | text | Hex color |
| font_family | text | Google Fonts name or system font |
| sender_name | text | "From" name in emails (e.g. "Acme Software Licensing Team") |
| sender_email | text | Verified sending address |
| reply_to_email | text | Reply-to address for subscriber responses |
| email_footer_text | text | Legal footer text (unsubscribe language, company address) |
| approved_at | timestamptz | Client has reviewed and approved brand config |

### 3.3 `tenant_scoring_config`
Configurable scoring parameters per tenant. Defaults match the original CEDS model. One row per tenant.

| Column | Type | Description |
|---|---|---|
| id | UUID | Primary key |
| tenant_id | UUID | FK → tenants |
| tier1_threshold | integer | Default: 65 |
| tier2_threshold | integer | Default: 40 |
| tier3_threshold | integer | Default: 20 |
| grace_period_days | integer | Days post-graduation before scoring begins. Default: 90 |
| signal_a1_weight | integer | Default: 35 (max for 365d+ case) |
| signal_a2_weight | integer | Default: 20 |
| signal_a3_weight | integer | Default: 20 |
| signal_a4_weight | integer | Default: 10 |
| signal_b1_personal_weight | integer | Default: 8 |
| signal_b2_weight | integer | Default: 20 |
| signal_b3_weight | integer | Default: 8 |
| signal_c1_weight | integer | Default: 25 |
| signal_c2_strong_weight | integer | Default: 20 |
| signal_c2_weak_weight | integer | Default: 10 |
| signal_c3_weight | integer | Default: 15 |
| signal_c4_weight | integer | Default: 10 |
| signal_b1_academic_exculpatory | integer | Default: -10 |
| signal_c2_student_exculpatory | integer | Default: -15 |
| signal_c3_future_exculpatory | integer | Default: -5 |
| signal_c4_academic_exculpatory | integer | Default: -5 |
| updated_at | timestamptz | |

### 3.4 `subscribers`
One row per EDU subscriber per tenant. This is the core entity.

| Column | Type | Description |
|---|---|---|
| id | UUID | Primary key |
| tenant_id | UUID | FK → tenants |
| external_id | text | ID from the client's billing system (e.g. Zuora account number) |
| email | text | Subscriber email address |
| name | text | Subscriber full name |
| account_name | text | Account/company name from billing system |
| account_country | text | Canonical country name from billing |
| institution_name | text | Self-reported institution name |
| institution_location | text | Self-reported institution location |
| stated_graduation_date | date | Self-reported graduation date |
| plan_name | text | License plan name (e.g. "the partner's studio tool Education - Student") |
| plan_type | enum | 'edu' / 'nonprofit' / 'startup' / 'government' |
| subscription_start_date | date | |
| subscription_end_date | date | |
| renewal_date | date | |
| auto_renew | boolean | |
| days_before_last_renewal | integer | Negative = renewed after graduation |
| lifecycle_stage | enum | 'active_student' / 'approaching_graduation' / 'post_graduation_unverified' / 're_verification_pending' / 'converted' / 'churned' / 'flagged_review' / 'dismissed' |
| last_enriched_at | timestamptz | When enrichment was last run |
| enrichment_provider | text | 'pdl' / 'apollo' / null |
| last_scored_at | timestamptz | When scoring engine last ran |
| created_at | timestamptz | |
| updated_at | timestamptz | |

### 3.5 `subscriber_enrichment`
Stores only the specific extracted fields from enrichment. Raw JSON never stored.

| Column | Type | Description |
|---|---|---|
| id | UUID | Primary key |
| subscriber_id | UUID | FK → subscribers |
| tenant_id | UUID | FK → tenants |
| linkedin_profile_url | text | |
| li_current_employer_name | text | |
| li_current_employer_domain | text | |
| li_current_employer_linkedin_url | text | |
| li_job_start_date | date | |
| li_job_end_date | date | NULL = currently employed |
| li_job_title | text | |
| li_education_institution | text | |
| li_education_end_date | date | |
| li_country | text | |
| li_state | text | |
| li_city | text | |
| enrichment_provider | text | 'pdl' / 'apollo' |
| enriched_at | timestamptz | |
| delete_at | timestamptz | Set to enriched_at + 30 days. Cron job deletes records past this date |

### 3.6 `subscriber_scores`
One score record per scoring run per subscriber. Append-only — never update.

| Column | Type | Description |
|---|---|---|
| id | UUID | Primary key |
| subscriber_id | UUID | FK → subscribers |
| tenant_id | UUID | FK → tenants |
| scored_at | timestamptz | Reference date used for scoring |
| total_score | integer | 0–100 |
| confidence_tier | integer | 1, 2, 3, or 0 (clean) |
| tier_label | text | 'Near-Certain Violation' / 'High Confidence' / 'Watch List' / 'Likely Clean' |
| data_confidence | enum | 'high' / 'medium' / 'low' |
| primary_signal | text | Human-readable description of top signal |
| supporting_signals | text | Pipe-separated list of other signals |
| signals_count | integer | |
| signals_fired | text | Comma-separated signal keys |
| data_gaps | text | Comma-separated gap keys |
| aec_professional_confirmed | boolean | |
| ai_explanation | text | Claude-generated plain English explanation |
| recommended_action | text | 'Contact Now' / 'Second Wave' / 'Monitor at Renewal' / 'No Action' |
| scoring_version | text | Version of scoring engine used (e.g. "1.0.0") |

### 3.7 `cases`
The human review record. Created when a subscriber is flagged. One active case per subscriber per tenant at a time.

| Column | Type | Description |
|---|---|---|
| id | UUID | Primary key |
| tenant_id | UUID | FK → tenants |
| subscriber_id | UUID | FK → subscribers |
| score_id | UUID | FK → subscriber_scores — which score triggered this case |
| status | enum | 'pending_review' / 'in_review' / 'approved_for_outreach' / 'dismissed' / 'resolved' |
| assigned_to | UUID | FK → tenant_users |
| opened_at | timestamptz | |
| reviewed_at | timestamptz | Timestamp when reviewer actively opened and viewed the case |
| review_duration_seconds | integer | Time spent on this case (used to detect rubber-stamping) |
| decision | enum | 'proceed_outreach' / 'dismiss_false_positive' / 'escalate' / 'pending' |
| decision_note | text | Required free-text field before any proceed/dismiss decision |
| decided_by | UUID | FK → tenant_users |
| decided_at | timestamptz | |
| closed_at | timestamptz | |

### 3.8 `case_comments`
| Column | Type | Description |
|---|---|---|
| id | UUID | Primary key |
| case_id | UUID | FK → cases |
| author_id | UUID | FK → tenant_users |
| body | text | |
| created_at | timestamptz | |

### 3.9 `tenant_users`
| Column | Type | Description |
|---|---|---|
| id | UUID | Primary key |
| tenant_id | UUID | FK → tenants |
| user_id | UUID | FK → Supabase auth.users |
| role | enum | 'owner' / 'admin' / 'manager' / 'reviewer' / 'viewer' |
| display_name | text | |
| email | text | |
| invited_at | timestamptz | |
| accepted_at | timestamptz | |

### 3.10 `audit_logs`
Immutable. Every action in the system is logged here. Never updated, never deleted within retention period.

| Column | Type | Description |
|---|---|---|
| id | UUID | Primary key |
| tenant_id | UUID | FK → tenants |
| actor_id | UUID | FK → tenant_users (null for system actions) |
| actor_type | enum | 'user' / 'system' / 'api' |
| action | text | e.g. 'case.approved' / 'subscriber.enriched' / 'email.sent' / 'score.computed' |
| resource_type | text | e.g. 'case' / 'subscriber' / 'email_send' |
| resource_id | UUID | ID of the affected record |
| metadata | jsonb | Contextual data (e.g. old/new values for a config change) |
| ip_address | text | |
| created_at | timestamptz | |

### 3.11 `email_sends`
Every email Lycert sends or queues.

| Column | Type | Description |
|---|---|---|
| id | UUID | Primary key |
| tenant_id | UUID | FK → tenants |
| subscriber_id | UUID | FK → subscribers |
| case_id | UUID | FK → cases (null for graduation transition emails) |
| send_type | enum | 'compliance_notice' / 'approaching_graduation' / 'post_graduation_offer' / 're_verification_request' / 'job_seeker_bridge' / 'team_plan_offer' |
| lifecycle_stage_at_send | text | Snapshot of subscriber stage when sent |
| segment_block_id | UUID | FK → email_segment_blocks |
| prompt_version | text | Which AI prompt config generated the personalization sentence |
| ai_personalization_sentence | text | The Claude-generated sentence. Stored for audit and learning |
| subject_line | text | |
| status | enum | 'draft' / 'pending_approval' / 'approved' / 'sent' / 'failed' |
| approved_by | UUID | FK → tenant_users (required for compliance_notice type) |
| approved_at | timestamptz | |
| sent_at | timestamptz | |
| provider | text | 'resend' / 'hubspot' / 'salesforce' / 'sendgrid' |
| provider_message_id | text | External reference from sending provider |
| open_tracked | boolean | Whether open tracking pixel is included |
| opened_at | timestamptz | |
| clicked_at | timestamptz | First click timestamp |
| outcome | enum | null / 'converted' / 're_verified' / 'offer_accepted' / 'team_inquiry' / 'unsubscribed' / 'complained' / 'no_response' |
| outcome_recorded_at | timestamptz | |
| days_to_outcome | integer | Calculated when outcome is recorded |
| subscriber_profile_snapshot | jsonb | Snapshot of enrichment + scoring data at send time. Used for ML training |

### 3.12 `email_segment_blocks`
Pre-written, human-approved email body blocks.

| Column | Type | Description |
|---|---|---|
| id | UUID | Primary key |
| tenant_id | UUID | FK → tenants (null = global default block) |
| block_key | text | e.g. 'approaching_graduation_standard' / 'post_grad_job_found' / 'job_seeker_bridge' |
| subject_line | text | |
| body_html | text | Full HTML body excluding personalization sentence slot |
| body_text | text | Plain text version |
| cta_label | text | Button label (e.g. "Explore Professional Plans") |
| cta_url | text | Where CTA links to |
| approved_by | UUID | FK → tenant_users |
| approved_at | timestamptz | |
| active | boolean | |

### 3.13 `email_prompt_versions`
Versioned AI prompt configurations for personalization sentence generation.

| Column | Type | Description |
|---|---|---|
| id | UUID | Primary key |
| tenant_id | UUID | FK → tenants |
| version_label | text | e.g. "v1", "v2-formal", "v3-warmer" |
| system_prompt | text | Full system prompt sent to Claude API |
| personalization_data_schema | jsonb | Which subscriber fields are injected into the prompt |
| tone_instructions | text | Client-specific tone overrides |
| compliance_constraints | text | What must never be said |
| sandbox_avg_rating | numeric | Average human rating from sandbox testing |
| sandbox_test_count | integer | Number of sandbox evaluations |
| is_production | boolean | Whether this version is currently active in production |
| created_at | timestamptz | |

### 3.14 `sandbox_evaluations`
Records from sandbox testing of email generation.

| Column | Type | Description |
|---|---|---|
| id | UUID | Primary key |
| tenant_id | UUID | FK → tenants |
| prompt_version_id | UUID | FK → email_prompt_versions |
| test_profile_id | UUID | FK → sandbox_test_profiles |
| generated_subject | text | |
| generated_personalization_sentence | text | |
| generated_full_preview | text | Full assembled email preview |
| rating | integer | 1–5 |
| rating_note | text | Free text from reviewer |
| rated_by | UUID | FK → tenant_users |
| rated_at | timestamptz | |

### 3.15 `sandbox_test_profiles`
Synthetic subscriber profiles for sandbox testing. Not real people.

| Column | Type | Description |
|---|---|---|
| id | UUID | Primary key |
| tenant_id | UUID | FK → tenants (null = global Lycert-provided profile) |
| profile_name | text | Human-readable label (e.g. "Recent grad, small AEC studio, Germany") |
| segment | text | e.g. 'post_graduation_job_found' |
| country | text | |
| employer_size | text | 'solo' / 'small_studio' / 'mid' / 'large_firm' |
| institution_type | text | 'research_university' / 'vocational' / 'bootcamp' |
| days_since_graduation | integer | |
| software_usage_depth | text | 'heavy' / 'moderate' / 'light' |
| profile_data | jsonb | Full synthetic profile matching subscriber + enrichment schema |

### 3.16 `email_outcome_signals`
The learning dataset. One record per email_send when an outcome is recorded.

| Column | Type | Description |
|---|---|---|
| id | UUID | Primary key |
| email_send_id | UUID | FK → email_sends |
| tenant_id | UUID | FK → tenants |
| subscriber_segment | text | |
| employer_size | text | |
| country | text | |
| institution_type | text | |
| days_since_graduation | integer | |
| usage_depth | text | |
| prompt_version | text | |
| segment_block_key | text | |
| offer_type | text | |
| personalization_angle | text | e.g. 'institution_reference' / 'career_direction' / 'peer_cohort' |
| outcome | text | Mirror of email_sends.outcome |
| outcome_weight | numeric | Weighted score: converted=1.0, offer_accepted=0.7, re_verified=0.6, team_inquiry=0.5, no_response=0.0, unsubscribed=-0.5, complained=-1.0 |
| days_to_outcome | integer | |

### 3.17 `integrations`
Per-tenant integration configurations.

| Column | Type | Description |
|---|---|---|
| id | UUID | Primary key |
| tenant_id | UUID | FK → tenants |
| integration_type | enum | 'clay' / 'pdl' / 'apollo' / 'hubspot' / 'salesforce' / 'slack' / 'teams' / 'jira' / 'stripe' / 'zuora' / 'chargebee' |
| status | enum | 'connected' / 'disconnected' / 'error' |
| credentials_encrypted | text | Encrypted API credentials (never stored in plaintext) |
| config | jsonb | Integration-specific configuration |
| last_sync_at | timestamptz | |
| error_message | text | Last error if status = 'error' |

### 3.18 `institutions`
The proprietary institution trust database.

| Column | Type | Description |
|---|---|---|
| id | UUID | Primary key |
| name | text | Canonical institution name |
| country | text | |
| domain | text | Primary email domain |
| trust_tier | enum | 'high' / 'medium' / 'low' / 'suspicious' |
| institution_type | enum | 'research_university' / 'teaching_university' / 'community_college' / 'vocational' / 'bootcamp' / 'private_academy' / 'online_only' / 'unknown' |
| accreditation_status | text | 'accredited' / 'unaccredited' / 'unknown' |
| degree_granting | boolean | |
| ipeds_id | text | US IPEDS database ID (if applicable) |
| hesa_id | text | UK HESA ID (if applicable) |
| source | text | 'github_edu_list' / 'ipeds' / 'hesa' / 'wikidata' / 'manual' / 'client_submission' |
| abuse_flag_count | integer | Number of times this institution appeared in a flagged account (aggregated across all tenants, anonymised) |
| created_at | timestamptz | |
| updated_at | timestamptz | |

### 3.19 `sub_processor_registry`
Documents all third-party services processing personal data. Required for GDPR Article 28.

| Column | Type | Description |
|---|---|---|
| id | UUID | Primary key |
| name | text | e.g. "People Data Labs" |
| purpose | text | e.g. "LinkedIn data enrichment for eligibility scoring" |
| data_categories | text | e.g. "Name, email, employment status, job title, employer" |
| country | text | Country of operation |
| transfer_mechanism | text | e.g. "Standard Contractual Clauses (SCCs)" |
| dpa_signed_at | timestamptz | |
| dpa_document_url | text | Internal link to signed DPA |
| active | boolean | |

---

## PART 4 — ROLE-BASED ACCESS CONTROL

Five roles. Every UI screen and API endpoint must enforce these roles.

| Role | Permissions |
|---|---|
| **owner** | Everything. Including billing, deleting the workspace, managing all users |
| **admin** | Everything except billing changes. Can add/remove users, configure integrations, change scoring thresholds |
| **manager** | Can view all subscribers, all cases, all scores. Can approve/reject cases. Can trigger enrichment runs. Cannot change scoring config or integrations |
| **reviewer** | Can view assigned cases. Can add comments. Can approve/reject individual cases. Cannot see unassigned cases |
| **viewer** | Read-only access to dashboard analytics and case list. Cannot open individual case details without manager approval |

---

## PART 5 — BUILD PHASES

> ⚠️ **Phase 1 below shipped as written and stays authoritative for what's built.** Phases 2–6 below are
> **SUPERSEDED by `LYCERT_BRIDGE_ARCHITECTURE.md` Parts 4 and 12** (the KEEP/BUILD-ON/IMPROVE/FREEZE/DROP/
> DEFER table and the M0–M5 milestones) — read the Bridge doc, not the phase descriptions below, for what
> to build next.

### PHASE 1 — Foundation (Months 1–2)
**Goal:** A working, cloud-hosted version of the existing design-partner scoring engine that a second client could theoretically use. Nothing more.

**What gets built:**

#### 1.1 Repository & Infrastructure Setup
- GitHub repo created under Aethric Group: `lycert`
- Branch structure: `main` (production), `staging`, `develop`
- Supabase project created in EU (Frankfurt) region on existing Pro account
- Railway project created for FastAPI backend
- Vercel project connected to GitHub repo for Next.js frontend
- Cloudflare DNS configured for `lycert.com` and `lycert.com` (lycert.com = primary)
- Environment variables documented in `.env.example` — never committed to repo
- `CLAUDE.md` file written and committed (separate document, follows this one)

#### 1.2 Database Schema — Phase 1 Tables
The following tables are created in Supabase in this exact order (respecting FK dependencies):
1. `tenants`
2. `tenant_users`
3. `tenant_scoring_config`
4. `subscribers`
5. `subscriber_enrichment`
6. `subscriber_scores`
7. `cases`
8. `case_comments`
9. `audit_logs`
10. `institutions`
11. `sub_processor_registry`

Row-Level Security (RLS) policies must be created alongside every table. No table exists without RLS. RLS policy for all tables: `tenant_id = auth.jwt() ->> 'tenant_id'`. The tenant_id claim is set in the JWT at login.

#### 1.3 Authentication
- Supabase Auth for email/password authentication
- JWT extended with `tenant_id` and `role` claims
- Login page: email + password fields, "Forgot password" link. No social login in Phase 1
- Route protection: all `/dashboard/*` routes require authenticated session
- Role enforcement: checked server-side on every API call, not just client-side

#### 1.4 Onboarding Flow (Minimal — Phase 1)
A new tenant can be created only by a Lycert admin (not self-serve in Phase 1). The following steps must be completed before a tenant can process any data:
1. Tenant record created (name, slug, plan_tier)
2. DPA signed — `dpa_signed_at` must be set. Until it is, the dashboard shows a blocking banner: "Your Data Processing Agreement has not been signed. No subscriber data can be processed until this is complete. [Contact Lycert]"
3. Owner user invited and account created
4. Scoring config initialised with defaults

#### 1.5 CSV Import
- A "Import Subscribers" page in the dashboard
- Accepts CSV upload
- Column mapping UI: user maps their CSV columns to Lycert's standard schema fields
- Required fields: `email`, `name`, `stated_graduation_date`
- Optional fields: all others in the `subscribers` table
- Validation: rejects rows where email is invalid format, graduation date is unparseable
- Import preview: shows first 10 rows after mapping, before confirming
- Import confirmation button: "Import [N] subscribers"
- On confirmation: creates subscriber records, sets `lifecycle_stage` based on graduation date relative to today
- Import summary screen: "N subscribers imported. X had missing required fields and were skipped. Download skipped rows."
- All imported subscribers set to `plan_type = 'edu'` in Phase 1

#### 1.6 Scoring Engine — FastAPI Backend
The scoring engine is a Python FastAPI service, ported from the existing local script. It must produce identical results to the existing CEDS model for identical inputs.

**Endpoint:** `POST /api/v1/score/batch`  
**Input:** Array of subscriber records (with enrichment data if available)  
**Output:** Array of score records matching the `subscriber_scores` schema  

The engine implements all 11 signals as documented in the Scoring Guide (CEDS model). Signal weights are read from `tenant_scoring_config`, not hardcoded. The engine is deterministic — same inputs produce same outputs on any date, using the reference date provided in the request. Scores are written to `subscriber_scores`. The most recent score per subscriber is the active score.

**Required test coverage:** Unit tests for every signal. Integration test for the full scoring pipeline. Tests must pass before any scoring run is triggered in production.

#### 1.7 Basic Dashboard — Subscriber List
- Left navigation: Dashboard (home), Subscribers, Cases, Settings
- Subscribers page: paginated table of all subscribers
- Columns visible: Name, Email, Institution, Graduation Date, Lifecycle Stage, Last Score, Tier, Recommended Action, AEC Professional Confirmed
- Filters: by Tier (1/2/3/Clean), by Lifecycle Stage, by AEC Professional flag
- Search: by email or name
- Sort: by Total Score (default, descending), by Graduation Date, by Name
- Each row links to Subscriber Detail page
- "Run Scoring" button (admin/manager only): triggers a scoring run on all subscribers with no score or last scored >30 days ago

#### 1.8 Subscriber Detail Page
- Header: subscriber name, email, lifecycle stage badge
- Tab 1 — Profile: all subscriber fields from the `subscribers` table displayed in labelled sections
- Tab 2 — Score History: list of all `subscriber_scores` records, newest first. Each row shows: date, total score, tier, primary signal, data confidence, signals fired
- Tab 3 — Enrichment: current enrichment data from `subscriber_enrichment` (or "Not yet enriched" state)
- Tab 4 — Cases: list of all cases for this subscriber
- Tab 5 — Timeline: chronological feed of all audit_log entries for this subscriber
- No edit functionality in Phase 1 (subscribers are read-only after import)

#### 1.9 Case Management — Phase 1
When a scoring run completes, Tier 1 and Tier 2 subscribers automatically have a case created (status = 'pending_review') if no open case already exists for them.

Cases page:
- Paginated table: Subscriber name, Email, Tier, Score, Status, Assigned To, Opened At
- Filters: by Status, by Tier, by Assigned To
- "Assign to me" button on each unassigned case

Case Detail page:
- Subscriber profile summary (read from subscribers + enrichment tables)
- Current score breakdown — all signals displayed with their individual scores
- AI explanation (from `subscriber_scores.ai_explanation`)
- Decision section:
  - Status dropdown: 'In Review' / 'Approved for Outreach' / 'Dismissed'
  - Decision note field (required — cannot submit without text)
  - "Confirm Decision" button
- The system records `reviewed_at` when the page is opened and `review_duration_seconds` when the decision is submitted. If duration < 10 seconds, a warning appears: "This review was completed very quickly. Please confirm you have reviewed the subscriber's full profile before proceeding."
- Comments section: add/view case comments

#### 1.10 Audit Log — Admin View
- Settings > Audit Log page (admin/owner only)
- Paginated table of all `audit_log` entries for the tenant
- Columns: Timestamp, Actor, Action, Resource Type, Resource ID
- Filters: by action type, by date range, by actor
- Export to CSV button

#### 1.11 Phase 1 — What Is Explicitly NOT Built
To be built in later phases. Not to be touched in Phase 1:
- PDL API integration (Phase 2)
- Email sending (Phase 2)
- HubSpot / Salesforce integration (Phase 2)
- Stripe billing (Phase 2)
- SSO / WorkOS (Phase 2)
- Graduation Transition Engine (Phase 2)
- Email sandbox (Phase 3)
- Configurable rules UI (Phase 4)
- Public API (Phase 5)

---

### PHASE 2 — Enrichment + First Revenue (Months 3–4)
**Goal:** Real-time PDL enrichment, first external integration (HubSpot), Stripe billing, hosted verification flow, and the graduation transition engine foundation. First sellable MVP.

#### 2.1 PDL API Integration (Primary Enrichment Provider)
- Settings > Integrations page: "Connect PDL" card
- API key entry field (PDL uses simple API key auth, no OAuth)
- On save: test the key with a single sandbox call → confirm valid → store encrypted in `integrations` table
- Enrichment endpoint: `GET https://api.peopledatalabs.com/v5/person/enrich?email={email}&api_key={key}`
- PDL returns: full_name, job_title, job_title_levels, job_company_name, job_company_website, job_company_size, job_company_industry, job_start_date, experience array (all past jobs with start/end dates), education array (school_name, degrees, start_date, end_date), LinkedIn URL, location, likelihood score (1–10)
- Flow: send subscriber email to PDL → receive JSON → check likelihood score (reject if < 4) → extract only the fields in `subscriber_enrichment` schema → write to `subscriber_enrichment` → delete raw JSON immediately → set `delete_at` = now + 30 days
- Fallback: if PDL returns 404 or likelihood < 4 → immediately attempt Apollo enrichment → if Apollo also misses → log `enrichment_provider = null` and record in subscriber's `data_gaps`
- The education array from PDL maps directly to signal C3: use the latest `end_date` across all education entries
- Batch enrichment: "Enrich All" button on Subscribers page triggers enrichment for all subscribers not enriched in last 30 days, queued via Redis job queue
- Cost tracking: each enrichment call logged with provider, timestamp, and likelihood score for billing reconciliation
- PDL pricing note: $0.28/successful match. Only charged on HTTP 200 responses. 404s are free.

#### 2.2 Apollo API Integration (Fallback Enrichment Provider)
- Settings > Integrations page: "Connect Apollo" card (shown as "Fallback Provider")
- API key entry field
- Apollo is called only when PDL returns a 404 or low-confidence result (likelihood < 4)
- Apollo returns: job_title, seniority, department, employment_history, current organization name and website, location, social profiles
- Apollo does NOT return education history — C3 signal will be data_gap when Apollo is the only provider that matched
- Extract fields into same `subscriber_enrichment` schema — education fields left null when Apollo-only

#### 2.3 Stripe Billing Integration
- Stripe customer created for each tenant at onboarding
- Three billing line items configured in Stripe:
  1. Monthly subscription (per plan tier)
  2. Enrichment usage meter (per-enrichment credits consumed)
  3. Conversion success fee (webhook from billing system when converted subscriber upgrades — 2–5% of first payment, configurable per tenant)
- Billing page in Settings: shows current plan, usage this month, invoices list
- Upgrade/downgrade plan: redirects to Stripe Customer Portal
- Overage alerts: when enrichment usage exceeds 80% of plan limit, email alert to tenant owner

#### 2.3 Lifecycle Stage Engine
A scheduled job (runs nightly) that evaluates every subscriber's `lifecycle_stage` and updates it based on current date vs graduation date:
- `stated_graduation_date` > today + 90 days → `active_student`
- `stated_graduation_date` between today + 1 day and today + 90 days → `approaching_graduation`
- `stated_graduation_date` between today - grace_period_days and today → `active_student` (grace period, not yet flagged)
- `stated_graduation_date` < today - grace_period_days AND no conversion → `post_graduation_unverified`
- Subscriber submits re-verification → `re_verification_pending`
- Subscriber upgrades to commercial plan (webhook from billing) → `converted`

#### 2.4 Graduation Transition Engine — Email Triggers
This is a one-way door: once the trigger fires, it is logged and cannot be un-fired. Triggers are idempotent — each trigger type fires at most once per subscriber.

Triggers (evaluated by the nightly lifecycle job):
- **T-90:** `approaching_graduation` stage set → Queue `approaching_graduation` email send (status = 'draft')
- **T-60:** 60 days before graduation AND no response to T-90 email → Queue second touchpoint
- **T-30:** 30 days before graduation → Final pre-graduation email
- **T+0 (graduation date):** Grace period begins. No email on this exact date
- **T+30 (post-graduation, no re-verification):** Queue `re_verification_request` email
- **T+60 (post-graduation, no action):** Queue `post_graduation_offer` email (commercial plan offer)

All queued emails start with `status = 'draft'`. They become visible in a new "Email Queue" section of the dashboard. Managers can review and approve individual emails or approve batches. Compliance notice emails (`send_type = 'compliance_notice'`) require individual case-by-case approval with a decision note. No bulk approve for compliance notices.

#### 2.5 Email Sending Infrastructure
- Resend as the default sending provider (for tenants without HubSpot/Salesforce connected)
- Email assembly: brand shell (from `tenant_brand_config`) + segment block HTML (from `email_segment_blocks`) + AI personalization sentence (from Claude API)
- AI personalization sentence generation:
  - Uses Claude Haiku (not Sonnet — cost optimisation)
  - System prompt loaded from `email_prompt_versions` where `is_production = true`
  - System prompt cached using Claude's `cache_control` parameter — refreshed max once per hour per tenant
  - Input: subscriber profile snapshot (fields: name, institution, country, employer_name, job_title, days_since_graduation, software_products_used)
  - Output: exactly one sentence, maximum 30 words
  - Output post-processed: check for prohibited language list before sending. If prohibited language detected, flag for human review instead of sending
- Email rendered and previewed before approval
- Open tracking: 1x1 transparent pixel included (client can disable in settings)
- Click tracking: CTA link wrapped with tracking redirect
- Unsubscribe: one-click unsubscribe link in every email footer. Unsubscribe sets `lifecycle_stage = 'churned'` and adds to suppression list

#### 2.6 HubSpot Integration (First CRM)
- Settings > Integrations > "Connect HubSpot" — OAuth flow
- After connection: map Lycert subscriber fields to HubSpot contact properties
- Lycert writes a custom contact property `lycert_lifecycle_stage` to each matched contact
- When a case is approved for outreach: Lycert updates HubSpot contact's `lycert_lifecycle_stage` property to `approved_compliance_review`
- HubSpot workflow (client-configured on their end, documented in Lycert's integration guide): listens for `lycert_lifecycle_stage` changes and triggers appropriate email sequences
- Lycert does NOT create HubSpot workflows automatically — the client's marketing team does this with Lycert's documented guide

#### 2.7 Hosted Verification Flow
A white-labeled, Lycert-hosted student verification page that software companies can embed as a redirect from their checkout/account pages. Similar in concept to Stripe Checkout — the client redirects to Lycert's hosted flow, Lycert handles the verification, and redirects back.

URL format: `https://verify.lycert.com/{tenant_slug}`

The hosted verification form collects:
- Full name
- Email address
- Institution name (with autocomplete from `institutions` database)
- Expected graduation date
- Program/course of study (optional)
- Document upload (student ID, enrollment certificate, or tuition bill)

On submission:
- Record created in `subscribers` table with `lifecycle_stage = 'active_student'`
- Document uploaded to Supabase Storage (encrypted, 30-day deletion scheduled)
- Institution name cross-referenced against `institutions` database → trust tier recorded
- Email domain classified (academic / personal / corporate / disposable)
- If institution trust tier is 'high' AND email domain is academic: auto-approve and redirect to client's success URL
- All other cases: queued for document review (human or AI-assisted in Phase 3)
- Subscriber receives automated confirmation email: "We've received your verification request. You'll hear from us within 48 hours."

---

### PHASE 3 — Enterprise Features (Months 5–6)

#### 3.1 WorkOS SSO
- SAML 2.0 and OIDC support via WorkOS
- Supported identity providers: Okta, Microsoft Entra ID (Azure AD), Google Workspace, OneLogin
- SSO configuration page in Settings (admin/owner only)
- JIT (Just-In-Time) provisioning: new users auto-created on first SSO login with default role = 'reviewer'
- SSO is available on Growth plan and above

#### 3.2 Email Sandbox
- Settings > Email > Sandbox tab
- 20 global test profiles pre-loaded (Lycert-provided, covering all segments)
- Client can add up to 10 custom test profiles
- "Generate Preview" button: sends subscriber profile + current production prompt version to Claude Haiku → displays rendered email
- Rating interface: 1–5 stars + optional text note per generated preview
- Prompt version comparison: side-by-side preview of two prompt versions against same test profile
- "Promote to Production" button: sets selected prompt version as `is_production = true` on `email_prompt_versions`
- Sandbox emails never sent to real addresses — rendered as preview only

#### 3.3 Slack Integration
- Settings > Integrations > "Connect Slack"
- OAuth flow for Slack workspace
- Client selects which Slack channel receives Lycert alerts
- Alert types (client configures which to enable):
  - New Tier 1 cases created (daily digest, not per-case)
  - Email queue pending approval (daily)
  - Enrichment run completed (with summary)
  - Stripe usage threshold reached
- Alert format: structured Slack message block, not plain text

#### 3.4 Appeal Workflow
When a subscriber receives a compliance notice and contests it:
- Reply-to email address on compliance notices routes to a monitored inbox (configured in `tenant_brand_config.reply_to_email`)
- Subscriber appeal form: Lycert provides a hosted appeal page (similar to verification flow)
  - URL: `https://appeal.lycert.com/{tenant_slug}/{case_id}` (obfuscated case ID in URL)
  - Form collects: reason for appeal, supporting evidence (current enrollment proof)
  - On submission: case status updated to 'appeal_received', case re-assigned to manager, Slack alert sent
- Case Detail page: new 'Appeal' tab showing appeal submission
- Manager decision on appeal: 'Accept Appeal' (dismisses case, subscriber stays on EDU plan, lifecycle_stage reset to 'active_student') or 'Reject Appeal' (case proceeds to outreach)

#### 3.5 Subject Access Request (SAR) Workflow
- Settings > Privacy > Subject Access Requests
- "Search by email" field: finds all data held on a subscriber across all tables
- Returns: subscriber record, all enrichment records, all scores, all cases, all email sends, all audit log entries
- "Export for SAR" button: generates a JSON file of all records for download
- "Delete Subscriber Data" button (owner/admin only): soft-deletes all subscriber data, retaining only anonymised audit entries. Irreversible. Requires typed confirmation.

#### 3.6 RBAC Enforcement Hardening
- Every API endpoint: server-side role check before execution
- Dashboard pages: role-based visibility of navigation items
- Audit log entry written for every permission denial
- "You don't have permission to view this" screen (not a 404) for unauthorised routes

---

### PHASE 4 — Integration Depth (Months 7–8)

#### 4.1 Salesforce Integration
- OAuth flow
- Custom object: `Lycert_Case__c` created in client's Salesforce org
- On case approved: creates/updates Salesforce record
- On subscriber converted: logs activity to Salesforce contact

#### 4.2 Microsoft Teams Integration
- Bot registration via Azure App Registration (client provides)
- Sends same alert types as Slack integration

#### 4.3 Jira Integration
- OAuth flow
- On case approved: creates Jira issue in configured project
- Issue fields: summary, description (subscriber details), priority (mapped from tier), labels

#### 4.4 White-Label Option
- Enterprise plan only
- Client provides custom domain (e.g. `verify.partneronboarding.com`)
- Lycert's hosted verification and appeal flows served under client's domain
- All Lycert branding removed from hosted flows
- Client's brand tokens applied throughout

#### 4.5 Re-Verification Cadence Engine
- Scheduled job evaluates all active EDU subscribers and schedules re-verification based on graduation date
- Re-verification cadence: 90 days before graduation, 30 days before graduation, at graduation date, 30 days post-graduation
- Each re-verification request is a hosted form (same as Phase 2 verification flow, with "Re-confirm enrollment" framing)
- If re-verification submitted and approved: `lifecycle_stage` reset to `active_student`, graduation date updated if changed, score cleared
- If no response within 30 days of request: `lifecycle_stage` advances to `post_graduation_unverified`

---

### PHASE 5 — Intelligence Layer (Months 9–10)

#### 5.1 Configurable Signal Rules UI
- Settings > Scoring Configuration
- Sliders for each signal weight (within defined bounds — cannot set to 0 or negative by accident)
- Tier threshold inputs with validation (Tier 1 must be > Tier 2, etc.)
- Grace period input
- Preview: "With these settings, your current subscriber base would be: X in Tier 1, Y in Tier 2..."
- Save: creates a new scoring config version. Previous version retained for audit
- "Reset to Defaults" button

#### 5.2 ROI Analytics Dashboard
- Dashboard home page redesigned as ROI-first
- Primary metrics displayed as large numbers:
  - "Revenue Recovered This Quarter" (sum of first commercial payments from converted subscribers)
  - "Students Converted to Commercial" (count of `lifecycle_stage = 'converted'` this quarter)
  - "Active Eligibility Concerns" (open Tier 1 + Tier 2 cases)
  - "Re-Verifications Completed" (this quarter)
- Secondary charts:
  - Conversion rate trend (monthly, 12-month view)
  - Tier distribution of subscriber base (pie chart)
  - Email engagement rates by send type
  - Time-to-outcome distribution

#### 5.3 Outcome-Based Email Learning Engine
- Background job: reads `email_outcome_signals`, computes best-performing configuration per subscriber segment
- Recommendation engine: when preparing a new email send, queries the outcome database for closest historical matches, returns top-performing `prompt_version` + `segment_block_key` + `offer_type` combination
- Configuration: epsilon = 0.1 (10% exploration rate — tries non-best-known options to continue learning)
- Reporting: "AI Learning Report" in email settings shows: which configurations are performing best by segment, how many training examples per segment, current exploration rate

#### 5.4 Institution Trust Score — Active Building
- Admin tool (Lycert internal): bulk import from IPEDS API, HESA API, GitHub Education domain list, Wikidata
- Client submissions: when a subscriber's institution is not in the database, it is queued for manual classification
- Aggregation: `abuse_flag_count` updated nightly by counting Tier 1 cases per institution across all tenants (anonymised)
- Trust tier auto-downgrade: institutions with `abuse_flag_count > 50` are flagged for review

---

### PHASE 6 — Scale Readiness (Months 11–12)

#### 6.1 Public API
- REST API with API key authentication
- Endpoints:
  - `POST /api/v1/subscribers` — create or update subscriber
  - `GET /api/v1/subscribers/{id}` — get subscriber with latest score
  - `GET /api/v1/cases` — list cases with filters
  - `POST /api/v1/webhooks` — configure webhook endpoints
- API keys managed in Settings > API
- Rate limiting: per API key, configurable per plan
- API documentation: hosted at `docs.lycert.com`

#### 6.2 Webhook System
- Tenants configure webhook endpoints to receive Lycert events
- Events: `subscriber.scored`, `case.opened`, `case.decided`, `email.sent`, `email.outcome_recorded`, `subscriber.converted`
- Delivery: HTTPS POST with HMAC-SHA256 signature for verification
- Retry: up to 5 retries with exponential backoff on failure
- Webhook log in Settings showing recent deliveries and status

#### 6.3 SOC 2 Type II Preparation
- Security controls audit
- Penetration testing
- Vendor security questionnaire responses prepared
- This is preparation only — certification itself is a subsequent engagement

#### 6.4 Second Vertical — Nonprofit Compliance
- New `plan_type = 'nonprofit'` added to subscriber schema
- New signal library for nonprofit eligibility:
  - IRS 501(c)(3) status lookup (US)
  - Charity Commission registration lookup (UK)
  - OpenCorporates cross-reference
- New segment blocks for nonprofit conversion emails
- All existing infrastructure reused — only the signals and copy change

---

## PART 6 — API DESIGN PRINCIPLES

- All endpoints are prefixed `/api/v1/`
- Authentication: Bearer token (JWT from Supabase Auth) for dashboard API; API key (from `integrations` table) for public API
- All responses: `{ data: ..., error: null }` or `{ data: null, error: { code: string, message: string } }`
- All list endpoints: paginated with `limit` (default 25, max 100) and `cursor` parameters
- All write endpoints: return the created/updated record
- All endpoints: write an `audit_log` entry on success
- HTTP status codes: 200 OK, 201 Created, 400 Bad Request, 401 Unauthorised, 403 Forbidden, 404 Not Found, 422 Validation Error, 500 Internal Server Error
- Rate limiting: 100 req/min per authenticated user for dashboard API

---

## PART 7 — TECHNOLOGY STACK

| Layer | Technology | Reason |
|---|---|---|
| Frontend | Next.js 14 (App Router) | Already paid on Vercel Pro |
| Frontend hosting | Vercel Pro | Already paid |
| Styling | Tailwind CSS | Standard for Next.js |
| Database | Supabase (PostgreSQL, EU Frankfurt) | Already paid, adds second project at +$25/mo |
| Auth | Supabase Auth (Phase 1) + WorkOS (Phase 3) | Supabase free for basic auth, WorkOS for SSO |
| Backend API | Python FastAPI on Railway | Matches existing scoring engine language |
| Job queue | Upstash Redis + background workers | Async enrichment, email scheduling |
| AI layer | Claude Haiku (emails) + Claude Sonnet (explanations) | Existing API key |
| Enrichment | PDL — People Data Labs (primary), Apollo (fallback) | PDL: simple REST GET, returns education array with dates, $0.28/match, pay-per-match only. Apollo: fallback for US coverage gaps and employer data |
| Email sending | Resend (default) | Simple API, reliable deliverability |
| Billing | Stripe | Industry standard, supports usage-based |
| SSO | WorkOS | Built for B2B SaaS, SAML + OIDC |
| Notifications | Novu (self-hosted) | Abstracts Slack/Teams/etc |
| DNS/CDN | Cloudflare | Already paid |
| Version control | GitHub (Aethric Group org) | Already paid |
| Error monitoring | Sentry (free tier) | Standard |
| Domain | lycert.com (primary), lycert.com (redirect) | Confirmed available |

---

## PART 8 — WHAT MUST BE TRUE BEFORE FIRST CLIENT GOES LIVE

This is a checklist. Every item must be verifiable.

- [ ] DPA template reviewed by a qualified lawyer (GDPR, German law)
- [ ] Privacy Policy published at `lycert.com/privacy`
- [ ] Terms of Service published at `lycert.com/terms`
- [ ] Sub-processor registry populated (PDL, Apollo, Supabase, Resend, Vercel, Railway, Stripe, Cloudflare)
- [ ] FCRA legal opinion obtained (before any US client onboarded)
- [ ] Supabase project confirmed on EU Frankfurt region
- [ ] PDL DPA and SCCs documented and on file
- [ ] Prohibited language list enforced in AI output post-processing
- [ ] Audit log writing verified for all case decision actions
- [ ] Human review time tracking implemented and tested
- [ ] 10-second minimum review time warning implemented
- [ ] Bulk approve for compliance notices technically blocked
- [ ] SAR workflow tested end-to-end
- [ ] Data deletion (30-day enrichment) cron job running and verified
- [ ] All passwords and API keys stored encrypted (never in plaintext in database)
- [ ] All environment variables documented in `.env.example`
- [ ] Scoring engine unit tests: 100% signal coverage, all passing
- [ ] RLS policies verified: one tenant cannot query another tenant's data

---

## PART 9 — DECISIONS THAT CANNOT BE UNDONE LATER

These must be correct from the start. Retrofitting is either impossible or prohibitively expensive.

1. **Supabase region = EU Frankfurt.** If set to US on day one, migrating later requires downtime, data migration, and customer notification
2. **RLS on every table from creation.** Adding RLS to a populated table is risky and often incomplete
3. **Audit log is append-only.** If we add an UPDATE capability to audit_logs, the legal evidentiary value is destroyed
4. **Enrichment data 30-day deletion.** If raw JSON is persisted beyond 30 days from the start, past records cannot be retroactively deleted without gaps in the audit trail
5. **Prohibited language in AI output.** If even one compliance notice email contains "violation confirmed" in production, the legal and reputational damage is not recoverable
6. **Subscriber scores are append-only.** Score records must never be updated — only new records added. If we design with UPDATEable scores, the historical record is destroyed
7. **DPA as a hard gate.** If we allow data processing before DPA is signed "just for testing" with a real client, we have processed personal data without legal basis — this cannot be undone

---

*End of LYCERT_ARCHITECTURE.md — Version 1.0*  
*Next document: CLAUDE.md (implementation context for Claude Code)*

