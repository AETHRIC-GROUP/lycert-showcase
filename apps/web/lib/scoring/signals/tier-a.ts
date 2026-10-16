/** Tier A signals — billing data (highest weight). Port of scoring/signals/tier_a.py. */
import type { ScoringConfig, Signal, SubscriberRecord } from '../models'
import { dateDiffDays, roundHalfEven } from '../util'

export function scoreA1(record: SubscriberRecord, config: ScoringConfig): Signal {
  if (record.renewalDeltaDays == null) return [0, '', 'data_gap_renewal']
  const days = record.renewalDeltaDays
  const w = config.signalA1Weight
  const ad = Math.abs(days)
  if (days < -365) return [w, 'A1_renewed_365d_after_grad', `Renewed ${ad} days after stated graduation date`]
  if (days < -180) return [roundHalfEven((w * 30) / 35), 'A1_renewed_180d_after_grad', `Renewed ${ad} days after stated graduation date`]
  if (days < -90) return [roundHalfEven((w * 25) / 35), 'A1_renewed_90d_after_grad', `Renewed ${ad} days after stated graduation date`]
  if (days < 0) return [roundHalfEven((w * 15) / 35), 'A1_renewed_after_grad', `Renewed ${ad} days after stated graduation date`]
  if (days <= 90) return [roundHalfEven((w * 5) / 35), 'A1_renewed_near_graduation', `Renewed within ${days} days of graduation`]
  return [0, '', '']
}

export function scoreA2(record: SubscriberRecord, config: ScoringConfig, referenceDate: Date): Signal {
  if (record.statedGraduationDate == null) return [0, '', 'data_gap_graduation']
  const delta = dateDiffDays(referenceDate, record.statedGraduationDate)
  if (delta <= 0) return [0, '', '']
  const w = config.signalA2Weight
  if (delta <= 90) return [roundHalfEven((w * 5) / 20), 'A2_graduated_recently', `Graduated ${delta} days ago (recently past)`]
  if (delta <= 180) return [roundHalfEven((w * 10) / 20), 'A2_graduated_3_6mo_ago', `Graduated ${delta} days ago (3–6 months)`]
  if (delta <= 365) return [roundHalfEven((w * 15) / 20), 'A2_graduated_6_12mo_ago', `Graduated ${delta} days ago (6–12 months)`]
  return [w, 'A2_graduated_over_1yr_ago', `Graduated ${delta} days ago (over 1 year)`]
}

export function scoreA3(record: SubscriberRecord, config: ScoringConfig): Signal {
  if (record.proofSubmissionDate == null || record.subscriptionStartDate == null) return [0, '', '']
  const delta = dateDiffDays(record.subscriptionStartDate, record.proofSubmissionDate)
  const w = config.signalA3Weight
  if (delta > 30) return [w, 'A3_proof_predates_subscription', `Proof of enrollment submitted ${delta} days before subscription existed`]
  if (delta >= 0) return [roundHalfEven((w * 5) / 20), 'A3_proof_slightly_early', `Proof of enrollment submitted ${delta} days before subscription start`]
  return [0, '', '']
}

export function scoreA4(record: SubscriberRecord, config: ScoringConfig): Signal {
  if (record.subscriptionStartDate == null || record.subscriptionEndDate == null) return [0, '', '']
  const duration = dateDiffDays(record.subscriptionEndDate, record.subscriptionStartDate)
  if (duration > 730) return [config.signalA4Weight, 'A4_subscription_over_2yrs', `Subscription active for ${duration} days (over 2 years)`]
  return [0, '', '']
}
