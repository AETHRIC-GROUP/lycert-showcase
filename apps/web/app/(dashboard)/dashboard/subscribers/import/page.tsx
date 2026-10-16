'use client'

import { useState, useRef } from 'react'
import { useRouter } from 'next/navigation'
import { parseCSV, isValidEmail, parseDateInOrder, inferDateOrder, rowsToCSV, decodeCsvBytes, looksLikeMojibake, type ParsedCSVRow } from '@/lib/utils/csv'
import type { ImportRow } from '@/lib/actions/import-subscribers'

type Step = 'upload' | 'map' | 'preview' | 'importing' | 'done'

const REQUIRED_FIELDS = [
  { key: 'email', label: 'Email address', required: true },
  { key: 'name', label: 'Full name', required: true },
  { key: 'stated_graduation_date', label: 'Graduation date', required: true },
]
const OPTIONAL_FIELDS = [
  { key: 'institution_name', label: 'Institution name' },
  { key: 'institution_location', label: 'Institution location' },
  { key: 'account_country', label: 'Country' },
  { key: 'account_name', label: 'Account / company name' },
  { key: 'external_id', label: 'Your internal ID' },
  { key: 'plan_name', label: 'Plan name' },
]
const ALL_FIELDS = [...REQUIRED_FIELDS, ...OPTIONAL_FIELDS]

interface ValidationResult {
  valid: ImportRow[]
  skipped: Array<{ row: Record<string, string>; reason: string }>
  dateOrder: 'dmy' | 'mdy'
  /** Emails (lowercased) among the valid rows that already exist for this tenant — they will be
   *  updated in place rather than added as new subscribers (the importer upserts on tenant+email). */
  existingEmails: string[]
}

export default function ImportPage() {
  const router = useRouter()
  const fileRef = useRef<HTMLInputElement>(null)
  const [step, setStep] = useState<Step>('upload')
  const [headers, setHeaders] = useState<string[]>([])
  const [csvRows, setCsvRows] = useState<ParsedCSVRow[]>([])
  const [mapping, setMapping] = useState<Record<string, string>>({})
  const [validation, setValidation] = useState<ValidationResult>({ valid: [], skipped: [], dateOrder: 'dmy', existingEmails: [] })
  const [result, setResult] = useState<{ imported: number; skipped: number; error?: string } | null>(null)
  const [importProgress, setImportProgress] = useState<{ done: number; total: number } | null>(null)
  const [encodingWarning, setEncodingWarning] = useState(false)

  function autoDetect(hdrs: string[]): Record<string, string> {
    const m: Record<string, string> = {}
    const lower = hdrs.map(h => h.toLowerCase().trim())
    const matchers: Record<string, string[]> = {
      email: ['email', 'e-mail', 'email address'],
      name: ['name', 'full name', 'contact name', 'subscriber name'],
      stated_graduation_date: ['graduation', 'graduation date', 'expected graduation', 'grad date', 'graduation_date'],
      institution_name: ['institution', 'institution name', 'school', 'university', 'college'],
      institution_location: ['institution location', 'school location'],
      account_country: ['country', 'account country', 'location'],
      account_name: ['account', 'account name', 'company', 'organization'],
      external_id: ['id', 'external id', 'subscriber id', 'contact id'],
      plan_name: ['plan', 'plan name', 'product'],
    }
    for (const [field, candidates] of Object.entries(matchers)) {
      for (const c of candidates) {
        const idx = lower.indexOf(c)
        if (idx !== -1) { m[field] = hdrs[idx]; break }
      }
    }
    return m
  }

  function handleFile(file: File) {
    const reader = new FileReader()
    reader.onload = e => {
      // Decode bytes ourselves (UTF-8, falling back to Windows-1252) so accented characters survive.
      const text = decodeCsvBytes(e.target?.result as ArrayBuffer)
      const { headers: hdrs, rows } = parseCSV(text)
      if (!hdrs.length) return alert('Could not parse CSV. Make sure the first row contains headers.')
      setHeaders(hdrs)
      setCsvRows(rows)
      setMapping(autoDetect(hdrs))
      setEncodingWarning(looksLikeMojibake(text))
      setStep('map')
    }
    reader.readAsArrayBuffer(file)
  }

  function buildValidation(): ValidationResult {
    const valid: ImportRow[] = []
    const skipped: Array<{ row: Record<string, string>; reason: string }> = []
    // Resolve day-first vs month-first once for the whole column, so genuinely ambiguous values
    // (e.g. 04/05/25) inherit the format proven by their unambiguous neighbours (e.g. 30.5.25).
    const gradCol = mapping.stated_graduation_date
    const dateOrder = inferDateOrder(gradCol ? csvRows.map(r => r[gradCol] ?? '') : [])
    for (const row of csvRows) {
      const email = mapping.email ? row[mapping.email]?.trim() : ''
      const name = mapping.name ? row[mapping.name]?.trim() : ''
      const gradRaw = gradCol ? row[gradCol]?.trim() : ''
      if (!email) { skipped.push({ row, reason: 'Missing email' }); continue }
      if (!isValidEmail(email)) { skipped.push({ row, reason: `Invalid email: ${email}` }); continue }
      if (!name) { skipped.push({ row, reason: 'Missing name' }); continue }
      const grad = parseDateInOrder(gradRaw, dateOrder)
      if (gradRaw && !grad) { skipped.push({ row, reason: `Cannot parse graduation date: ${gradRaw}` }); continue }
      valid.push({
        email,
        name,
        stated_graduation_date: grad ?? '',
        institution_name: mapping.institution_name ? row[mapping.institution_name]?.trim() : undefined,
        institution_location: mapping.institution_location ? row[mapping.institution_location]?.trim() : undefined,
        account_country: mapping.account_country ? row[mapping.account_country]?.trim() : undefined,
        account_name: mapping.account_name ? row[mapping.account_name]?.trim() : undefined,
        external_id: mapping.external_id ? row[mapping.external_id]?.trim() : undefined,
        plan_name: mapping.plan_name ? row[mapping.plan_name]?.trim() : undefined,
      })
    }
    return { valid, skipped, dateOrder, existingEmails: [] as string[] }
  }

  async function goToPreview() {
    if (!mapping.email || !mapping.name || !mapping.stated_graduation_date) {
      return alert('Please map the three required fields: Email, Name, and Graduation Date.')
    }
    const v = buildValidation()
    setValidation(v)
    setStep('preview')
    // Ask the server which of these emails already exist for this tenant, so we can show how many
    // rows will update an existing subscriber vs add a new one. Non-blocking: the preview renders
    // immediately and the new/update split fills in when this resolves.
    try {
      const emails = v.valid.map(r => r.email.toLowerCase())
      const res = await fetch('/api/subscribers/existing', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ emails }),
      })
      if (res.ok) {
        const json = (await res.json()) as { existing: { email: string; name: string | null }[] }
        setValidation({ ...v, existingEmails: json.existing.map(e => e.email.toLowerCase()) })
      }
    } catch { /* leave existingEmails empty — preview still works */ }
  }

  async function doImport() {
    setStep('importing')
    const BATCH = 200
    const rows = validation.valid
    let totalImported = 0
    let batchErrors = 0

    setImportProgress({ done: 0, total: rows.length })

    for (let i = 0; i < rows.length; i += BATCH) {
      const chunk = rows.slice(i, i + BATCH)
      try {
        const res = await fetch('/api/subscribers/import', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(chunk),
        })
        if (!res.ok) throw new Error(`HTTP ${res.status}`)
        const json = await res.json() as { imported: number; error?: string }
        totalImported += json.imported
        if (json.error) batchErrors++
      } catch {
        batchErrors++
      }
      setImportProgress({ done: Math.min(i + BATCH, rows.length), total: rows.length })
    }

    const errorMsg = batchErrors > 0
      ? `${batchErrors} batch(es) failed — ${totalImported} of ${rows.length} rows imported successfully`
      : undefined

    setResult({ imported: totalImported, skipped: rows.length - totalImported + validation.skipped.length, error: errorMsg })
    setImportProgress(null)
    setStep('done')
  }

  function downloadSkipped() {
    const all = validation.skipped.map(s => ({ ...s.row, skip_reason: s.reason }))
    const csv = rowsToCSV(all)
    const blob = new Blob([csv], { type: 'text/csv' })
    const url = URL.createObjectURL(blob)
    const a = document.createElement('a')
    a.href = url
    a.download = 'skipped-rows.csv'
    a.click()
    URL.revokeObjectURL(url)
  }

  return (
    <div className="max-w-3xl">
      <div className="mb-6">
        <h1 className="text-2xl font-bold text-gray-900">Import Subscribers</h1>
        <p className="mt-1 text-sm text-gray-500">Upload a CSV file to bulk-import subscribers.</p>
      </div>

      {/* Step indicator */}
      <div className="flex items-center gap-2 mb-8 text-sm">
        {(['upload', 'map', 'preview', 'done'] as const).map((s, i) => (
          <div key={s} className="flex items-center gap-2">
            {i > 0 && <div className="h-px w-6 bg-gray-300" />}
            <span className={`flex items-center justify-center w-6 h-6 rounded-full text-xs font-medium ${
              s === step || (step === 'importing' && s === 'preview')
                ? 'bg-brand-600 text-white'
                : ['upload','map','preview'].indexOf(s) < ['upload','map','preview','done'].indexOf(step)
                  ? 'bg-brand-100 text-brand-700'
                  : 'bg-gray-200 text-gray-500'
            }`}>{i + 1}</span>
            <span className="text-gray-600 capitalize hidden sm:inline">{s === 'done' ? 'Done' : s}</span>
          </div>
        ))}
      </div>

      {/* Step 1: Upload */}
      {step === 'upload' && (
        <div
          className="border-2 border-dashed border-gray-300 rounded-xl p-12 text-center hover:border-brand-400 transition-colors cursor-pointer"
          onClick={() => fileRef.current?.click()}
          onDragOver={e => { e.preventDefault(); e.stopPropagation() }}
          onDrop={e => {
            e.preventDefault()
            const f = e.dataTransfer.files[0]
            if (f?.name.endsWith('.csv')) handleFile(f)
          }}
        >
          <input ref={fileRef} type="file" accept=".csv" className="hidden"
            onChange={e => { const f = e.target.files?.[0]; if (f) handleFile(f) }} />
          <p className="text-gray-600">Drop your CSV here, or <span className="text-brand-600 underline">browse</span></p>
          <p className="text-xs text-gray-400 mt-2">Required columns: email, name, graduation date</p>
        </div>
      )}

      {/* Step 2: Map columns */}
      {step === 'map' && (
        <div>
          <p className="text-sm text-gray-600 mb-4">
            {csvRows.length} rows detected. Map your CSV columns to Lycert fields.
          </p>
          {encodingWarning && (
            <div className="mb-4 rounded-lg border border-amber-300 bg-amber-50 px-4 py-3 text-sm text-amber-800">
              <span className="font-medium">Garbled accented characters detected.</span> This file
              appears to have been corrupted before upload (e.g. saved from Excel without UTF-8). Names
              and locations with é, ü, ç, ö etc. may import incorrectly. Re-export the source as
              <span className="font-medium"> CSV UTF-8</span> and re-upload for accurate data.
            </div>
          )}
          <div className="bg-white rounded-xl border border-gray-200 divide-y divide-gray-100">
            {ALL_FIELDS.map(f => (
              <div key={f.key} className="flex items-center justify-between px-4 py-3">
                <div>
                  <span className="text-sm font-medium text-gray-900">{f.label}</span>
                  {('required' in f) && (
                    <span className="ml-2 text-xs text-red-500">required</span>
                  )}
                </div>
                <select
                  value={mapping[f.key] ?? ''}
                  onChange={e => setMapping(m => ({ ...m, [f.key]: e.target.value }))}
                  className="w-56 rounded-lg border border-gray-300 px-3 py-1.5 text-sm focus:outline-none focus:ring-2 focus:ring-brand-500"
                >
                  <option value="">— not mapped —</option>
                  {headers.map(h => <option key={h} value={h}>{h}</option>)}
                </select>
              </div>
            ))}
          </div>
          <div className="flex justify-between mt-6">
            <button onClick={() => setStep('upload')}
              className="px-4 py-2 border border-gray-300 rounded-lg text-sm text-gray-700 hover:bg-gray-50">
              Back
            </button>
            <button onClick={goToPreview}
              className="px-4 py-2 bg-brand-600 text-white text-sm font-medium rounded-lg hover:bg-brand-700">
              Preview →
            </button>
          </div>
        </div>
      )}

      {/* Step 3: Preview */}
      {step === 'preview' && (
        <div>
          {(() => {
            const existing = new Set(validation.existingEmails)
            const updateCount = validation.valid.filter(r => existing.has(r.email.toLowerCase())).length
            const newCount = validation.valid.length - updateCount
            const updatedRows = validation.valid.filter(r => existing.has(r.email.toLowerCase()))
            return (
              <>
                <div className="flex gap-4 mb-2 text-sm items-center">
                  <span className="text-green-700 font-medium">{validation.valid.length} valid rows</span>
                  {validation.skipped.length > 0 && (
                    <span className="text-red-600 font-medium">{validation.skipped.length} will be skipped</span>
                  )}
                  <span className="text-gray-400 ml-auto">
                    Dates read as {validation.dateOrder === 'mdy' ? 'month-first (MM/DD/YY)' : 'day-first (DD/MM/YY)'}
                  </span>
                </div>
                <div className="mb-4 text-xs text-gray-500">
                  <span className="font-medium text-gray-700">{newCount} new</span>
                  {' · '}
                  <span className="font-medium text-gray-700">{updateCount} will update an existing subscriber</span>
                  {' '}(matched by email — no duplicates are created).
                  {updateCount > 0 && (
                    <details className="mt-1">
                      <summary className="cursor-pointer text-gray-400 hover:text-gray-600">View {updateCount} to be updated</summary>
                      <ul className="mt-1 space-y-0.5">
                        {updatedRows.slice(0, 50).map((r, i) => (
                          <li key={i} className="text-gray-500">{r.name} — {r.email}</li>
                        ))}
                        {updatedRows.length > 50 && (
                          <li className="text-gray-400">…and {updatedRows.length - 50} more</li>
                        )}
                      </ul>
                    </details>
                  )}
                </div>
              </>
            )
          })()}

          {/* Preview table */}
          <div className="bg-white rounded-xl border border-gray-200 overflow-hidden mb-4">
            <div className="overflow-x-auto">
              <table className="w-full text-xs">
                <thead className="bg-gray-50 border-b border-gray-200">
                  <tr>
                    {['Email', 'Name', 'Graduation', 'Institution', 'Country'].map(h => (
                      <th key={h} className="px-3 py-2 text-left text-gray-500 font-medium uppercase tracking-wide">{h}</th>
                    ))}
                  </tr>
                </thead>
                <tbody className="divide-y divide-gray-50">
                  {validation.valid.slice(0, 10).map((r, i) => (
                    <tr key={i}>
                      <td className="px-3 py-2 text-gray-800">{r.email}</td>
                      <td className="px-3 py-2 text-gray-800">{r.name}</td>
                      <td className="px-3 py-2 text-gray-600">{r.stated_graduation_date || '—'}</td>
                      <td className="px-3 py-2 text-gray-600">{r.institution_name || '—'}</td>
                      <td className="px-3 py-2 text-gray-600">{r.account_country || '—'}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
            {validation.valid.length > 10 && (
              <p className="px-4 py-2 text-xs text-gray-400 border-t border-gray-100">
                +{validation.valid.length - 10} more rows not shown
              </p>
            )}
          </div>

          {validation.skipped.length > 0 && (
            <details className="mb-4">
              <summary className="text-sm text-red-600 cursor-pointer hover:underline">
                View {validation.skipped.length} skipped rows
              </summary>
              <ul className="mt-2 space-y-1">
                {validation.skipped.slice(0, 5).map((s, i) => (
                  <li key={i} className="text-xs text-gray-500">
                    Row {i + 2}: {s.reason}
                  </li>
                ))}
                {validation.skipped.length > 5 && (
                  <li className="text-xs text-gray-400">…and {validation.skipped.length - 5} more</li>
                )}
              </ul>
            </details>
          )}

          <div className="flex justify-between">
            <button onClick={() => setStep('map')}
              className="px-4 py-2 border border-gray-300 rounded-lg text-sm text-gray-700 hover:bg-gray-50">
              Back
            </button>
            <button
              onClick={doImport}
              disabled={validation.valid.length === 0}
              className="px-4 py-2 bg-brand-600 text-white text-sm font-medium rounded-lg hover:bg-brand-700 disabled:opacity-50 disabled:cursor-not-allowed"
            >
              Import {validation.valid.length} subscribers
            </button>
          </div>
        </div>
      )}

      {/* Importing spinner */}
      {step === 'importing' && (
        <div className="py-20 text-center">
          <div className="inline-block w-8 h-8 border-4 border-brand-600 border-t-transparent rounded-full animate-spin" />
          {importProgress ? (
            <>
              <p className="mt-4 text-sm text-gray-700 font-medium">
                {importProgress.done.toLocaleString()} / {importProgress.total.toLocaleString()} imported
              </p>
              <div className="mt-3 w-64 mx-auto bg-gray-200 rounded-full h-2">
                <div
                  className="bg-brand-600 h-2 rounded-full transition-all duration-300"
                  style={{ width: `${Math.round((importProgress.done / importProgress.total) * 100)}%` }}
                />
              </div>
              <p className="mt-2 text-xs text-gray-400">Processing in batches — please keep this tab open</p>
            </>
          ) : (
            <p className="mt-4 text-sm text-gray-500">Preparing…</p>
          )}
        </div>
      )}

      {/* Step 4: Done */}
      {step === 'done' && result && (
        <div className="text-center py-8">
          {result.error ? (
            <div>
              <div className="text-red-600 font-medium mb-2">Import failed</div>
              <p className="text-sm text-gray-600">{result.error}</p>
              <button onClick={() => setStep('preview')}
                className="mt-4 px-4 py-2 border border-gray-300 rounded-lg text-sm text-gray-700 hover:bg-gray-50">
                Try again
              </button>
            </div>
          ) : (
            <div>
              <div className="text-2xl font-bold text-gray-900 mb-1">{result.imported} imported</div>
              {result.skipped > 0 && (
                <p className="text-sm text-gray-500 mb-4">{result.skipped} rows skipped</p>
              )}
              <div className="flex justify-center gap-3 mt-6">
                {validation.skipped.length > 0 && (
                  <button onClick={downloadSkipped}
                    className="px-4 py-2 border border-gray-300 rounded-lg text-sm text-gray-700 hover:bg-gray-50">
                    Download skipped rows
                  </button>
                )}
                <button onClick={() => router.push('/dashboard/subscribers')}
                  className="px-4 py-2 bg-brand-600 text-white text-sm font-medium rounded-lg hover:bg-brand-700">
                  View subscribers
                </button>
              </div>
            </div>
          )}
        </div>
      )}
    </div>
  )
}