/**
 * Canonical field mappers — TS port of the provider-mapping parts of
 * apps/api/services/enrichment/field_mapper.py. Each maps a provider response → canonical
 * subscriber_enrichment fields (dates as ISO 'YYYY-MM-DD' strings), passed through stripToCanonical
 * (GDPR guard). ReverseContact + Datagma share mapLinkedinStyleProfile (Part 1.4).
 */
import { stripToCanonical, type CanonicalFields } from './base'

const pad2 = (n: number): string => String(n).padStart(2, '0')

type MonthYear = { month?: number | null; year?: number | null } | null | undefined

/** {month,year}|{year} → 'YYYY-MM-01' (start dates). null if no year. */
function dateFromMonthYear(d: MonthYear, day = 1, monthFallback = 1): string | null {
  if (!d || !d.year) return null
  const year = Number(d.year)
  const month = Number(d.month ?? monthFallback)
  if (!Number.isFinite(year) || month < 1 || month > 12) return null
  return `${year}-${pad2(month)}-${pad2(day)}`
}

/** Education end → Dec 31 of the end year (conservative — matches the PDL mapper rule). */
function educationEndFromBlock(block: MonthYear): string | null {
  if (!block || !block.year) return null
  return `${Number(block.year)}-12-31`
}

type Position = { title?: string; companyName?: string; startEndDate?: { start?: MonthYear; end?: MonthYear } }
type Education = { schoolName?: string; startEndDate?: { start?: MonthYear; end?: MonthYear } }

/** Current position = the entry whose startEndDate.end is null; else the latest start year. */
function currentPosition(history: Position[]): Position | null {
  if (!history.length) return null
  for (const pos of history) {
    const end = pos.startEndDate?.end
    if (end == null || (typeof end === 'object' && Object.keys(end).length === 0)) return pos
  }
  return [...history].sort((a, b) => (b.startEndDate?.start?.year ?? 0) - (a.startEndDate?.start?.year ?? 0))[0]
}

/** Education entry with the latest end year, else the first. */
function latestEducation(history: Education[]): Education | null {
  if (!history.length) return null
  const withEnd = history.filter(e => e.startEndDate?.end?.year)
  if (withEnd.length) {
    return [...withEnd].sort((a, b) => (b.startEndDate!.end!.year ?? 0) - (a.startEndDate!.end!.year ?? 0))[0]
  }
  return history[0]
}

function bandFromEmployeeCount(count: number | null | undefined): string | null {
  if (count == null) return null
  const n = Number(count)
  if (!Number.isFinite(n)) return null
  if (n <= 10) return '1-10'
  if (n <= 50) return '11-50'
  if (n <= 200) return '51-200'
  if (n <= 500) return '201-500'
  if (n <= 1000) return '501-1000'
  if (n <= 5000) return '1001-5000'
  if (n <= 10000) return '5001-10000'
  return '10001+'
}

/** 'City, Region, Country' → li_city/li_state/li_country (deterministic; no API call). */
function splitLocation(location: string | null | undefined): CanonicalFields {
  if (!location || typeof location !== 'string') return {}
  const parts = location.split(',').map(p => p.trim()).filter(Boolean)
  if (!parts.length) return {}
  const out: CanonicalFields = { li_country: parts[parts.length - 1] }
  if (parts.length >= 2) out.li_city = parts[0]
  if (parts.length >= 3) out.li_state = parts[1]
  return out
}

type Company = { name?: string | null; domain?: string | null; industry?: string | null; size?: string | null; employee_count?: number | null }

export function mapLinkedinStyleProfile(args: {
  linkedinUrl?: string | null
  jobTitle?: string | null
  positionHistory?: Position[] | null
  educationHistory?: Education[] | null
  company?: Company | null
  location?: string | null
}): CanonicalFields {
  const positions = args.positionHistory ?? []
  const educations = args.educationHistory ?? []
  const company = args.company ?? {}
  const current = currentPosition(positions) ?? {}
  const curDates = current.startEndDate ?? {}
  const edu = latestEducation(educations) ?? {}
  const eduDates = edu.startEndDate ?? {}
  const size = company.size ?? bandFromEmployeeCount(company.employee_count)

  const fields: CanonicalFields = {
    linkedin_profile_url: args.linkedinUrl ?? null,
    li_job_title: current.title ?? args.jobTitle ?? null,
    li_current_employer_name: current.companyName ?? company.name ?? null,
    li_current_employer_domain: company.domain ?? null,
    li_employer_industry: company.industry ?? null,
    li_employer_size: size,
    li_job_start_date: dateFromMonthYear(curDates.start),
    li_job_end_date: dateFromMonthYear(curDates.end),
    li_education_institution: edu.schoolName ?? null,
    li_education_end_date: educationEndFromBlock(eduDates.end),
  }
  Object.assign(fields, splitLocation(args.location))
  return stripToCanonical(fields)
}

// ── Hunter (Part 1.2) — no education, no dates → always PARTIAL ────────────────
export function mapHunterPerson(data: Record<string, any>): CanonicalFields {
  const employment = data.employment ?? {}
  const linkedin = data.linkedin ?? {}
  const geo = data.geo ?? {}
  const handle = linkedin.handle
  const seniority = employment.seniority
  return stripToCanonical({
    li_current_employer_name: employment.name ?? null,
    li_current_employer_domain: employment.domain ?? null,
    li_job_title: employment.title ?? null,
    li_job_title_levels: seniority ? [seniority] : null,
    linkedin_profile_url: handle ? `https://linkedin.com/${handle}` : null,
    li_country: geo.country ?? null,
  })
}

// ── ReverseContact (Part 1.3) ─────────────────────────────────────────────────
export function mapReverseContactPerson(body: Record<string, any>): CanonicalFields {
  const person = body.person ?? {}
  const company = body.company ?? {}
  return mapLinkedinStyleProfile({
    linkedinUrl: person.linkedInUrl,
    positionHistory: person.positions?.positionHistory ?? [],
    educationHistory: person.schools?.educationHistory ?? [],
    company: { name: company.name, domain: company.websiteUrl, industry: company.industry, employee_count: company.employeeCount },
    location: person.location,
  })
}

// ── Datagma (Part 1.4) ────────────────────────────────────────────────────────
export function mapDatagmaPerson(body: Record<string, any>): CanonicalFields {
  const person = body.person ?? {}
  const basic = person.basic ?? {}
  const details = person.details ?? {}
  const companyBasic = body.company?.basic ?? {}
  return mapLinkedinStyleProfile({
    linkedinUrl: basic.linkedInUrl,
    jobTitle: basic.title,
    positionHistory: details.positions?.positionHistory ?? [],
    educationHistory: details.schools?.educationHistory ?? [],
    company: { name: companyBasic.name, domain: companyBasic.website, industry: companyBasic.industry, size: companyBasic.size },
    location: basic.location,
  })
}

// ── FullEnrich result `profile` (Part 1.6) ────────────────────────────────────
// Maps the real FullEnrich reverse-email `profile` object (confirmed against
// docs.fullenrich.com/api/v2/contact/reverse/email/bulk, 2026-06-21) — NOT the flat shape the
// earlier stub assumed. Same object arrives via both the GET poll and the webhook `data[]` items.
// GDPR (Part 9): phones and contact_info emails are deliberately NOT extracted.

/** ISO 8601 ('2025-09-01' / '2025-09' / '2025' / full timestamp) → 'YYYY-MM-DD', or null. */
function isoDatePart(s: unknown): string | null {
  if (!s || typeof s !== 'string') return null
  const v = s.trim()
  if (/^\d{4}-\d{2}-\d{2}/.test(v)) return v.slice(0, 10)
  if (/^\d{4}-\d{2}$/.test(v)) return `${v}-01`
  if (/^\d{4}$/.test(v)) return `${v}-01-01`
  return null
}

function yearFromIso(s: unknown): number | null {
  if (!s || typeof s !== 'string') return null
  const m = s.trim().match(/^(\d{4})/)
  return m ? Number(m[1]) : null
}

type FePosition = { title?: string; company?: { name?: string; domain?: string }; is_current?: boolean; start_at?: string; end_at?: string }
type FeEducation = { school_name?: string; degree?: string; start_at?: string; end_at?: string }

export function mapFullenrichProfile(profile: Record<string, any>): CanonicalFields {
  const linkedin = profile?.social_profiles?.professional_network?.url ?? null
  const emp = profile?.employment ?? {}
  const all: FePosition[] = Array.isArray(emp.all) ? emp.all : []
  // employment.current may be absent → fall back to a flagged-current role, else the first listed.
  const current: FePosition = emp.current ?? all.find(e => e?.is_current) ?? all[0] ?? {}
  const company = current.company ?? {}

  const educations: FeEducation[] = Array.isArray(profile?.educations) ? profile.educations : []
  let edu: FeEducation | null = null
  let bestYear = -1
  for (const e of educations) {
    const y = yearFromIso(e?.end_at)
    if (y != null && y > bestYear) { bestYear = y; edu = e }
  }
  if (!edu && educations.length) edu = educations[0]

  const loc = profile?.location ?? {}
  return stripToCanonical({
    linkedin_profile_url: linkedin,
    li_job_title: current.title ?? null,
    li_current_employer_name: company.name ?? null,
    li_current_employer_domain: company.domain ?? null,
    li_job_start_date: isoDatePart(current.start_at),
    li_job_end_date: current.is_current ? null : isoDatePart(current.end_at),
    li_education_institution: edu?.school_name ?? null,
    li_education_end_date: bestYear > 0 ? `${bestYear}-12-31` : null, // conservative — matches PDL/edu rule
    li_country: loc.country ?? null,
    li_state: loc.region ?? null,
    li_city: loc.city ?? null,
  })
}

// ── PDL person (Part 1.5) ─────────────────────────────────────────────────────
function parsePdlDate(s: string | null | undefined): string | null {
  if (!s) return null
  const v = String(s).trim()
  if (/^\d{4}$/.test(v)) return `${v}-01-01`
  if (/^\d{4}-\d{2}$/.test(v)) return `${v}-01`
  if (/^\d{4}-\d{2}-\d{2}$/.test(v)) return v
  return null
}

export function mapPdlPerson(data: Record<string, any>, likelihood: number): CanonicalFields {
  const experience: any[] = data.experience ?? []
  const primaryJob = experience.find(e => e.is_primary) ?? experience[0] ?? {}
  const education: any[] = data.education ?? []

  // Latest education end (year-only → Dec 31), and its institution.
  let eduEnd: string | null = null
  let eduEndRaw = ''
  for (const e of education) {
    const parsed = parsePdlDate(e.end_date)
    if (parsed) {
      const norm = String(e.end_date).length === 4 ? `${String(e.end_date)}-12-31` : parsed
      if (!eduEnd || norm > eduEnd) { eduEnd = norm; eduEndRaw = String(e.end_date) }
    }
  }
  void eduEndRaw
  const withEnd = education.filter(e => e.end_date).sort((a, b) => String(b.end_date).localeCompare(String(a.end_date)))
  const eduInstitution = (withEnd[0] ?? education[0])?.school?.name ?? null

  return stripToCanonical({
    pdl_person_id: data.id ?? null,
    pdl_likelihood_score: likelihood,
    linkedin_profile_url: data.linkedin_url ?? null,
    li_job_title: data.job_title ?? null,
    li_job_title_levels: data.job_title_levels ?? null,
    li_current_employer_name: data.job_company_name ?? null,
    li_current_employer_domain: data.job_company_website ?? null,
    li_current_employer_linkedin_url: data.job_company_linkedin_url ?? null,
    li_employer_size: data.job_company_size ?? null,
    li_employer_industry: data.job_company_industry ?? null,
    li_job_start_date: parsePdlDate(data.job_start_date),
    li_job_end_date: primaryJob.end_date ? parsePdlDate(primaryJob.end_date) : null,
    li_education_institution: eduInstitution,
    li_education_end_date: eduEnd,
    li_country: data.location_country ?? null,
    li_state: data.location_region ?? null,
    li_city: data.location_locality ?? null,
    li_skills: (data.skills ?? []).slice(0, 10),
  })
}

// ── V3 providers (LYCERT_WATERFALL_ENRICHMENT_V3.md Part 1) ────────────────────
// Findymail/Icypeas extended-profile field NAMES are not fully published (Part 10 flags them
// "confirm at impl time"): verified endpoints + documented core fields are mapped; the profile
// extras (LinkedIn URL, company domain) are read defensively and MUST be confirmed against a live
// response on the first benchmark run (set LYCERT_BENCH_DEBUG=1 to dump the raw). Dropcontact's
// result fields ARE verified (developer.dropcontact.com): job/company/website/linkedin.

/** First non-empty value among candidate keys — defensive read for unpublished extended-field names. */
function first(obj: Record<string, any>, ...keys: string[]): unknown {
  for (const k of keys) {
    const v = obj?.[k]
    if (v) return v
  }
  return null
}

/** Findymail reverse-email (with_profile) → canonical (V3 Part 1.1). No education/dates in the
 * documented response → PARTIAL by default. */
type FmJob = { jobTitle?: string; companyName?: string; companyWebsite?: string; companyLinkedinUrl?: string; startDate?: string; endDate?: string | null }
type FmEdu = { school?: string; degree?: string; startDate?: string; endDate?: string | null }

/**
 * Findymail reverse-email (with_profile:true). On a MATCH the profile is the TOP-LEVEL object with
 * `jobs[]` + `educations[]` arrays and `username`/`linkedInId` (NOT a `linkedin_url` field — a miss
 * returns `{linkedin_url:null}`). The earlier mapper read only 4 flat keys and so silently dropped the
 * LinkedIn URL, all employment dates, and all education — confirmed live 2026-06-29 (Clarence Mensah:
 * full jobs[]+educations[] returned, scored as "partial/no-edu"). This extracts the real shape, mirroring
 * the FullEnrich/PDL rule (current job = endDate null else first; education = latest end year → Dec 31).
 */
export function mapFindymailPerson(body: Record<string, any>): CanonicalFields {
  const jobs: FmJob[] = Array.isArray(body.jobs) ? body.jobs : []
  const current: FmJob = jobs.find(j => j && (j.endDate == null || j.endDate === '')) ?? jobs[0] ?? {}

  const educations: FmEdu[] = Array.isArray(body.educations) ? body.educations : []
  let edu: FmEdu | null = null
  let bestYear = -1
  for (const e of educations) {
    const y = yearFromIso(e?.endDate)
    if (y != null && y > bestYear) { bestYear = y; edu = e }
  }
  if (!edu && educations.length) edu = educations[0]

  const username = typeof body.username === 'string' ? body.username : null
  const linkedin =
    (first(body, 'linkedinUrl', 'linkedin_url', 'linkedin', 'profileUrl') as string | undefined) ??
    (username ? `https://www.linkedin.com/in/${username}` : null)

  const isCurrent = current.endDate == null || current.endDate === ''
  return stripToCanonical({
    linkedin_profile_url: linkedin,
    li_job_title: (first(body, 'jobTitle', 'headline') as string | undefined) ?? current.jobTitle ?? null,
    li_current_employer_name: (first(body, 'companyName', 'company') as string | undefined) ?? current.companyName ?? null,
    li_current_employer_domain: first(body, 'companyDomain', 'company_domain', 'domain', 'companyWebsite') ?? current.companyWebsite ?? null,
    li_current_employer_linkedin_url: (body.companyLinkedinUrl as string | undefined) ?? current.companyLinkedinUrl ?? null,
    li_job_start_date: isoDatePart(current.startDate),
    li_job_end_date: isCurrent ? null : isoDatePart(current.endDate),
    li_education_institution: edu?.school ?? null,
    li_education_end_date: bestYear > 0 ? `${bestYear}-12-31` : null,
    li_country: (body.country as string | undefined) ?? null,
    li_state: (body.region as string | undefined) ?? null,
    li_city: (body.city as string | undefined) ?? null,
  })
}

/** Icypeas reverse-lookup `results` → canonical (V3 Part 1.2). If it carries LinkedIn-style
 * positionHistory/educationHistory, route through the shared helper (picks up dates/education);
 * else map flat fields. emails/phones arrays are NEVER read (GDPR, Part 10). */
export function mapIcypeasResults(results: Record<string, any>): CanonicalFields {
  const positions = (first(results, 'positionHistory') as any[] | null)
    ?? results?.positions?.positionHistory ?? []
  const educations = (first(results, 'educationHistory') as any[] | null)
    ?? results?.schools?.educationHistory ?? []
  if ((positions && positions.length) || (educations && educations.length)) {
    return mapLinkedinStyleProfile({
      linkedinUrl: first(results, 'linkedin', 'linkedinUrl', 'linkedInUrl', 'profileUrl') as string | null,
      jobTitle: first(results, 'jobTitle', 'title', 'currentJobTitle') as string | null,
      positionHistory: positions,
      educationHistory: educations,
      company: {
        name: first(results, 'company', 'companyName', 'currentCompany') as string | null,
        domain: first(results, 'companyDomain', 'domain', 'companyWebsite') as string | null,
      },
      location: first(results, 'location', 'city', 'country') as string | null,
    })
  }
  const fields: CanonicalFields = {
    linkedin_profile_url: first(results, 'linkedin', 'linkedinUrl', 'linkedInUrl', 'profileUrl'),
    li_job_title: first(results, 'jobTitle', 'title', 'currentJobTitle'),
    li_current_employer_name: first(results, 'company', 'companyName', 'currentCompany'),
    li_current_employer_domain: first(results, 'companyDomain', 'domain', 'companyWebsite'),
  }
  Object.assign(fields, splitLocation(first(results, 'location') as string | null))
  return stripToCanonical(fields)
}

/** Dropcontact batch result record → canonical (V3 Part 1.3). Verified fields; no education/dates
 * → PARTIAL. */
export function mapDropcontactRecord(rec: Record<string, any>): CanonicalFields {
  return stripToCanonical({
    linkedin_profile_url: rec?.linkedin ?? null,
    li_job_title: rec?.job ?? null,
    li_current_employer_name: rec?.company ?? null,
    li_current_employer_domain: rec?.website ?? null,
  })
}

// ── Apollo (employer only; no education) ──────────────────────────────────────
export function mapApolloPerson(person: Record<string, any>): CanonicalFields {
  const org = person.organization ?? {}
  const empHist: any[] = person.employment_history ?? []
  const current = empHist.find(e => e.current) ?? empHist[0] ?? {}
  const seniority = person.seniority
  return stripToCanonical({
    linkedin_profile_url: person.linkedin_url ?? null,
    li_current_employer_name: org.name ?? null,
    li_current_employer_domain: org.website_url ?? null,
    li_current_employer_linkedin_url: org.linkedin_url ?? null,
    li_employer_size: bandFromEmployeeCount(org.estimated_num_employees),
    li_employer_industry: org.industry ?? null,
    li_job_start_date: parsePdlDate(current.start_date),
    li_job_end_date: parsePdlDate(current.end_date),
    li_job_title: person.title ?? null,
    li_job_title_levels: seniority ? [seniority] : null,
    li_country: person.country ?? null,
    li_state: person.state ?? null,
    li_city: person.city ?? null,
  })
}
