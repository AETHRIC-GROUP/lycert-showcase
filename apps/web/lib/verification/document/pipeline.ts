/**
 * Document-review pipeline orchestration (LYCERT_DOCUMENT_REVIEW_ARCHITECTURE.md Part 2, Stages B–F).
 * Pure over injected deps so it runs end-to-end on the StubDocumentProvider and is fully testable without
 * a real backend. Stage A (consent+capture) and Stage G (purge) are handled by the routes/worker around
 * this; this function turns a stored file + the subscriber's claim into the row of derived results that a
 * HUMAN then reviews (review_status='pending_review' — never auto-decided, Part 1.2).
 */
import type { DocumentProvider, StorageRef } from './provider'
import {
  assessDocument, crossReference, isRepeatDocument, DOCUMENT_CONFIDENCE,
  type MachineRecommendation, type SubscriberClaim,
} from './logic'

export interface DocPipelineDeps {
  provider: DocumentProvider
  /** Institution Trust DB (IPEDS/HESA/ROR/Wikidata/School Cleaner) — is this a real institution? */
  lookupInstitutionReal: (name: string | null) => Promise<boolean | null>
  /** Perceptual hashes of prior submissions (for repeat-document detection). */
  priorHashes: () => Promise<string[]>
}

/** The persisted result of processing one document (maps onto verification_documents columns). */
export interface DocPipelineResult {
  doc_type: string
  issuer_institution: string | null
  issuer_country: string | null
  extracted_name: string | null
  extracted_institution: string | null
  extracted_enrollment_status: string | null
  extracted_enrollment_end: string | null
  extracted_doc_issue_date: string | null
  age_eligible: boolean | null
  tamper_risk_score: number
  flag_font_anomaly: boolean
  flag_template_deviation: boolean
  flag_metadata_anomaly: boolean
  flag_copy_move: boolean
  flag_composite: boolean
  flag_color_inconsistency: boolean
  flag_repeat_document: boolean
  perceptual_hash: string | null
  physical_security_uncheckable: true
  xref_institution_real: boolean | null
  xref_name_matches_claim: boolean | null
  xref_institution_matches_claim: boolean | null
  xref_dates_consistent: boolean | null
  machine_recommendation: MachineRecommendation
  confidence: typeof DOCUMENT_CONFIDENCE
  review_status: 'pending_review'
}

export async function runDocumentPipeline(
  ref: StorageRef,
  claim: SubscriberClaim,
  deps: DocPipelineDeps,
): Promise<DocPipelineResult> {
  // B — classify
  const cls = await deps.provider.classify(ref)
  // C — extract (minimal fields only)
  const fields = await deps.provider.extract(ref, cls.docType)
  // D — authenticate (forensic assistance flags; never auto-rejects)
  const flags = await deps.provider.authenticate(ref)
  const repeat = isRepeatDocument(flags.perceptualHash, await deps.priorHashes())
  // E — cross-reference against the Institution Trust DB + the subscriber's claim
  const institutionReal = await deps.lookupInstitutionReal(fields.institution ?? cls.issuerInstitution)
  const xref = crossReference(fields, claim, institutionReal)
  // F — machine recommendation (advisory; MEDIUM cap; a human decides in the queue)
  const { recommendation, confidence } = assessDocument(flags, xref, { repeatDocument: repeat })

  return {
    doc_type: cls.docType,
    issuer_institution: cls.issuerInstitution,
    issuer_country: cls.issuerCountry,
    extracted_name: fields.name,
    extracted_institution: fields.institution,
    extracted_enrollment_status: fields.enrollmentStatus,
    extracted_enrollment_end: fields.enrollmentEnd,
    extracted_doc_issue_date: fields.docIssueDate,
    age_eligible: fields.ageEligible,
    tamper_risk_score: flags.tamperRiskScore,
    flag_font_anomaly: flags.fontAnomaly,
    flag_template_deviation: flags.templateDeviation,
    flag_metadata_anomaly: flags.metadataAnomaly,
    flag_copy_move: flags.copyMove,
    flag_composite: flags.composite,
    flag_color_inconsistency: flags.colorInconsistency,
    flag_repeat_document: repeat,
    perceptual_hash: flags.perceptualHash,
    physical_security_uncheckable: true,
    xref_institution_real: xref.institutionReal,
    xref_name_matches_claim: xref.nameMatchesClaim,
    xref_institution_matches_claim: xref.institutionMatchesClaim,
    xref_dates_consistent: xref.datesConsistent,
    machine_recommendation: recommendation,
    confidence,
    review_status: 'pending_review',
  }
}
