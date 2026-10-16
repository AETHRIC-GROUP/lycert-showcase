/**
 * Document-review OCR/forensics SEAM (LYCERT_DOCUMENT_REVIEW_ARCHITECTURE.md Part 3).
 *
 * The interface + a deterministic StubDocumentProvider. Part 3's two-backend split holds: the vision-LLM
 * half (classify/extract) is now implemented in ./claude-vision.ts (built 2026-07-07 on Joshua's live
 * instruction, key-gated on LYCERT_ANTHROPIC_API_KEY — without the key `makeDocumentProvider()` still
 * returns this stub and nothing changed); the forensics half (authenticate) remains deferred until a
 * document-forensics provider is chosen, so tamper flags stay clean/advisory-empty. The stub also keeps
 * the whole pipeline + purge/gate safety paths testable without ingesting anything.
 */

import { ClaudeVisionDocumentProvider, makeClaudeReadDocument, type DownloadDocument } from './claude-vision'

export interface StorageRef {
  bucket: string
  key: string
}

export type DocType = 'student_id' | 'enrollment_cert' | 'tuition_bill' | 'unknown'

export interface DocClassification {
  docType: DocType
  issuerInstitution: string | null
  issuerCountry: string | null
  language: string | null
}

/** Minimal extracted fields ONLY (Part 2 Stage C / Part 5.3). No photo/signature/ID number/DOB/amounts. */
export interface ExtractedFields {
  name: string | null
  institution: string | null
  enrollmentStatus: string | null
  enrollmentEnd: string | null // ISO date
  docIssueDate: string | null // ISO date
  ageEligible: boolean | null // boolean only — never store DOB
}

/** Forensic assistance signals (Part 2 Stage D). Booleans/score only — never the image. */
export interface ForensicFlags {
  tamperRiskScore: number // 0..1
  fontAnomaly: boolean
  templateDeviation: boolean
  metadataAnomaly: boolean
  copyMove: boolean
  composite: boolean
  colorInconsistency: boolean
  perceptualHash: string | null
  physicalSecurityUncheckable: true // ALWAYS true (image-only) — permanent coverage gap (Part 0 Truth 1)
}

export interface DocumentProvider {
  classify(ref: StorageRef): Promise<DocClassification>
  extract(ref: StorageRef, docType: DocType): Promise<ExtractedFields>
  authenticate(ref: StorageRef): Promise<ForensicFlags>
}

/**
 * Deterministic stub: classifies as unknown, extracts nothing, and produces a clean (no-tamper) forensic
 * result with the permanent physical-security gap recorded. It never fabricates an extraction, so a
 * document processed by the stub always lands as 'inconclusive' → human review (never auto-cleared).
 */
export class StubDocumentProvider implements DocumentProvider {
  async classify(_ref: StorageRef): Promise<DocClassification> {
    return { docType: 'unknown', issuerInstitution: null, issuerCountry: null, language: null }
  }
  async extract(_ref: StorageRef, _docType: DocType): Promise<ExtractedFields> {
    return { name: null, institution: null, enrollmentStatus: null, enrollmentEnd: null, docIssueDate: null, ageEligible: null }
  }
  async authenticate(_ref: StorageRef): Promise<ForensicFlags> {
    return {
      tamperRiskScore: 0,
      fontAnomaly: false, templateDeviation: false, metadataAnomaly: false,
      copyMove: false, composite: false, colorInconsistency: false,
      perceptualHash: null,
      physicalSecurityUncheckable: true,
    }
  }
}

/**
 * Factory: the Claude-vision backend when its key AND a storage downloader are available, else the stub.
 * The vision path is additionally inert in practice until the Part 9 gate opens — no document can be
 * uploaded while LYCERT_DOC_REVIEW_ENABLED is off, so setting the key alone activates nothing.
 */
export function makeDocumentProvider(deps?: { download?: DownloadDocument }): DocumentProvider {
  const apiKey = process.env.LYCERT_ANTHROPIC_API_KEY
  if (apiKey && deps?.download) {
    return new ClaudeVisionDocumentProvider({ download: deps.download, readDocument: makeClaudeReadDocument(apiKey) })
  }
  return new StubDocumentProvider()
}
