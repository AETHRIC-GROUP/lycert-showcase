/**
 * Scoring models — TypeScript port of apps/api/scoring/models.py.
 * Keyword lists, country aliases, ScoringConfig defaults, and record/result types.
 * Defaults match the CEDS baseline (vertical 'aec'). Parity oracle: the Python engine.
 */

import type { Confidence, SubscriberVerificationStatus } from '../verification/base'

export const STRONG_PROFESSIONAL_KEYWORDS: string[] = [
  'ceo', 'founder', 'co-founder', 'director', 'vp', 'vice president',
  'president', 'principal', 'partner', 'head of', 'chief', 'owner',
  'freelance', 'self-employed', 'senior', 'lead', 'manager',
  'architect', 'interior designer', 'landscape architect', 'archviz',
  'architectural visualization', '3d visualizer', 'visualization artist',
  'rendering artist', '3d artist', 'cg artist', 'cgi artist', 'bim',
]

export const WEAK_PROFESSIONAL_KEYWORDS: string[] = [
  'analyst', 'associate', 'coordinator', 'specialist', 'technician',
  'engineer', 'developer', 'designer', 'consultant',
]

export const AEC_PROFESSIONAL_KEYWORDS: string[] = [
  'architect', 'interior designer', 'landscape architect', 'archviz',
  'architectural visualization', '3d visualizer', 'visualization artist',
  'rendering artist', '3d artist', 'cg artist', 'cgi artist', 'bim',
]

export const STUDENT_KEYWORDS: string[] = [
  'student', 'intern', 'trainee', 'apprentice', 'phd', 'ph.d',
  'doctoral', 'researcher', 'graduate student', 'msc', 'bsc',
  'bachelor', 'master',
]

export const PERSONAL_DOMAINS: Set<string> = new Set([
  'gmail.com', 'yahoo.com', 'hotmail.com', 'outlook.com', 'live.com',
  'icloud.com', 'protonmail.com', 'mail.com', 'me.com', 'googlemail.com',
  'yahoo.co.uk', 'hotmail.co.uk', 'msn.com', 'aol.com', 'ymail.com',
  'wp.pl', 'naver.com',
])

export const ACADEMIC_INDICATORS: string[] = ['.edu', '.ac.', 'university', '.uni.', 'student.']
export const ACADEMIC_COMPANY_INDICATORS: string[] = ['.edu', '.ac.', 'university', 'school', 'college', 'institute']

export const COUNTRY_ALIASES: Record<string, string> = {
  usa: 'united states',
  us: 'united states',
  'united states of america': 'united states',
  uk: 'united kingdom',
  'great britain': 'united kingdom',
  england: 'united kingdom',
  uae: 'united arab emirates',
  'south korea': 'korea',
  'republic of korea': 'korea',
  'the former yugoslav republic of': 'north macedonia',
  macedonia: 'north macedonia',
  'czech republic': 'czechia',
}

export type ScoringConfig = {
  tier1Threshold: number
  tier2Threshold: number
  tier3Threshold: number
  gracePeriodDays: number

  signalA1Weight: number
  signalA2Weight: number
  signalA3Weight: number
  signalA4Weight: number

  signalB1PersonalWeight: number
  signalB2Weight: number
  signalB3Weight: number

  signalC1Weight: number
  signalC2StrongWeight: number
  signalC2WeakWeight: number
  signalC3Weight: number
  signalC4Weight: number

  signalB1AcademicExculpatory: number
  signalC2StudentExculpatory: number
  signalC3FutureExculpatory: number
  signalC4AcademicExculpatory: number

  verticalTag: string

  strongProfessionalKeywords: string[]
  weakProfessionalKeywords: string[]
  aecProfessionalKeywords: string[]
  studentKeywords: string[]
}

export function defaultScoringConfig(overrides: Partial<ScoringConfig> = {}): ScoringConfig {
  return {
    tier1Threshold: 65,
    tier2Threshold: 40,
    tier3Threshold: 20,
    gracePeriodDays: 90,

    signalA1Weight: 35,
    signalA2Weight: 20,
    signalA3Weight: 20,
    signalA4Weight: 10,

    signalB1PersonalWeight: 8,
    signalB2Weight: 20,
    signalB3Weight: 8,

    signalC1Weight: 25,
    signalC2StrongWeight: 20,
    signalC2WeakWeight: 10,
    signalC3Weight: 15,
    signalC4Weight: 10,

    signalB1AcademicExculpatory: -10,
    signalC2StudentExculpatory: -15,
    signalC3FutureExculpatory: -5,
    signalC4AcademicExculpatory: -5,

    verticalTag: 'aec',

    strongProfessionalKeywords: STRONG_PROFESSIONAL_KEYWORDS,
    weakProfessionalKeywords: WEAK_PROFESSIONAL_KEYWORDS,
    aecProfessionalKeywords: AEC_PROFESSIONAL_KEYWORDS,
    studentKeywords: STUDENT_KEYWORDS,
    ...overrides,
  }
}

/** tenant_scoring_config row (snake_case DB columns), as loaded by the scoring worker. */
export type TenantScoringConfigRow = Partial<Record<string, unknown>>

const ROW_TO_CONFIG: Array<[keyof ScoringConfig, string]> = [
  ['tier1Threshold', 'tier1_threshold'],
  ['tier2Threshold', 'tier2_threshold'],
  ['tier3Threshold', 'tier3_threshold'],
  ['gracePeriodDays', 'grace_period_days'],
  ['signalA1Weight', 'signal_a1_weight'],
  ['signalA2Weight', 'signal_a2_weight'],
  ['signalA3Weight', 'signal_a3_weight'],
  ['signalA4Weight', 'signal_a4_weight'],
  ['signalB1PersonalWeight', 'signal_b1_personal_weight'],
  ['signalB2Weight', 'signal_b2_weight'],
  ['signalB3Weight', 'signal_b3_weight'],
  ['signalC1Weight', 'signal_c1_weight'],
  ['signalC2StrongWeight', 'signal_c2_strong_weight'],
  ['signalC2WeakWeight', 'signal_c2_weak_weight'],
  ['signalC3Weight', 'signal_c3_weight'],
  ['signalC4Weight', 'signal_c4_weight'],
  ['signalB1AcademicExculpatory', 'signal_b1_academic_exculpatory'],
  ['signalC2StudentExculpatory', 'signal_c2_student_exculpatory'],
  ['signalC3FutureExculpatory', 'signal_c3_future_exculpatory'],
  ['signalC4AcademicExculpatory', 'signal_c4_academic_exculpatory'],
]

/**
 * Layer a tenant's stored scoring config over the CEDS defaults (LYCERT_ARCHITECTURE: weights come
 * from tenant_scoring_config, not hardcoded constants). Null row / missing / non-numeric columns fall
 * back to the default value per field, so a tenant without overrides scores byte-identically to CEDS.
 * Keyword sets stay code-level defaults per vertical (they have no DB columns yet).
 */
export function scoringConfigFromRow(row: TenantScoringConfigRow | null | undefined): ScoringConfig {
  const config = defaultScoringConfig()
  if (!row) return config
  for (const [configKey, column] of ROW_TO_CONFIG) {
    const n = Number(row[column])
    if (row[column] != null && Number.isFinite(n)) (config[configKey] as number) = n
  }
  if (typeof row.vertical_tag === 'string' && row.vertical_tag) config.verticalTag = row.vertical_tag
  return config
}

export type SubscriberRecord = {
  email: string
  accountName: string
  institutionName: string
  institutionLocation: string
  accountCountry: string
  // Verified institution email domain (from pre-enrichment). Lets B1 cross-link a student mailbox
  // issued on a subdomain of the school's domain as academic. Empty/undefined → no cross-link.
  institutionDomainVerified?: string
  // PDL Location-Cleaner normalised countries (preferred by B3 when present; raw+alias fallback).
  institutionCountryNormalized?: string
  accountCountryNormalized?: string
  statedGraduationDate: Date | null
  renewalDeltaDays: number | null
  proofSubmissionDate: Date | null
  subscriptionStartDate: Date | null
  subscriptionEndDate: Date | null
  liCurrentEmployerName: string
  liJobEndDate: Date | null // null = currently employed
  liJobTitle: string
  liEducationEndDate: Date | null
  liCurrentEmployerDomain: string
}

export type ScoreResult = {
  totalScore: number
  confidenceTier: number // 0 clean, 1 near-certain, 2 high, 3 watch
  tierLabel: string
  dataConfidence: 'high' | 'medium' | 'low'
  primarySignal: string
  supportingSignals: string
  signalsCount: number
  signalsFired: string
  dataGaps: string
  aecProfessionalConfirmed: boolean
  recommendedAction: string
  scoringVersion: string
  // V1 authoritative-enrollment provenance (Part 7). Present ONLY when a verified status was applied;
  // absent (undefined) for the unverified/no-verification path, so that path's output is unchanged.
  verificationStatus?: SubscriberVerificationStatus
  verificationConfidence?: Confidence | null
  verificationApplied?: boolean
}

/** Signal return: [points, key, description]. */
export type Signal = [number, string, string]
