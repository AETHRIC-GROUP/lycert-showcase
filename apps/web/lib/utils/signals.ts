/**
 * Early CEDS signal computation in TypeScript.
 * Mirrors the Python scoring engine for signals computable without Railway.
 * These are display-only estimates — the authoritative score is from the Python engine.
 */

export type SignalResult = {
  key: string
  tier: 'A' | 'B' | 'C'
  label: string
  points: number
  fired: boolean
  description: string
  dataGap: boolean
}

type SubscriberInput = {
  stated_graduation_date: string | null
  subscription_start_date: string | null
  subscription_end_date: string | null
  renewal_date: string | null
  days_before_last_renewal: number | null
  email_domain_type: string | null
  email: string
  institution_name: string | null
  institution_country_normalized: string | null
  account_country: string | null
  auto_renew: boolean
}

type EnrichmentInput = {
  li_job_title: string | null
  li_current_employer_name: string | null
  li_current_employer_domain: string | null
  li_job_title_levels: string[] | null
  li_education_end_date: string | null
  enrichment_provider: string
} | null

const AEC_STRONG_KEYWORDS = [
  'architect', 'architecture', 'structural engineer', 'civil engineer',
  'mechanical engineer', 'building', 'construction', 'urban planner',
  'interior designer', 'landscape architect', 'bim', 'revit',
]

const AEC_WEAK_KEYWORDS = [
  'designer', 'drafter', 'draftsman', 'cad', 'autocad', 'planning',
  'facilities', 'project manager',
]

function daysBetween(d1: Date, d2: Date): number {
  return Math.floor((d1.getTime() - d2.getTime()) / 86_400_000)
}

function parseDate(s: string | null): Date | null {
  if (!s) return null
  try { return new Date(s) } catch { return null }
}

function matchesKeywords(text: string | null, keywords: string[]): boolean {
  if (!text) return false
  const lower = text.toLowerCase()
  return keywords.some(k => lower.includes(k))
}

export function computeEarlySignals(
  sub: SubscriberInput,
  enrichment: EnrichmentInput = null,
): SignalResult[] {
  const today = new Date()
  const signals: SignalResult[] = []

  // ── Tier A: Renewal / Graduation Timing ───────────────────────────────────

  // A1: Renewed after graduation date
  const gradDate = parseDate(sub.stated_graduation_date)
  const renewalDate = parseDate(sub.renewal_date)
  if (sub.days_before_last_renewal != null && gradDate) {
    const daysDiff = sub.days_before_last_renewal
    if (daysDiff < 0) {
      const pts = daysDiff < -365 ? 35 : daysDiff < -180 ? 25 : 15
      signals.push({
        key: 'A1', tier: 'A',
        label: 'Renewed after graduation',
        points: pts, fired: true,
        description: `Subscription renewed ${Math.abs(daysDiff)} days after stated graduation date`,
        dataGap: false,
      })
    } else {
      signals.push({
        key: 'A1', tier: 'A',
        label: 'Renewed after graduation',
        points: 0, fired: false,
        description: 'Renewal was before graduation — normal',
        dataGap: false,
      })
    }
  } else {
    signals.push({
      key: 'A1', tier: 'A',
      label: 'Renewed after graduation',
      points: 0, fired: false,
      description: 'Renewal date or graduation date not available',
      dataGap: true,
    })
  }

  // A2: Graduation date already past
  if (gradDate) {
    const daysPast = daysBetween(today, gradDate)
    if (daysPast > 0) {
      const pts = daysPast > 365 ? 20 : daysPast > 180 ? 15 : 10
      signals.push({
        key: 'A2', tier: 'A',
        label: 'Graduation date passed',
        points: pts, fired: true,
        description: `Stated graduation was ${daysPast} days ago`,
        dataGap: false,
      })
    } else {
      signals.push({
        key: 'A2', tier: 'A',
        label: 'Graduation date passed',
        points: 0, fired: false,
        description: `Graduation expected in ${Math.abs(daysPast)} days`,
        dataGap: false,
      })
    }
  } else {
    signals.push({
      key: 'A2', tier: 'A',
      label: 'Graduation date passed',
      points: 0, fired: false,
      description: 'No graduation date provided',
      dataGap: true,
    })
  }

  // A3: Proof submitted before subscription started
  // Requires subscription_start_date and proof_submitted_date — usually not available
  signals.push({
    key: 'A3', tier: 'A',
    label: 'Proof before subscription',
    points: 0, fired: false,
    description: 'Proof submission date not captured at import',
    dataGap: true,
  })

  // A4: Subscription duration exceeds program length
  const subStart = parseDate(sub.subscription_start_date)
  const subEnd = parseDate(sub.subscription_end_date)
  if (subStart && gradDate) {
    const subDuration = daysBetween(subEnd ?? today, subStart)
    const standardProgramDays = 4 * 365 // 4-year default
    if (subDuration > standardProgramDays + 90) {
      const pts = subDuration > standardProgramDays + 365 ? 15 : 8
      signals.push({
        key: 'A4', tier: 'A',
        label: 'Subscription exceeds program',
        points: pts, fired: true,
        description: `Subscription active for ${Math.round(subDuration / 365 * 10) / 10} years`,
        dataGap: false,
      })
    } else {
      signals.push({
        key: 'A4', tier: 'A',
        label: 'Subscription exceeds program',
        points: 0, fired: false,
        description: 'Subscription duration within expected range',
        dataGap: false,
      })
    }
  } else {
    signals.push({
      key: 'A4', tier: 'A',
      label: 'Subscription exceeds program',
      points: 0, fired: false,
      description: 'Subscription dates not available for comparison',
      dataGap: !subStart,
    })
  }

  // ── Tier B: Identity Signals ──────────────────────────────────────────────

  // B1: Email domain classification
  const domainType = sub.email_domain_type
  const domain = sub.email.split('@')[1] ?? ''
  if (domainType === 'personal') {
    signals.push({
      key: 'B1', tier: 'B',
      label: 'Email domain',
      points: 15, fired: true,
      description: `Personal email (${domain}) — inconsistent with academic status`,
      dataGap: false,
    })
  } else if (domainType === 'corporate') {
    signals.push({
      key: 'B1', tier: 'B',
      label: 'Email domain',
      points: 25, fired: true,
      description: `Corporate email (${domain}) — strong indicator of professional status`,
      dataGap: false,
    })
  } else if (domainType === 'disposable') {
    signals.push({
      key: 'B1', tier: 'B',
      label: 'Email domain',
      points: 20, fired: true,
      description: `Disposable email (${domain}) — suspicious`,
      dataGap: false,
    })
  } else if (domainType === 'academic') {
    signals.push({
      key: 'B1', tier: 'B',
      label: 'Email domain',
      points: 0, fired: false,
      description: `Academic email (${domain}) — consistent with student status`,
      dataGap: false,
    })
  } else {
    signals.push({
      key: 'B1', tier: 'B',
      label: 'Email domain',
      points: 0, fired: false,
      description: 'Email domain not yet classified — run Pre-Enrich',
      dataGap: true,
    })
  }

  // B2: Institution name quality (basic check)
  if (!sub.institution_name || sub.institution_name.trim().length < 3) {
    signals.push({
      key: 'B2', tier: 'B',
      label: 'Institution name quality',
      points: 10, fired: true,
      description: 'Institution name missing or too short to verify',
      dataGap: false,
    })
  } else {
    signals.push({
      key: 'B2', tier: 'B',
      label: 'Institution name quality',
      points: 0, fired: false,
      description: `Institution name present: ${sub.institution_name}`,
      dataGap: false,
    })
  }

  // B3: Country mismatch (institution vs account)
  const instCountry = sub.institution_country_normalized?.toLowerCase().trim()
  const acctCountry = sub.account_country?.toLowerCase().trim()
  if (instCountry && acctCountry) {
    if (!acctCountry.includes(instCountry) && !instCountry.includes(acctCountry)) {
      signals.push({
        key: 'B3', tier: 'B',
        label: 'Country mismatch',
        points: 10, fired: true,
        description: `Institution country (${instCountry}) differs from account country`,
        dataGap: false,
      })
    } else {
      signals.push({
        key: 'B3', tier: 'B',
        label: 'Country mismatch',
        points: 0, fired: false,
        description: 'Institution and account countries are consistent',
        dataGap: false,
      })
    }
  } else {
    signals.push({
      key: 'B3', tier: 'B',
      label: 'Country mismatch',
      points: 0, fired: false,
      description: 'Institution country not verified — run Pre-Enrich',
      dataGap: !instCountry,
    })
  }

  // ── Tier C: LinkedIn Signals (require enrichment) ─────────────────────────

  if (enrichment) {
    // C1: Currently employed
    if (enrichment.li_current_employer_name) {
      signals.push({
        key: 'C1', tier: 'C',
        label: 'Currently employed',
        points: 15, fired: true,
        description: `Employed at ${enrichment.li_current_employer_name}`,
        dataGap: false,
      })
    } else {
      signals.push({
        key: 'C1', tier: 'C',
        label: 'Currently employed',
        points: 0, fired: false,
        description: 'No current employer found in enrichment data',
        dataGap: false,
      })
    }

    // C2: Job title keywords
    const title = enrichment.li_job_title
    const levels = enrichment.li_job_title_levels ?? []
    const hasStrongKw = matchesKeywords(title, AEC_STRONG_KEYWORDS) ||
      levels.some(l => ['senior', 'manager', 'director', 'vp', 'partner'].includes(l.toLowerCase()))
    const hasWeakKw = matchesKeywords(title, AEC_WEAK_KEYWORDS)
    if (hasStrongKw) {
      signals.push({
        key: 'C2', tier: 'C',
        label: 'Professional job title',
        points: 20, fired: true,
        description: `Title "${title}" matches professional AEC keywords`,
        dataGap: false,
      })
    } else if (hasWeakKw) {
      signals.push({
        key: 'C2', tier: 'C',
        label: 'Professional job title',
        points: 10, fired: true,
        description: `Title "${title}" weakly matches professional keywords`,
        dataGap: false,
      })
    } else if (title) {
      signals.push({
        key: 'C2', tier: 'C',
        label: 'Professional job title',
        points: 0, fired: false,
        description: `Title "${title}" does not match professional keywords`,
        dataGap: false,
      })
    } else {
      signals.push({
        key: 'C2', tier: 'C',
        label: 'Professional job title',
        points: 0, fired: false,
        description: 'No job title in enrichment data',
        dataGap: true,
      })
    }

    // C3: Education end date from LinkedIn
    const eduEnd = parseDate(enrichment.li_education_end_date)
    if (eduEnd) {
      const daysPastEdu = daysBetween(today, eduEnd)
      if (daysPastEdu > 0 && daysPastEdu < 730) {
        signals.push({
          key: 'C3', tier: 'C',
          label: 'Education end date (LinkedIn)',
          points: 15, fired: true,
          description: `LinkedIn education ended ${daysPastEdu} days ago — recently graduated`,
          dataGap: false,
        })
      } else {
        signals.push({
          key: 'C3', tier: 'C',
          label: 'Education end date (LinkedIn)',
          points: 0, fired: false,
          description: `LinkedIn education end: ${enrichment.li_education_end_date}`,
          dataGap: false,
        })
      }
    } else {
      signals.push({
        key: 'C3', tier: 'C',
        label: 'Education end date (LinkedIn)',
        points: 0, fired: false,
        description: enrichment.enrichment_provider === 'apollo'
          ? 'Apollo does not return education history'
          : 'No education end date in enrichment data',
        dataGap: true,
      })
    }

    // C4: Employer domain classification (corporate = suspicious)
    const empDomain = enrichment.li_current_employer_domain
    if (empDomain) {
      signals.push({
        key: 'C4', tier: 'C',
        label: 'Employer domain',
        points: 10, fired: true,
        description: `Employer domain verified: ${empDomain}`,
        dataGap: false,
      })
    } else {
      signals.push({
        key: 'C4', tier: 'C',
        label: 'Employer domain',
        points: 0, fired: false,
        description: 'No employer domain in enrichment data',
        dataGap: true,
      })
    }
  } else {
    // No enrichment — mark all C signals as data gaps
    const cSignals = [
      { key: 'C1', label: 'Currently employed' },
      { key: 'C2', label: 'Professional job title' },
      { key: 'C3', label: 'Education end date (LinkedIn)' },
      { key: 'C4', label: 'Employer domain' },
    ]
    for (const s of cSignals) {
      signals.push({
        key: s.key, tier: 'C',
        label: s.label,
        points: 0, fired: false,
        description: 'Requires enrichment — click Enrich on this subscriber',
        dataGap: true,
      })
    }
  }

  return signals
}

export function computeTotalScore(signals: SignalResult[]): number {
  return signals.reduce((sum, s) => sum + s.points, 0)
}

export function computeTier(score: number): { tier: number; label: string; color: string } {
  if (score >= 60) return { tier: 1, label: 'Tier 1 — High Risk', color: 'red' }
  if (score >= 35) return { tier: 2, label: 'Tier 2 — Medium Risk', color: 'orange' }
  if (score >= 15) return { tier: 3, label: 'Tier 3 — Low Risk', color: 'yellow' }
  return { tier: 0, label: 'Clean', color: 'green' }
}
