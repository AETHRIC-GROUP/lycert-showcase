/**
 * Lycert scoring engine — TypeScript port of apps/api/scoring/engine.py.
 * Deterministic: same inputs + same referenceDate ⇒ same output. Missing data is never
 * penalised (scored 0, recorded in dataGaps). Parity oracle: the Python engine + CEDS regression.
 */
import type { ScoreResult, ScoringConfig, Signal, SubscriberRecord } from './models'
import { scoreA1, scoreA2, scoreA3, scoreA4 } from './signals/tier-a'
import { scoreB1, scoreB2, scoreB3 } from './signals/tier-b'
import { scoreC1, scoreC2, scoreC3, scoreC4 } from './signals/tier-c'
import { V1_NOT_ENROLLED_ACTION, v1Active, type VerificationSignalInput } from './verification-signal'

export const SCORING_VERSION = '1.0.0'

// (minScore, maxScore, tierNum, label, action)
const TIER_MAP: Array<[number, number, number, string, string]> = [
  [65, 100, 1, 'Near-Certain Violation', 'Contact Now'],
  [40, 64, 2, 'High Confidence Violation', 'Second Wave'],
  [20, 39, 3, 'Watch List', 'Monitor at Renewal'],
  [0, 19, 0, 'Likely Clean', 'No Action'],
]

const A1_STRONG_KEYS = new Set(['A1_renewed_365d_after_grad', 'A1_renewed_180d_after_grad'])

type Tier = 'A' | 'B' | 'C'

export function scoreRow(
  record: SubscriberRecord,
  config: ScoringConfig,
  referenceDate: Date,
  // V1 authoritative-enrollment signal (Part 7). Optional + no-op when absent/unverified, so the
  // existing 3-arg callers and the CEDS regression are byte-identical. See verification-signal.ts.
  verification?: VerificationSignalInput | null,
): ScoreResult {
  let signalsFired: Array<[string, number, string]> = []
  const dataGaps: string[] = []
  let tierAHadData = false
  let tierBHadData = false

  const linkedinPresent = Boolean(
    record.liCurrentEmployerName ||
      record.liJobTitle ||
      record.liEducationEndDate ||
      record.liCurrentEmployerDomain,
  )

  const run = (sig: Signal, tier: Tier): void => {
    const [pts, key, desc] = sig
    if (desc.includes('data_gap')) {
      dataGaps.push(desc)
      return
    }
    if (pts !== 0 || key) {
      if (pts !== 0) {
        if (tier === 'A') tierAHadData = true
        else if (tier === 'B') tierBHadData = true
        signalsFired.push([key, pts, desc])
      }
    }
    if (tier === 'A' && desc && !desc.includes('data_gap')) tierAHadData = true
    if (tier === 'B' && desc && !desc.includes('data_gap')) tierBHadData = true
  }

  run(scoreA1(record, config), 'A')
  run(scoreA2(record, config, referenceDate), 'A')
  run(scoreA3(record, config), 'A')
  run(scoreA4(record, config), 'A')
  run(scoreB1(record, config), 'B')
  run(scoreB2(record, config), 'B')
  run(scoreB3(record, config), 'B')

  if (!linkedinPresent) {
    dataGaps.push('data_gap_linkedin')
  } else {
    run(scoreC1(record, config), 'C')
    run(scoreC2(record, config), 'C')
    run(scoreC3(record, config, referenceDate), 'C')
    run(scoreC4(record, config), 'C')
  }

  // Post-processing: cap A2 at 5 pts when A1 fires at the 180d+ level.
  if (signalsFired.some(([key]) => A1_STRONG_KEYS.has(key))) {
    signalsFired = signalsFired.map(([key, pts, desc]) => [
      key,
      key.startsWith('A2_') ? Math.min(pts, 5) : pts,
      desc,
    ])
  }

  // V1 (Part 7): authoritative enrollment overrides the LinkedIn-derived C3 signal. Remove C3 entirely
  // — an NSC-says-enrolled result supersedes a LinkedIn-says-graduated inference (trust ordering).
  const v1 = v1Active(verification)
  if (v1 && verification!.status === 'verified_enrolled') {
    signalsFired = signalsFired.filter(([key]) => !key.startsWith('C3_'))
  }

  const rawScore = signalsFired.reduce((sum, [, pts]) => sum + pts, 0)
  let totalScore = Math.max(0, Math.min(100, rawScore))

  // V1: verified-enrolled caps suspicion strictly below the Tier-2 threshold (can never be Tier 1/2).
  if (v1 && verification!.status === 'verified_enrolled') {
    totalScore = Math.min(totalScore, config.tier2Threshold - 1)
  }

  let confidenceTier = 0
  let tierLabel = 'Likely Clean'
  let recommendedAction = 'No Action'
  for (const [lo, hi, tierNum, label, action] of TIER_MAP) {
    if (lo <= totalScore && totalScore <= hi) {
      confidenceTier = tierNum
      tierLabel = label
      recommendedAction = action
      break
    }
  }

  let dataConfidence: 'high' | 'medium' | 'low'
  if (tierAHadData && tierBHadData) dataConfidence = 'high'
  else if (tierAHadData || tierBHadData || signalsFired.length >= 3) dataConfidence = 'medium'
  else dataConfidence = 'low'

  let primarySignal = ''
  let supportingSignals = ''
  if (signalsFired.length) {
    const sorted = [...signalsFired].sort((a, b) => b[1] - a[1])
    primarySignal = sorted[0][2]
    supportingSignals = sorted.slice(1).map(s => s[2]).filter(Boolean).join(' | ')
  }

  const c1Active = signalsFired.some(([key]) => key === 'C1_currently_employed')
  const titleLower = record.liJobTitle.trim().toLowerCase()
  const aecMatch = config.aecProfessionalKeywords.some(kw => titleLower.includes(kw))
  const aecProfessionalConfirmed = c1Active && aecMatch

  // V1: verified-not-enrolled is strongly inculpatory but ALWAYS routes to human review — never an
  // automated pricing action (Part 6.3). The enrichment score stands; only the action changes.
  if (v1 && verification!.status === 'verified_not_enrolled') {
    recommendedAction = V1_NOT_ENROLLED_ACTION
  }

  const result: ScoreResult = {
    totalScore,
    confidenceTier,
    tierLabel,
    dataConfidence,
    primarySignal,
    supportingSignals,
    signalsCount: signalsFired.length,
    signalsFired: signalsFired.map(([key]) => key).filter(Boolean).join(', '),
    dataGaps: dataGaps.join(', '),
    aecProfessionalConfirmed,
    recommendedAction,
    scoringVersion: SCORING_VERSION,
  }
  // Only attach V1 provenance when it was actually applied, so a no-verification call returns the
  // exact same object shape as before (the regression / no-op guarantee).
  if (v1) {
    result.verificationStatus = verification!.status
    result.verificationConfidence = verification!.confidence
    result.verificationApplied = true
  }
  return result
}

export function scoreBatch(
  records: SubscriberRecord[],
  config: ScoringConfig,
  referenceDate: Date,
): ScoreResult[] {
  return records.map(r => scoreRow(r, config, referenceDate))
}
