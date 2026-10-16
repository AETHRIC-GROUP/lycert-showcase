/**
 * Claude-vision DocumentProvider backend (Stages B+C) — LYCERT_DOCUMENT_REVIEW_ARCHITECTURE.md Part 3.
 * The model call is injected (ReadDocumentFn), so these tests exercise the provider's safety behaviour
 * (dormancy without the key, single-read memoization, graceful degradation to the empty read, forensic
 * conservatism) without any network.
 */
import { afterEach, describe, expect, it, vi } from 'vitest'
import crypto from 'crypto'
import {
  AGE_ELIGIBILITY_MIN_YEARS,
  buildDocumentBlock,
  ClaudeVisionDocumentProvider,
  sanitizeDocRead,
  type DocRead,
  type DocumentBytes,
} from './claude-vision'
import { makeDocumentProvider, StubDocumentProvider } from './provider'
import { runDocumentPipeline } from './pipeline'

const REF = { bucket: 'verification-documents', key: 't/s/doc.png' }

const FULL_READ: DocRead = {
  doc_type: 'enrollment_cert',
  issuer_institution: 'University of Malta',
  issuer_country: 'MT',
  language: 'en',
  name: 'Maria Vella',
  institution: 'University of Malta',
  enrollment_status: 'enrolled full-time',
  enrollment_end: '2027-06-30',
  doc_issue_date: '2026-06-01',
  age_eligible: true,
}

function bytesOf(s: string, contentType = 'image/png'): DocumentBytes {
  return { bytes: Buffer.from(s), contentType }
}

describe('makeDocumentProvider factory (dormancy gate)', () => {
  afterEach(() => {
    delete process.env.LYCERT_ANTHROPIC_API_KEY
  })

  it('returns the stub when LYCERT_ANTHROPIC_API_KEY is unset (even with a downloader)', () => {
    delete process.env.LYCERT_ANTHROPIC_API_KEY
    const p = makeDocumentProvider({ download: async () => bytesOf('x') })
    expect(p).toBeInstanceOf(StubDocumentProvider)
  })

  it('returns the stub when the key is set but no downloader is provided', () => {
    process.env.LYCERT_ANTHROPIC_API_KEY = 'sk-test'
    expect(makeDocumentProvider()).toBeInstanceOf(StubDocumentProvider)
  })

  it('returns the Claude-vision provider only when key AND downloader are present', () => {
    process.env.LYCERT_ANTHROPIC_API_KEY = 'sk-test'
    const p = makeDocumentProvider({ download: async () => bytesOf('x') })
    expect(p).toBeInstanceOf(ClaudeVisionDocumentProvider)
  })
})

describe('ClaudeVisionDocumentProvider', () => {
  it('serves classify + extract from ONE model read (memoized per storage key)', async () => {
    const readDocument = vi.fn(async () => FULL_READ)
    const download = vi.fn(async () => bytesOf('img'))
    const p = new ClaudeVisionDocumentProvider({ download, readDocument })

    const cls = await p.classify(REF)
    const fields = await p.extract(REF, cls.docType)

    expect(readDocument).toHaveBeenCalledTimes(1)
    expect(download).toHaveBeenCalledTimes(1)
    expect(cls).toEqual({
      docType: 'enrollment_cert',
      issuerInstitution: 'University of Malta',
      issuerCountry: 'MT',
      language: 'en',
    })
    expect(fields).toEqual({
      name: 'Maria Vella',
      institution: 'University of Malta',
      enrollmentStatus: 'enrolled full-time',
      enrollmentEnd: '2027-06-30',
      docIssueDate: '2026-06-01',
      ageEligible: true,
    })
  })

  it('degrades to the empty read when the download fails (never throws, never fabricates)', async () => {
    const readDocument = vi.fn(async () => FULL_READ)
    const p = new ClaudeVisionDocumentProvider({
      download: async () => {
        throw new Error('storage down')
      },
      readDocument,
    })
    const cls = await p.classify(REF)
    expect(cls.docType).toBe('unknown')
    expect(readDocument).not.toHaveBeenCalled()
    const flags = await p.authenticate(REF)
    expect(flags.perceptualHash).toBeNull()
  })

  it('degrades to the empty read when the model call throws', async () => {
    const p = new ClaudeVisionDocumentProvider({
      download: async () => bytesOf('img'),
      readDocument: async () => {
        throw new Error('api down')
      },
    })
    const fields = await p.extract(REF, 'unknown')
    expect(fields).toEqual({
      name: null,
      institution: null,
      enrollmentStatus: null,
      enrollmentEnd: null,
      docIssueDate: null,
      ageEligible: null,
    })
  })

  it('authenticate returns clean forensic flags + a SHA-256 content hash (forensics backend deferred)', async () => {
    const doc = bytesOf('the-same-file')
    const p = new ClaudeVisionDocumentProvider({ download: async () => doc, readDocument: async () => FULL_READ })
    const flags = await p.authenticate(REF)
    expect(flags.physicalSecurityUncheckable).toBe(true)
    expect(flags.tamperRiskScore).toBe(0)
    expect(flags.fontAnomaly).toBe(false)
    expect(flags.perceptualHash).toBe(crypto.createHash('sha256').update(doc.bytes).digest('hex'))
  })

  it('exact-file reuse across applicants trips flag_repeat_document → suspected_tamper', async () => {
    const doc = bytesOf('reused-certificate')
    const sha = crypto.createHash('sha256').update(doc.bytes).digest('hex')
    const p = new ClaudeVisionDocumentProvider({ download: async () => doc, readDocument: async () => FULL_READ })
    const result = await runDocumentPipeline(
      REF,
      { name: 'Maria Vella', institution: 'University of Malta', statedGraduationDate: '2027-06-30' },
      { provider: p, lookupInstitutionReal: async () => true, priorHashes: async () => [sha] },
    )
    expect(result.flag_repeat_document).toBe(true)
    expect(result.machine_recommendation).toBe('suspected_tamper')
    expect(result.confidence).toBe('medium') // hard cap holds
  })
})

describe('buildDocumentBlock (vision input formats)', () => {
  it('maps a PDF to a document block and images to image blocks', () => {
    expect(buildDocumentBlock(bytesOf('%PDF', 'application/pdf'))?.type).toBe('document')
    expect(buildDocumentBlock(bytesOf('img', 'image/jpeg'))?.type).toBe('image')
    expect(buildDocumentBlock(bytesOf('img', 'image/png'))?.type).toBe('image')
  })

  it('returns null for HEIC (allowed at upload, unreadable by the vision backend → human review)', () => {
    expect(buildDocumentBlock(bytesOf('img', 'image/heic'))).toBeNull()
  })
})

describe('sanitizeDocRead (post-validation of model output)', () => {
  it('nulls malformed dates and non-ISO country/language codes', () => {
    const out = sanitizeDocRead({
      ...FULL_READ,
      issuer_country: 'Malta',
      language: 'English',
      enrollment_end: 'June 2027',
      doc_issue_date: '2026/06/01',
    })
    expect(out.issuer_country).toBeNull()
    expect(out.language).toBeNull()
    expect(out.enrollment_end).toBeNull()
    expect(out.doc_issue_date).toBeNull()
  })

  it('normalizes valid codes and keeps valid ISO dates', () => {
    const out = sanitizeDocRead({ ...FULL_READ, issuer_country: 'mt', language: 'EN' })
    expect(out.issuer_country).toBe('MT')
    expect(out.language).toBe('en')
    expect(out.enrollment_end).toBe('2027-06-30')
  })

  it('the age-eligibility threshold is a named placeholder pending legal review', () => {
    expect(AGE_ELIGIBILITY_MIN_YEARS).toBeGreaterThan(0) // boolean-only; the DOB itself is never extracted
  })
})
