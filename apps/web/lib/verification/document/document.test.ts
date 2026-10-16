/**
 * Document-review pipeline (LYCERT_DOCUMENT_REVIEW_ARCHITECTURE.md) — the dormant backbone's safety + logic.
 * Mirrors the Part 9 test list: upload gate (flag off / consent), purge selection, MEDIUM cap,
 * suspected_tamper never auto-decides, cross-reference flags, perceptual-hash repeat detection, the stub
 * pipeline (→ inconclusive/pending_review), and the waterfall outcome mapping.
 */
import { describe, it, expect } from 'vitest'
import { VerificationOutcome } from '../base'
import { checkUploadAllowed } from './gate'
import { selectPurgeable, purgedPatch } from './purge'
import {
  crossReference, assessDocument, hexHamming, isRepeatDocument, documentReviewToOutcome, DOCUMENT_CONFIDENCE,
} from './logic'
import { StubDocumentProvider, makeDocumentProvider, type ForensicFlags } from './provider'
import { runDocumentPipeline } from './pipeline'
import { makeDocumentProvider as makeWaterfallDocumentProvider } from '../providers/document'

const cleanFlags: ForensicFlags = {
  tamperRiskScore: 0, fontAnomaly: false, templateDeviation: false, metadataAnomaly: false,
  copyMove: false, composite: false, colorInconsistency: false, perceptualHash: null, physicalSecurityUncheckable: true,
}

describe('upload gate (Part 9)', () => {
  it('blocks when the flag is off — stores nothing', () => {
    expect(checkUploadAllowed(false, true)).toEqual({ allowed: false, reason: 'disabled' })
  })
  it('blocks when there is no document-specific consent', () => {
    expect(checkUploadAllowed(true, false)).toEqual({ allowed: false, reason: 'no_consent' })
  })
  it('allows only when BOTH flag on and consent present', () => {
    expect(checkUploadAllowed(true, true)).toEqual({ allowed: true })
  })
})

describe('process-and-purge selection (Stage G)', () => {
  const NOW = new Date('2026-06-30T12:00:00Z')
  const base = { id: 'd', transient_storage_ref: 'k', storage_delete_at: '2026-06-30T11:00:00Z', purged_at: null }
  it('selects due, unpurged rows that still hold a raw file', () => {
    expect(selectPurgeable([base], NOW)).toHaveLength(1)
  })
  it('excludes already-purged, already-ref-nulled, and not-yet-due rows', () => {
    expect(selectPurgeable([{ ...base, purged_at: '2026-06-30T11:30:00Z' }], NOW)).toHaveLength(0)
    expect(selectPurgeable([{ ...base, transient_storage_ref: null }], NOW)).toHaveLength(0)
    expect(selectPurgeable([{ ...base, storage_delete_at: '2026-06-30T18:00:00Z' }], NOW)).toHaveLength(0)
  })
  it('purgedPatch nulls the ref and stamps purged_at', () => {
    const p = purgedPatch(NOW)
    expect(p.transient_storage_ref).toBeNull()
    expect(p.purged_at).toBe(NOW.toISOString())
  })
})

describe('assess (Stage F) — MEDIUM cap + tamper never auto-decides', () => {
  const strongXref = { institutionReal: true, nameMatchesClaim: true, institutionMatchesClaim: true, datesConsistent: true }
  it('strong cross-ref + clean forensics → enrolled_medium (capped at medium)', () => {
    const r = assessDocument(cleanFlags, strongXref)
    expect(r.recommendation).toBe('enrolled_medium')
    expect(r.confidence).toBe(DOCUMENT_CONFIDENCE)
    expect(r.confidence).toBe('medium')
  })
  it('any forensic flag → suspected_tamper (a RECOMMENDATION, not an action)', () => {
    expect(assessDocument({ ...cleanFlags, copyMove: true }, strongXref).recommendation).toBe('suspected_tamper')
    expect(assessDocument({ ...cleanFlags, tamperRiskScore: 0.7 }, strongXref).recommendation).toBe('suspected_tamper')
    expect(assessDocument(cleanFlags, strongXref, { repeatDocument: true }).recommendation).toBe('suspected_tamper')
  })
  it('weak/partial cross-ref → inconclusive (never auto-enrolled)', () => {
    expect(assessDocument(cleanFlags, { ...strongXref, nameMatchesClaim: false }).recommendation).toBe('inconclusive')
    expect(assessDocument(cleanFlags, { institutionReal: null, nameMatchesClaim: null, institutionMatchesClaim: null, datesConsistent: null }).recommendation).toBe('inconclusive')
  })
})

describe('cross-reference (Stage E)', () => {
  it('matches name/institution by token overlap and date by year proximity', () => {
    const r = crossReference(
      { name: 'Jane Q Doe', institution: 'Stanford University', enrollmentStatus: null, enrollmentEnd: '2026-05-01', docIssueDate: null, ageEligible: null },
      { name: 'Jane Doe', institution: 'Stanford', statedGraduationDate: '2026-06-01' },
      true,
    )
    expect(r).toEqual({ institutionReal: true, nameMatchesClaim: true, institutionMatchesClaim: true, datesConsistent: true })
  })
  it('flags mismatches', () => {
    const r = crossReference(
      { name: 'Bob Smith', institution: 'MIT', enrollmentStatus: null, enrollmentEnd: '2019-05-01', docIssueDate: null, ageEligible: null },
      { name: 'Jane Doe', institution: 'Stanford', statedGraduationDate: '2026-06-01' },
      false,
    )
    expect(r.nameMatchesClaim).toBe(false)
    expect(r.institutionMatchesClaim).toBe(false)
    expect(r.datesConsistent).toBe(false)
    expect(r.institutionReal).toBe(false)
  })
})

describe('perceptual-hash repeat detection', () => {
  it('hamming distance + repeat within threshold', () => {
    expect(hexHamming('ffff', 'ffff')).toBe(0)
    expect(hexHamming('ffff', 'fffe')).toBe(1)
    expect(hexHamming('ff', 'ffff')).toBeNull() // different lengths
    expect(isRepeatDocument('ffff', ['0000', 'fffe'], 2)).toBe(true)
    expect(isRepeatDocument('ffff', ['0000'], 2)).toBe(false)
    expect(isRepeatDocument(null, ['ffff'])).toBe(false)
  })
})

describe('documentReviewToOutcome (Part 6 waterfall mapping)', () => {
  it('approved → ENROLLED; rejected → UNABLE_TO_CONFIRM (never refutes); pending → DOCUMENT_PENDING; none → UNABLE', () => {
    expect(documentReviewToOutcome({ reviewStatus: 'decided', reviewerDecision: 'approved' })).toBe(VerificationOutcome.ENROLLED)
    expect(documentReviewToOutcome({ reviewStatus: 'decided', reviewerDecision: 'rejected' })).toBe(VerificationOutcome.UNABLE_TO_CONFIRM)
    expect(documentReviewToOutcome({ reviewStatus: 'pending_review', reviewerDecision: null })).toBe(VerificationOutcome.DOCUMENT_PENDING)
    expect(documentReviewToOutcome(null)).toBe(VerificationOutcome.UNABLE_TO_CONFIRM)
  })
})

describe('stub pipeline (Stage B–F on the StubDocumentProvider)', () => {
  it('extracts nothing, raises no tamper flag, lands inconclusive → pending_review, records the physical-security gap', async () => {
    const result = await runDocumentPipeline(
      { bucket: 'verification-documents', key: 'k' },
      { name: 'Jane', institution: 'Stanford', statedGraduationDate: '2026-06-01' },
      { provider: new StubDocumentProvider(), lookupInstitutionReal: async () => null, priorHashes: async () => [] },
    )
    expect(result.machine_recommendation).toBe('inconclusive')
    expect(result.confidence).toBe('medium')
    expect(result.review_status).toBe('pending_review')
    expect(result.physical_security_uncheckable).toBe(true)
    expect(result.extracted_name).toBeNull()
    expect(result.tamper_risk_score).toBe(0)
  })
})

describe('waterfall document provider wiring', () => {
  it('dormant by default → UNABLE_TO_CONFIRM, never adverse', async () => {
    const p = makeWaterfallDocumentProvider()
    expect(p.canAssertNotEnrolled).toBe(false)
    const r = await p.verify({ subscriberId: 's', tenantId: 't', email: null, name: null, institutionName: null, institutionCountry: null, statedGraduationDate: null }, null)
    expect(r.outcome).toBe(VerificationOutcome.UNABLE_TO_CONFIRM)
  })
  it('with an approved review wired → ENROLLED at medium confidence', async () => {
    const p = makeWaterfallDocumentProvider({ getLatestReview: async () => ({ reviewStatus: 'decided', reviewerDecision: 'approved' }) })
    const r = await p.verify({ subscriberId: 's', tenantId: 't', email: null, name: null, institutionName: null, institutionCountry: null, statedGraduationDate: null }, null)
    expect(r.outcome).toBe(VerificationOutcome.ENROLLED)
    expect(r.confidence).toBe('medium')
  })
})

// makeDocumentProvider (the OCR seam stub) sanity
describe('OCR seam stub', () => {
  it('classifies unknown + extracts nothing (no network)', async () => {
    const p = makeDocumentProvider()
    expect((await p.classify({ bucket: 'b', key: 'k' })).docType).toBe('unknown')
    expect((await p.extract({ bucket: 'b', key: 'k' }, 'unknown')).name).toBeNull()
    expect((await p.authenticate({ bucket: 'b', key: 'k' })).physicalSecurityUncheckable).toBe(true)
  })
})
