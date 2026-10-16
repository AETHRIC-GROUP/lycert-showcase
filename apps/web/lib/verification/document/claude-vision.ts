/**
 * Claude-vision backend for the DocumentProvider seam — Stages B (classify) + C (extract) ONLY.
 * (LYCERT_DOCUMENT_REVIEW_ARCHITECTURE.md Part 3: vision-LLM for classify/extract; the forensics API for
 * Stage D authenticate is a SEPARATE deferred backend — this class deliberately returns clean forensic
 * flags plus an exact-content hash, it does NOT pretend to do tamper analysis.)
 *
 * Built 2026-07-07 on Joshua's live instruction (supersedes the spec's "seam + stub only" defer — same
 * pattern as the verification layer's "do not build yet" header). Every safety gate still holds:
 *  - DORMANT without `LYCERT_ANTHROPIC_API_KEY` — makeDocumentProvider() returns the stub.
 *  - Upload itself stays gated by LYCERT_DOC_REVIEW_ENABLED + document-specific consent, so no real
 *    student document can even reach this code until the Part 9 gate opens (incl. the Anthropic
 *    sub-processor DPA — seeded inactive in sub_processor_registry).
 *  - Data minimization (Art.5(1)(c)) is enforced twice: the prompt forbids transcribing ID numbers/DOB/
 *    address/amounts, and the structured-output schema simply has no fields to put them in.
 *  - Any failure (refusal, API error, unsupported format) degrades to the stub's empty read →
 *    'inconclusive' → human review. It never throws away a stored document and never auto-clears.
 */
import crypto from 'crypto'
import Anthropic from '@anthropic-ai/sdk'
import { zodOutputFormat } from '@anthropic-ai/sdk/helpers/zod'
// The SDK's zod helper is typed against the v4 API, which zod 3.25+ ships under the 'zod/v4' subpath.
import { z } from 'zod/v4'
import type {
  DocClassification,
  DocType,
  DocumentProvider,
  ExtractedFields,
  ForensicFlags,
  StorageRef,
} from './provider'

/** Raw bytes of the stored document, injected so this module never touches storage directly. */
export interface DocumentBytes {
  bytes: Buffer
  contentType: string
}
export type DownloadDocument = (ref: StorageRef) => Promise<DocumentBytes>

/** Default model for classify+extract; override via LYCERT_ANTHROPIC_MODEL. */
export const DEFAULT_VISION_MODEL = 'claude-opus-4-8'

/**
 * Age-eligibility threshold the model answers against when a DOB is visible (the DOB itself is never
 * transcribed — boolean only, Part 5.3). Placeholder pending legal review, like the consent text.
 */
export const AGE_ELIGIBILITY_MIN_YEARS = 16

/** Media types Claude vision accepts. HEIC is NOT among them → degrades to the empty read. */
const IMAGE_TYPES = new Set(['image/jpeg', 'image/png', 'image/gif', 'image/webp'])
const PDF_TYPE = 'application/pdf'

// Structured-output schema = the ONLY fields the model can return (data minimization by construction).
const DocReadSchema = z.object({
  doc_type: z.enum(['student_id', 'enrollment_cert', 'tuition_bill', 'unknown']),
  issuer_institution: z.string().nullable(),
  issuer_country: z.string().nullable(), // ISO 3166-1 alpha-2
  language: z.string().nullable(), // ISO 639-1 of the document's main language
  name: z.string().nullable(),
  institution: z.string().nullable(),
  enrollment_status: z.string().nullable(),
  enrollment_end: z.string().nullable(), // YYYY-MM-DD
  doc_issue_date: z.string().nullable(), // YYYY-MM-DD
  age_eligible: z.boolean().nullable(),
})
export type DocRead = z.infer<typeof DocReadSchema>

const EXTRACTION_SYSTEM = `You are the classify+extract stage of a document-review pipeline that verifies student enrollment for educational software licenses. You will be shown ONE uploaded document — expected types: student ID card, enrollment certificate/letter, or tuition bill.

Rules (these implement binding GDPR data-minimization requirements — Art.5(1)(c)):
1. Return ONLY the fields in the output schema. NEVER transcribe or describe: national/student/passport ID numbers, date of birth, home address, financial amounts, photos, or signatures.
2. age_eligible: if a date of birth is visible, return whether the person is at least ${AGE_ELIGIBILITY_MIN_YEARS} years old today — a boolean only, never the date. If no date of birth is visible, return null.
3. If a field is absent or unreadable, return null. Never guess or fabricate a value.
4. Dates (enrollment_end, doc_issue_date) must be ISO format YYYY-MM-DD. If only month+year are shown, use the first day of that month. If ambiguous, return null.
5. issuer_country is the ISO 3166-1 alpha-2 code of the issuing institution's country; language is the ISO 639-1 code of the document's main language.
6. doc_type: 'student_id' for ID cards, 'enrollment_cert' for enrollment certificates/letters/confirmations, 'tuition_bill' for tuition/fee invoices or payment confirmations, 'unknown' for anything else or when unsure.
7. enrollment_status: the document's own wording for the person's status (e.g. "enrolled", "full-time student", "matriculated"), translated to English if needed.
8. name / institution: exactly as printed (person's full name; institution's official name).`

const EMPTY_READ: DocRead = {
  doc_type: 'unknown',
  issuer_institution: null,
  issuer_country: null,
  language: null,
  name: null,
  institution: null,
  enrollment_status: null,
  enrollment_end: null,
  doc_issue_date: null,
  age_eligible: null,
}

/** Minimal surface of the model call, injectable for tests. */
export type ReadDocumentFn = (doc: DocumentBytes) => Promise<DocRead>

function isoDateOrNull(s: string | null): string | null {
  return s && /^\d{4}-\d{2}-\d{2}$/.test(s) ? s : null
}

/** Post-validate the model's read: enforce date shape + normalize country/language codes. */
export function sanitizeDocRead(read: DocRead): DocRead {
  const code = (v: string | null, len: number) => {
    const t = (v ?? '').trim()
    return t.length === len && /^[a-zA-Z]+$/.test(t) ? t.toUpperCase() : null
  }
  return {
    ...read,
    issuer_country: code(read.issuer_country, 2),
    language: code(read.language, 2)?.toLowerCase() ?? null,
    enrollment_end: isoDateOrNull(read.enrollment_end),
    doc_issue_date: isoDateOrNull(read.doc_issue_date),
  }
}

/** Build the single vision content block for the document (image or PDF). Null = format unsupported. */
export function buildDocumentBlock(doc: DocumentBytes): Anthropic.ContentBlockParam | null {
  const data = doc.bytes.toString('base64')
  if (doc.contentType === PDF_TYPE) {
    return { type: 'document', source: { type: 'base64', media_type: 'application/pdf', data } }
  }
  if (IMAGE_TYPES.has(doc.contentType)) {
    return {
      type: 'image',
      source: { type: 'base64', media_type: doc.contentType as 'image/jpeg' | 'image/png' | 'image/gif' | 'image/webp', data },
    }
  }
  return null // e.g. image/heic — accepted at upload but not readable by the vision backend
}

/** The real model call (one request does both classify + extract). */
export function makeClaudeReadDocument(apiKey: string, model?: string): ReadDocumentFn {
  const client = new Anthropic({ apiKey })
  const modelId = model || process.env.LYCERT_ANTHROPIC_MODEL || DEFAULT_VISION_MODEL
  return async (doc) => {
    const block = buildDocumentBlock(doc)
    if (!block) return EMPTY_READ
    const response = await client.messages.parse({
      model: modelId,
      max_tokens: 16000,
      thinking: { type: 'adaptive' },
      system: EXTRACTION_SYSTEM,
      messages: [
        {
          role: 'user',
          content: [block, { type: 'text', text: 'Classify this document and extract the schema fields.' }],
        },
      ],
      output_config: { format: zodOutputFormat(DocReadSchema) },
    })
    // A safety refusal or unparseable output degrades to the empty read → human review, never a crash.
    if (response.stop_reason === 'refusal' || !response.parsed_output) return EMPTY_READ
    return sanitizeDocRead(response.parsed_output)
  }
}

export interface ClaudeVisionDeps {
  download: DownloadDocument
  readDocument: ReadDocumentFn
}

export class ClaudeVisionDocumentProvider implements DocumentProvider {
  // One model call serves both classify() and extract() (the pipeline calls them back-to-back on the
  // same ref); memoized per storage key so a document is read exactly once.
  private reads = new Map<string, Promise<DocRead>>()
  private bytes = new Map<string, Promise<DocumentBytes | null>>()

  constructor(private deps: ClaudeVisionDeps) {}

  private getBytes(ref: StorageRef): Promise<DocumentBytes | null> {
    const key = `${ref.bucket}/${ref.key}`
    let p = this.bytes.get(key)
    if (!p) {
      p = this.deps.download(ref).catch((e) => {
        console.warn('[document/claude-vision] download failed %s: %s', key, String(e))
        return null
      })
      this.bytes.set(key, p)
    }
    return p
  }

  private read(ref: StorageRef): Promise<DocRead> {
    const key = `${ref.bucket}/${ref.key}`
    let p = this.reads.get(key)
    if (!p) {
      p = this.getBytes(ref)
        .then((doc) => (doc ? this.deps.readDocument(doc) : EMPTY_READ))
        .catch((e) => {
          console.warn('[document/claude-vision] read failed %s: %s', key, String(e))
          return EMPTY_READ
        })
      this.reads.set(key, p)
    }
    return p
  }

  async classify(ref: StorageRef): Promise<DocClassification> {
    const r = await this.read(ref)
    return {
      docType: r.doc_type as DocType,
      issuerInstitution: r.issuer_institution,
      issuerCountry: r.issuer_country,
      language: r.language,
    }
  }

  async extract(ref: StorageRef, _docType: DocType): Promise<ExtractedFields> {
    const r = await this.read(ref)
    return {
      name: r.name,
      institution: r.institution,
      enrollmentStatus: r.enrollment_status,
      enrollmentEnd: r.enrollment_end,
      docIssueDate: r.doc_issue_date,
      ageEligible: r.age_eligible,
    }
  }

  /**
   * Stage D stays with the deferred forensics backend (a vision-LLM is NOT a tamper-analysis tool —
   * Part 3). This returns clean flags + a SHA-256 content hash: exact-file reuse across applicants now
   * trips flag_repeat_document (hexHamming distance 0); near-duplicate perceptual matching arrives with
   * the real forensics backend.
   */
  async authenticate(ref: StorageRef): Promise<ForensicFlags> {
    const doc = await this.getBytes(ref)
    return {
      tamperRiskScore: 0,
      fontAnomaly: false,
      templateDeviation: false,
      metadataAnomaly: false,
      copyMove: false,
      composite: false,
      colorInconsistency: false,
      perceptualHash: doc ? crypto.createHash('sha256').update(doc.bytes).digest('hex') : null,
      physicalSecurityUncheckable: true,
    }
  }
}
