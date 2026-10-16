/** Tier C signals — LinkedIn enrichment data. Port of scoring/signals/tier_c.py. */
import {
  ACADEMIC_COMPANY_INDICATORS,
  type ScoringConfig,
  type Signal,
  type SubscriberRecord,
} from '../models'
import { roundHalfEven } from '../util'

export function scoreC1(record: SubscriberRecord, config: ScoringConfig): Signal {
  if (!record.liCurrentEmployerName) return [0, '', '']
  if (record.liJobEndDate == null) {
    return [config.signalC1Weight, 'C1_currently_employed', `Currently employed full-time at ${record.liCurrentEmployerName} on LinkedIn`]
  }
  return [roundHalfEven((config.signalC1Weight * 5) / 25), 'C1_previously_employed', `Previously employed at ${record.liCurrentEmployerName} on LinkedIn`]
}

export function scoreC2(record: SubscriberRecord, config: ScoringConfig): Signal {
  const title = record.liJobTitle.trim().toLowerCase()
  if (!title) return [0, '', '']
  for (const kw of config.studentKeywords) {
    if (title.includes(kw)) return [config.signalC2StudentExculpatory, 'C2_student_title_exculpatory', `LinkedIn title suggests current student ('${record.liJobTitle}')`]
  }
  for (const kw of config.strongProfessionalKeywords) {
    if (title.includes(kw)) return [config.signalC2StrongWeight, 'C2_professional_title_strong', `LinkedIn title indicates professional role ('${record.liJobTitle}')`]
  }
  for (const kw of config.weakProfessionalKeywords) {
    if (title.includes(kw)) return [config.signalC2WeakWeight, 'C2_professional_title_weak', `LinkedIn title indicates professional role ('${record.liJobTitle}')`]
  }
  return [0, '', '']
}

export function scoreC3(record: SubscriberRecord, config: ScoringConfig, referenceDate: Date): Signal {
  if (record.liEducationEndDate == null) return [0, '', '']
  const year = record.liEducationEndDate.getUTCFullYear()
  const thisYear = referenceDate.getUTCFullYear()
  const w = config.signalC3Weight
  if (year < thisYear - 1) return [w, 'C3_education_ended', `LinkedIn education ended in ${year}`]
  if (year === thisYear - 1) return [roundHalfEven((w * 10) / 15), 'C3_education_ended_last_year', `LinkedIn education ended in ${year}`]
  if (year === thisYear) return [0, '', '']
  return [config.signalC3FutureExculpatory, 'C3_future_graduation_exculpatory', `LinkedIn shows future graduation year (${year})`]
}

export function scoreC4(record: SubscriberRecord, config: ScoringConfig): Signal {
  const domain = record.liCurrentEmployerDomain.trim().toLowerCase()
  if (!domain) return [0, '', '']
  for (const indicator of ACADEMIC_COMPANY_INDICATORS) {
    if (domain.includes(indicator)) {
      return [config.signalC4AcademicExculpatory, 'C4_academic_employer_exculpatory', `Employer domain suggests academic institution (${domain})`]
    }
  }
  return [config.signalC4Weight, 'C4_commercial_employer', `Employer has a commercial domain (${domain})`]
}
