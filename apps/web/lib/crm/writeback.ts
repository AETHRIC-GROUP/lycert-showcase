/**
 * Pure write-back logic (Bridge Part 12 M1+M2, Part 6.7).
 *
 * M1 fields: lycert_estimated_graduation_date, lycert_lifecycle_stage, lycert_education_status,
 * lycert_last_synced. M2 adds: lycert_conversion_score, lycert_recommended_offer.
 *
 * `lycert_education_status` is computed "from stated graduation date only" per the M1 scope line —
 * it does NOT read the internal lifecycle_stage or any provider/CRM signal. `enrolled_confirmed` and
 * `graduation_confirmed_by_student` require a verification provider or the hosted flow (not M1/M2), so
 * this function can only ever return `likely_enrolled` / `likely_graduated` / `unknown`.
 *
 * `lycert_lifecycle_stage` reads the internal 8-value `lifecycle_stage` enum and maps it down to the
 * Bridge doc's 5-value HubSpot option set (Part 6.7) — HubSpot enumeration properties reject values
 * outside their configured options, so this mapping is mandatory, not cosmetic.
 *
 * `lycert_recommended_offer` (M2): Bridge Part 6.7 lists this as tenant-configurable with an EXAMPLE
 * option set (graduate_discount/startup_plan/team_plan/none), not a specified formula. No signal exists
 * yet in the data model for "is this a startup" or "team plan fit" — only lifecycle_stage is available —
 * so this deliberately only ever returns `graduate_discount` (lifecycle at/near graduation) or `none`.
 * `startup_plan`/`team_plan` stay unreachable until a real signal exists; documented, not hidden.
 *
 * `lycert_personalization_line` is NOT written by this module. Bridge 6.7 calls it an "AI-generated
 * sentence... (existing Haiku design)" — but that design was never built (the original Phase 2 Step 5
 * email-personalization feature was never implemented), and the legal spine requires AI-generated content
 * to be banned-phrase-filtered before use. Wiring an actual LLM call without that safeguard would violate
 * the legal spine; building the safeguard properly is its own feature, not a write-back line item. Left
 * unpopulated for M2, same as M1 left most of the 14 properties unpopulated — a flagged gap, not a silent
 * drop (DECISIONS.md 2026-10-12).
 */
import crypto from 'crypto'

export type CrmEducationStatus = 'likely_enrolled' | 'likely_graduated' | 'unknown'
export type CrmLifecycleStage = 'active_student' | 'approaching_graduation' | 'recent_graduate' | 'post_graduation' | 'converted'

/** Internal lifecycle_stage (0001_create_enums.sql) -> Bridge Part 6.7 lycert_lifecycle_stage option. */
const LIFECYCLE_STAGE_MAP: Record<string, CrmLifecycleStage> = {
  active_student: 'active_student',
  approaching_graduation: 'approaching_graduation',
  post_graduation_unverified: 'post_graduation',
  re_verification_pending: 'post_graduation',
  converted: 'converted',
  churned: 'post_graduation',
  flagged_review: 'post_graduation',
  dismissed: 'post_graduation',
}

export function mapLifecycleStageForCrm(internal: string): CrmLifecycleStage {
  return LIFECYCLE_STAGE_MAP[internal] ?? 'active_student'
}

/** `now` must be an explicit reference date (never `new Date()` inline) — same determinism rule as scoring. */
export function estimateEducationStatus(statedGraduationDate: string | null, now: Date): CrmEducationStatus {
  if (!statedGraduationDate) return 'unknown'
  const grad = new Date(statedGraduationDate)
  if (Number.isNaN(grad.getTime())) return 'unknown'
  return grad.getTime() < now.getTime() ? 'likely_graduated' : 'likely_enrolled'
}

export type CrmRecommendedOffer = 'graduate_discount' | 'none'

/** Lifecycle stages close to or past graduation get the one offer we have a real signal for. */
const OFFER_TRIGGER_STAGES = new Set(['approaching_graduation', 'post_graduation_unverified', 're_verification_pending'])

export function recommendOffer(internalLifecycleStage: string): CrmRecommendedOffer {
  return OFFER_TRIGGER_STAGES.has(internalLifecycleStage) ? 'graduate_discount' : 'none'
}

export interface SubscriberForWriteback {
  statedGraduationDate: string | null
  lifecycleStage: string
  /** Most recent subscriber_scores.total_score (0-100), or null if never scored. */
  totalScore: number | null
}

/** Builds the full M1+M2 write-back set, HubSpot-ready (string values; dates as YYYY-MM-DD per 6.3). */
export function buildWritebackProperties(sub: SubscriberForWriteback, now: Date): Record<string, string> {
  const props: Record<string, string> = {
    lycert_lifecycle_stage: mapLifecycleStageForCrm(sub.lifecycleStage),
    lycert_education_status: estimateEducationStatus(sub.statedGraduationDate, now),
    lycert_recommended_offer: recommendOffer(sub.lifecycleStage),
    lycert_last_synced: now.toISOString(),
  }
  if (sub.statedGraduationDate) props.lycert_estimated_graduation_date = sub.statedGraduationDate
  if (sub.totalScore !== null) props.lycert_conversion_score = String(sub.totalScore)
  return props
}

/** Stable hash of the write-back payload — write-back only fires when this differs from the stored hash. */
export function hashWritebackProperties(props: Record<string, string>): string {
  const sorted = Object.keys(props).sort().map(k => `${k}=${props[k]}`).join('|')
  return crypto.createHash('sha256').update(sorted).digest('hex')
}

export interface WritebackDecision { shouldWrite: boolean; hash: string; properties: Record<string, string> }

/** Pure diff: compares the freshly computed hash against the last-written hash stored on crm_contact_links. */
export function decideWriteback(sub: SubscriberForWriteback, now: Date, previousHash: string | null): WritebackDecision {
  const properties = buildWritebackProperties(sub, now)
  // lycert_last_synced always changes on every run — exclude it from the diff so we don't write every time
  // just because the clock ticked; a real write still stamps last_synced on whatever we do write.
  const { lycert_last_synced: _omit, ...stable } = properties
  const hash = hashWritebackProperties(stable)
  return { shouldWrite: hash !== previousHash, hash, properties }
}
