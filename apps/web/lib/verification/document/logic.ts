/**
 * Pure document-review logic (LYCERT_DOCUMENT_REVIEW_ARCHITECTURE.md Stages E–F + Part 6).
 * Fully buildable/testable now (no OCR needed): cross-reference, the machine recommendation (MEDIUM cap),
 * perceptual-hash repeat detection, and the mapping of a reviewed document → a verification outcome.
 */
import { VerificationOutcome } from '../base'
import type { ExtractedFields, ForensicFlags } from './provider'

// ── Stage E: cross-reference extracted fields vs the subscriber's claim + Institution Trust DB ──────────
export interface SubscriberClaim {
  name: string | null
  institution: string | null
  statedGraduationDate: string | null // ISO
}

export interface CrossRefResult {
  institutionReal: boolean | null
  nameMatchesClaim: boolean | null
  institutionMatchesClaim: boolean | null
  datesConsistent: boolean | null
}

function norm(s: string | null | undefined): string {
  return (s ?? '').toLowerCase().normalize('NFKD').replace(/[^a-z0-9\s]/g, ' ').replace(/\s+/g, ' ').trim()
}
function tokenOverlap(a: string, b: string): number {
  const A = Array.from(new Set(norm(a).split(' ').filter(Boolean)))
  const B = new Set(norm(b).split(' ').filter(Boolean))
  if (!A.length || !B.size) return 0
  const inter = A.filter(t => B.has(t)).length
  return inter / Math.min(A.length, B.size)
}
function yearOf(iso: string | null): number | null {
  if (!iso) return null
  const m = String(iso).match(/^(\d{4})/)
  return m ? Number(m[1]) : null
}

export function crossReference(
  extracted: ExtractedFields,
  claim: SubscriberClaim,
  institutionReal: boolean | null,
): CrossRefResult {
  const nameMatchesClaim = extracted.name && claim.name ? tokenOverlap(extracted.name, claim.name) >= 0.5 : null
  const institutionMatchesClaim =
    extracted.institution && claim.institution ? tokenOverlap(extracted.institution, claim.institution) >= 0.5 : null
  // Dates: a document showing enrollment ending on/after the stated graduation (within a year) is consistent.
  let datesConsistent: boolean | null = null
  const ey = yearOf(extracted.enrollmentEnd)
  const gy = yearOf(claim.statedGraduationDate)
  if (ey != null && gy != null) datesConsistent = Math.abs(ey - gy) <= 1
  return { institutionReal: institutionReal ?? null, nameMatchesClaim, institutionMatchesClaim, datesConsistent }
}

// ── Stage F: machine recommendation (advisory only — a human always decides; MEDIUM cap) ────────────────
export type MachineRecommendation = 'enrolled_medium' | 'inconclusive' | 'suspected_tamper'

const TAMPER_SCORE_THRESHOLD = 0.5

/** A document can never exceed MEDIUM confidence (Part 0 Truth 1 / Part 8). */
export const DOCUMENT_CONFIDENCE = 'medium' as const

export function assessDocument(
  flags: ForensicFlags,
  xref: CrossRefResult,
  opts: { repeatDocument?: boolean } = {},
): { recommendation: MachineRecommendation; confidence: typeof DOCUMENT_CONFIDENCE } {
  const anyForensicFlag =
    flags.tamperRiskScore >= TAMPER_SCORE_THRESHOLD ||
    flags.fontAnomaly || flags.templateDeviation || flags.metadataAnomaly ||
    flags.copyMove || flags.composite || flags.colorInconsistency || !!opts.repeatDocument
  if (anyForensicFlag) return { recommendation: 'suspected_tamper', confidence: DOCUMENT_CONFIDENCE }

  const strongMatch =
    xref.institutionReal === true &&
    xref.nameMatchesClaim === true &&
    xref.institutionMatchesClaim === true &&
    xref.datesConsistent === true
  return { recommendation: strongMatch ? 'enrolled_medium' : 'inconclusive', confidence: DOCUMENT_CONFIDENCE }
}

// ── Perceptual-hash repeat-document detection (Part 1.1 / Stage D) ──────────────────────────────────────
/** Hamming distance over equal-length hex hashes; null when not comparable. */
export function hexHamming(a: string | null, b: string | null): number | null {
  if (!a || !b || a.length !== b.length) return null
  let d = 0
  for (let i = 0; i < a.length; i++) {
    let x = parseInt(a[i], 16) ^ parseInt(b[i], 16)
    while (x) { d += x & 1; x >>= 1 }
  }
  return d
}
/** A hash within `maxDistance` of any prior submission = the same document reused across applicants. */
export function isRepeatDocument(hash: string | null, priorHashes: string[], maxDistance = 5): boolean {
  if (!hash) return false
  for (const p of priorHashes) {
    const d = hexHamming(hash, p)
    if (d != null && d <= maxDistance) return true
  }
  return false
}

// ── Map a reviewed document → a verification waterfall outcome (Part 6) ─────────────────────────────────
export interface DocumentReview {
  reviewStatus: string // 'pending_ocr' | 'pending_review' | 'decided'
  reviewerDecision: string | null // 'approved' | 'rejected' | 'needs_more'
}

/**
 * Document → outcome for the `document` VerificationProvider:
 *  - reviewer approved → ENROLLED (mapped to confidence 'medium' by the document method class).
 *  - reviewer rejected/needs_more, or no decision yet → it can never REFUTE enrollment (image-only), so a
 *    rejected document is UNABLE_TO_CONFIRM, NOT not_enrolled (Part 8). Still-in-flight → DOCUMENT_PENDING.
 */
export function documentReviewToOutcome(review: DocumentReview | null): VerificationOutcome {
  if (!review) return VerificationOutcome.UNABLE_TO_CONFIRM
  if (review.reviewerDecision === 'approved') return VerificationOutcome.ENROLLED
  if (review.reviewerDecision === 'rejected') return VerificationOutcome.UNABLE_TO_CONFIRM
  // pending_ocr / pending_review / needs_more → still waiting on the human-in-the-loop step.
  if (review.reviewStatus !== 'decided') return VerificationOutcome.DOCUMENT_PENDING
  return VerificationOutcome.UNABLE_TO_CONFIRM
}
