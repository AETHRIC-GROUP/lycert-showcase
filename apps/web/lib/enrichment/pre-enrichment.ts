/**
 * Pre-enrichment — TypeScript port of apps/api/services/enrichment/pre_enrichment.py.
 * Free intelligence layer run at import time (no paid credits):
 *   1. School Cleaner  → institution_name_normalized, domain, country; upsert institutions → trust_tier
 *   2. Location Cleaner ×2 → account_country_normalized, institution_country_normalized
 *   3. Email domain classification
 *   4. Enrichment priority score
 *
 * IO (PDL calls + institutions upsert) is injected so the orchestration is unit-testable with
 * no network/DB. The route wires the real implementations.
 */

// ── Email domain classification ───────────────────────────────────────────────

const PERSONAL_DOMAINS = new Set([
  'gmail.com', 'googlemail.com', 'yahoo.com', 'yahoo.co.uk', 'yahoo.de',
  'yahoo.fr', 'hotmail.com', 'hotmail.co.uk', 'hotmail.de', 'outlook.com',
  'live.com', 'msn.com', 'icloud.com', 'me.com', 'mac.com',
  'aol.com', 'protonmail.com', 'proton.me', 'tutanota.com',
  'web.de', 'gmx.de', 'gmx.net', 'freenet.de', 't-online.de',
  'mail.ru', 'yandex.ru', 'yandex.com',
])

const DISPOSABLE_DOMAINS = new Set([
  'mailinator.com', 'guerrillamail.com', 'temp-mail.org', '10minutemail.com',
  'throwaway.email', 'yopmail.com', 'fakeinbox.com', 'sharklasers.com',
  'trashmail.com', 'dispostable.com', 'maildrop.cc',
])

const ACADEMIC_TLD_RE =
  /\.edu$|\.ac\.[a-z]{2}$|\.edu\.[a-z]{2}$|(^|\.)edu\.|(^|\.)(student|students|etudiant|etudiants|alumni)\.|(^|\.)uni-[a-z]+\.[a-z]+$|(^|\.)fh-[a-z]+\.[a-z]+$|(^|\.)th-[a-z]+\.[a-z]+$|(^|\.)hs-[a-z]+\.[a-z]+$/i

/**
 * Classify an email's domain. The key false-positive guard is the institution cross-link: a genuine
 * student mailbox is frequently issued on a *subdomain* of the school's domain (e.g.
 * `edu.cegepgarneau.ca` under `cegepgarneau.ca`, `campus.ul.pt` under `ul.pt`). Matching only the
 * exact verified domain — or only `.edu`-style TLDs — flags these real students as "corporate".
 * We treat an exact match OR any subdomain of the verified institution domain as academic.
 */
export function classifyEmailDomain(email: string, institutionDomainVerified?: string | null): string {
  if (!email || !email.includes('@')) return 'corporate'
  const domain = email.split('@')[1].toLowerCase().trim()
  if (institutionDomainVerified) {
    const v = institutionDomainVerified.toLowerCase().trim().replace(/^@/, '').replace(/^\*?\./, '')
    if (v && (domain === v || domain.endsWith('.' + v))) return 'academic'
  }
  if (ACADEMIC_TLD_RE.test(domain)) return 'academic'
  if (PERSONAL_DOMAINS.has(domain)) return 'personal'
  if (DISPOSABLE_DOMAINS.has(domain)) return 'disposable'
  return 'corporate'
}

/**
 * Email-domain candidates for an academic_domains lookup, most-specific first. Progressive label
 * strips down to — but not including — a single label: `campus.ul.pt` → ['campus.ul.pt', 'ul.pt'].
 * Stopping at two labels means bare public suffixes (`pt`, `ca`, `edu`) are never generated as
 * candidates; combined with exact equality against the dataset (which holds only registrable/base
 * domains) this means `acme.com` only ever matches if `acme.com` itself is a known academic domain.
 */
export function academicDomainCandidates(domain: string): string[] {
  const d = (domain ?? '').toLowerCase().trim().replace(/^@/, '').replace(/\.+$/, '')
  if (!d || !d.includes('.')) return []
  const parts = d.split('.').filter(Boolean)
  const out: string[] = []
  for (let i = 0; i <= parts.length - 2; i++) out.push(parts.slice(i).join('.'))
  return out
}

// ── Enrichment priority (Part 3.2) ─────────────────────────────────────────────

export function computeEnrichmentPriority(sub: Record<string, unknown>, today: Date = new Date()): number {
  let score = 0
  const gradRaw = sub.stated_graduation_date as string | null
  if (gradRaw) {
    const grad = new Date(String(gradRaw).slice(0, 10))
    if (!Number.isNaN(grad.getTime())) {
      const days = Math.floor((today.getTime() - grad.getTime()) / 86_400_000)
      if (days > 365) score += 40
      else if (days > 180) score += 30
      else if (days > 0) score += 20
      else if (days > -90) score += 15
    }
  }
  const domainType = sub.email_domain_type as string | null
  if (domainType === 'corporate') score += 25
  else if (domainType === 'personal') score += 10
  else if (domainType === 'disposable') score += 20

  const trustTier = sub.institution_trust_tier as string | null
  const pdlVerified = sub.institution_pdl_verified !== false
  if (trustTier === 'suspicious') score += 20
  else if (!pdlVerified) score += 10
  else if (trustTier === 'low') score += 5

  if (sub.auto_renew) score += 5
  return Math.min(score, 100)
}

// ── Mappers (port of field_mapper.map_school_cleaner / map_location_cleaner) ────

export type RawCleaner = Record<string, unknown>

export function mapSchoolCleaner(raw: RawCleaner): Record<string, unknown> {
  const location = (raw.location as RawCleaner) ?? {}
  const country = (raw.country as string) ?? (location.country as string) ?? null
  const normalizedName = (raw.display_name as string) ?? (raw.name as string) ?? null
  return {
    institution_name_normalized: normalizedName,
    institution_domain_verified: (raw.domain as string) ?? null,
    institution_country_normalized: country,
    institution_pdl_verified: true,
  }
}

const INSTITUTION_TYPE_MAP: Record<string, string> = {
  university: 'research_university',
  college: 'teaching_university',
  community_college: 'community_college',
  vocational: 'vocational',
  bootcamp: 'bootcamp',
  online: 'online_only',
}

export function mapSchoolCleanerForInstitutions(raw: RawCleaner): Record<string, unknown> {
  const location = (raw.location as RawCleaner) ?? {}
  const country = (raw.country as string) ?? (location.country as string) ?? null
  const schoolType = (raw.type as string) ?? ''
  return {
    name: (raw.display_name as string) ?? (raw.name as string) ?? null,
    domain: (raw.domain as string) ?? null,
    country,
    institution_type: INSTITUTION_TYPE_MAP[schoolType] ?? 'unknown',
    source: 'pdl_school_cleaner',
    trust_tier: 'medium',
    degree_granting: ['university', 'college', 'community_college'].includes(schoolType),
  }
}

export function mapLocationCleaner(raw: RawCleaner): Record<string, unknown> {
  return { account_country_normalized: (raw.country as string) ?? null }
}

// ── PDL free cleaners (School / Location) ──────────────────────────────────────

const PDL_BASE = 'https://api.peopledatalabs.com/v5'

export async function cleanSchool(name: string, apiKey: string): Promise<RawCleaner | null> {
  const url = `${PDL_BASE}/school/clean?name=${encodeURIComponent(name)}&pretty=false`
  const resp = await fetch(url, { headers: { 'X-Api-Key': apiKey } })
  if (resp.status !== 200) return null
  const body = await resp.json()
  return (body.data as RawCleaner) ?? (body as RawCleaner)
}

export async function cleanLocation(location: string, apiKey: string): Promise<RawCleaner | null> {
  const url = `${PDL_BASE}/location/clean?location=${encodeURIComponent(location)}&pretty=false`
  const resp = await fetch(url, { headers: { 'X-Api-Key': apiKey } })
  if (resp.status !== 200) return null
  const body = await resp.json()
  return (body.data as RawCleaner) ?? (body as RawCleaner)
}

// ── Orchestration ──────────────────────────────────────────────────────────────

export type PreEnrichSubscriber = {
  email?: string | null
  institution_name?: string | null
  account_location?: string | null
  institution_location?: string | null
  stated_graduation_date?: string | null
  auto_renew?: boolean | null
  /** Already-known verified institution domain (from a prior run or import). Used for the email
   *  cross-link when the School Cleaner doesn't resolve a fresh one (e.g. no PDL key). */
  institution_domain_verified?: string | null
}

export type AcademicDomainMatch = { domain: string; name: string; country: string | null }

export type PreEnrichDeps = {
  cleanSchool: (name: string) => Promise<RawCleaner | null>
  cleanLocation: (location: string) => Promise<RawCleaner | null>
  /** Upsert institutions table; return its trust_tier (existing or 'medium'), or null on failure. */
  upsertInstitution: (fields: Record<string, unknown>) => Promise<string | null>
  /** Look up email-domain candidates (most-specific first) against the academic_domains reference
   *  set; returns the matched row (prefer most specific) or null. Optional — when absent, the
   *  false-corporate resolution step is skipped (e.g. a caller with no DB access). */
  lookupAcademicDomain?: (candidates: string[]) => Promise<AcademicDomainMatch | null>
}

/**
 * Run the four free pre-enrichment steps for one subscriber. Never throws — an IO failure on any
 * step produces a partial result (mirrors the Python orchestration). Returns column updates.
 */
export async function runPreEnrichment(
  sub: PreEnrichSubscriber,
  deps: PreEnrichDeps,
): Promise<Record<string, unknown>> {
  const updates: Record<string, unknown> = {}
  const email = sub.email ?? ''
  // Seed with any domain already on the subscriber; the School Cleaner overwrites it if it resolves one.
  let institutionDomainVerified: string | null = sub.institution_domain_verified ?? null

  // Step 1 — School Cleaner
  if (sub.institution_name) {
    try {
      const schoolRaw = await deps.cleanSchool(sub.institution_name)
      if (schoolRaw) {
        Object.assign(updates, mapSchoolCleaner(schoolRaw))
        // Keep the seeded domain if the cleaner didn't resolve a fresh one.
        institutionDomainVerified = (updates.institution_domain_verified as string) ?? institutionDomainVerified
        const trustTier = await deps.upsertInstitution(mapSchoolCleanerForInstitutions(schoolRaw))
        if (trustTier) updates.institution_trust_tier = trustTier
      } else {
        updates.institution_pdl_verified = false
      }
    } catch {
      updates.institution_pdl_verified = false
    }
  }

  // Step 2a — Location Cleaner: account_location
  if (sub.account_location) {
    try {
      const locRaw = await deps.cleanLocation(sub.account_location)
      if (locRaw) Object.assign(updates, mapLocationCleaner(locRaw))
    } catch { /* partial result */ }
  }

  // Step 2b — Location Cleaner: institution_location (only if School Cleaner gave no country)
  if (sub.institution_location) {
    try {
      const instLocRaw = await deps.cleanLocation(sub.institution_location)
      const instCountry = instLocRaw?.country as string | undefined
      if (instCountry && !updates.institution_country_normalized) {
        updates.institution_country_normalized = instCountry
      }
    } catch { /* partial result */ }
  }

  // Step 3 — Email domain classification
  updates.email_domain_type = classifyEmailDomain(email, institutionDomainVerified)

  // Step 3b — False-corporate resolution. A 'corporate' verdict here means the email is not personal,
  // not an academic TLD, and its domain didn't match the (possibly mis-resolved) School-Cleaner
  // domain. Before trusting that, check whether the email's OWN domain is a known academic domain.
  // On a hit we distrust the cleaner: adopt the email's academic domain, keep the submitted
  // institution name (drop PDL's mis-resolved one), and take the dataset's country. Presence — not
  // name similarity — flips it, so a genuine corporate address (e.g. acme.com claiming a school)
  // never matches.
  if (updates.email_domain_type === 'corporate' && deps.lookupAcademicDomain && email.includes('@')) {
    const candidates = academicDomainCandidates(email.split('@')[1])
    if (candidates.length) {
      try {
        const match = await deps.lookupAcademicDomain(candidates)
        if (match) {
          updates.email_domain_type = 'academic'
          updates.institution_domain_verified = match.domain
          updates.institution_name_normalized = null // drop the mis-resolved institution; keep submitted name
          if (match.country) updates.institution_country_normalized = match.country
        }
      } catch { /* lookup failure → leave the corporate verdict untouched */ }
    }
  }

  // Step 4 — Enrichment priority
  updates.enrichment_priority = computeEnrichmentPriority({ ...sub, ...updates })

  return updates
}
