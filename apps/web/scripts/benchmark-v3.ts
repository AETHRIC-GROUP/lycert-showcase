/**
 * V3 enrichment benchmark runner (LYCERT_WATERFALL_ENRICHMENT_V3.md Part 8.2) — TypeScript.
 *
 * Runs each NEW provider (Findymail/Icypeas/Dropcontact) in ISOLATION against a ground-truth sample,
 * polling the async (poll-based) ones to a terminal result, then prints the per-provider table + a
 * per-subscriber Clay-vs-ours comparison and writes bench_capture.json (gitignored) for offline re-analysis.
 *
 * This drives the REAL prod TS clients/mappers (no Python, no drift). The benchmark decides final
 * cascade order — it is the gate before the TS cascade integration + poll worker are built.
 *
 *   cd apps/web
 *   npx tsx scripts/benchmark-v3.ts "../../Ground truth sample.csv"                 # real (uses credits)
 *   npx tsx scripts/benchmark-v3.ts "../../sample.csv" --only findymail,icypeas      # subset
 *   npx tsx scripts/benchmark-v3.ts --dry                                            # no network, stubs
 *
 * Keys are read from repo-root .env.local (LYCERT_FINDYMAIL_API_KEY / _ICYPEAS_ / _DROPCONTACT_).
 * Sample is a CSV exported from the xlsx ground truth; first ⚠ RUN: set LYCERT_BENCH_DEBUG=1 to dump
 * each provider's raw response so the unverified Findymail/Icypeas profile keys can be locked in.
 */
import { readFileSync, writeFileSync, existsSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { dirname, resolve } from 'node:path'
import { FindymailClient } from '../lib/enrichment/providers/clients'
import { IcypeasClient } from '../lib/enrichment/providers/icypeas'
import { DropcontactClient } from '../lib/enrichment/providers/dropcontact'
import { ProviderOutcome, type ProviderResult } from '../lib/enrichment/providers/base'

const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..', '..')
const CAPTURE_PATH = resolve(REPO_ROOT, 'bench_capture.json')
const POLL_INTERVAL_MS = 6000
const MAX_POLLS = 25 // ~2.5 min ceiling per subscriber

// Ground-truth (the design partner) column → internal key (mirrors scripts/benchmark_capture.py).
const COLUMN_ALIASES: Record<string, string> = {
  'contact name': 'name',
  'linkedin profile final': 'expected_linkedin',
  'li title': 'expected_title',
  'li job company name': 'expected_employer',
  'company domain name': 'expected_domain',
  'li education name': 'expected_school',
  'li education date range': 'expected_edu_range',
  'li job start date': 'expected_job_start',
  'li job end date': 'expected_job_end',
}
const COMPARE: [string, string, string][] = [
  ['LinkedIn', 'linkedin_profile_url', 'expected_linkedin'],
  ['Title', 'li_job_title', 'expected_title'],
  ['Employer', 'li_current_employer_name', 'expected_employer'],
  ['Emp domain', 'li_current_employer_domain', 'expected_domain'],
  ['School', 'li_education_institution', 'expected_school'],
  ['Edu end', 'li_education_end_date', 'expected_edu_range'],
  ['Job start', 'li_job_start_date', 'expected_job_start'],
  ['Job end', 'li_job_end_date', 'expected_job_end'],
]

type Provider = { name: string; env: string; cost: number; mode: 'sync' | 'async'; make: (k: string) => any }
const PROVIDERS: Provider[] = [
  { name: 'findymail', env: 'LYCERT_FINDYMAIL_API_KEY', cost: 0.02, mode: 'sync', make: k => new FindymailClient(k) },
  { name: 'icypeas', env: 'LYCERT_ICYPEAS_API_KEY', cost: 0.19, mode: 'async', make: k => new IcypeasClient(k) },
  { name: 'dropcontact', env: 'LYCERT_DROPCONTACT_API_KEY', cost: 0.06, mode: 'async', make: k => new DropcontactClient(k) },
]

const sleep = (ms: number) => new Promise(r => setTimeout(r, ms))
const sval = (x: unknown): string => (x == null ? '' : String(x))

function loadDotenv(): void {
  for (const fname of ['.env.local', '.env']) {
    const path = resolve(REPO_ROOT, fname)
    if (!existsSync(path)) continue
    for (const raw of readFileSync(path, 'utf8').split(/\r?\n/)) {
      const line = raw.trim().replace(/^export\s+/, '')
      if (!line || line.startsWith('#') || !line.includes('=')) continue
      const i = line.indexOf('=')
      const k = line.slice(0, i).trim()
      const v = line.slice(i + 1).trim().replace(/^["']|["']$/g, '')
      if (k && !(k in process.env)) process.env[k] = v
    }
  }
}

/** Minimal CSV parser (handles quoted fields + embedded commas/quotes). */
function parseCsv(text: string): string[][] {
  const rows: string[][] = []
  let row: string[] = [], cur = '', q = false
  for (let i = 0; i < text.length; i++) {
    const c = text[i]
    if (q) {
      if (c === '"') { if (text[i + 1] === '"') { cur += '"'; i++ } else q = false }
      else cur += c
    } else if (c === '"') q = true
    else if (c === ',') { row.push(cur); cur = '' }
    else if (c === '\n') { row.push(cur); rows.push(row); row = []; cur = '' }
    else if (c !== '\r') cur += c
  }
  if (cur !== '' || row.length) { row.push(cur); rows.push(row) }
  return rows.filter(r => r.some(c => c.trim() !== ''))
}

function loadSample(path: string): Record<string, string>[] {
  const rows = parseCsv(readFileSync(path, 'utf8'))
  const headers = rows[0].map(h => h.trim().toLowerCase())
  const out: Record<string, string>[] = []
  for (const r of rows.slice(1)) {
    const row: Record<string, string> = {}
    headers.forEach((h, i) => {
      if (!h) return
      row[h] = (r[i] ?? '').trim()
      if (COLUMN_ALIASES[h] && !(COLUMN_ALIASES[h] in row)) row[COLUMN_ALIASES[h]] = row[h]
    })
    if (row.email) out.push(row)
  }
  return out
}

// NOTE: this submits-then-fully-polls each async subscriber sequentially (50 rows × up to 2.5 min).
// Fine for a spot check; if a 20–50 row run drags, switch to submit-all-then-poll-all per provider.
async function resolveOne(client: any, mode: string, email: string, name: string | null, subId: string): Promise<ProviderResult> {
  const res: ProviderResult = await client.enrich(email, name, subId)
  if (mode !== 'async' || res.outcome !== ProviderOutcome.PENDING || !res.asyncReference) return res
  for (let i = 0; i < MAX_POLLS; i++) {
    await sleep(POLL_INTERVAL_MS)
    const polled: ProviderResult = await client.poll(res.asyncReference)
    if (polled.outcome !== ProviderOutcome.PENDING) return polled
  }
  console.log(`    ${res.providerKey}: still pending after ${MAX_POLLS} polls for ${email}`)
  return res
}

async function runReal(sample: Record<string, string>[], only: Set<string> | null, dry: boolean) {
  const captured: Record<string, any> = {}
  for (const p of PROVIDERS) {
    if (only && !only.has(p.name)) continue
    if (!dry && !process.env[p.env]) { console.log(`  SKIP ${p.name}: ${p.env} not set`); continue }
    console.log(`  Running ${p.name} (${p.mode}) against ${sample.length} subscribers...`)
    const client = dry ? null : p.make(process.env[p.env]!)
    const results = []
    for (let i = 0; i < sample.length; i++) {
      const row = sample[i]
      let res: ProviderResult
      if (dry) {
        res = { providerKey: p.name, outcome: ProviderOutcome.PARTIAL, fields: { linkedin_profile_url: 'https://li/in/stub', li_current_employer_name: 'StubCo', li_job_title: 'Stub' }, charged: true, costUsd: p.cost, rawDeleted: true, errorMessage: null, asyncReference: null, fullName: row.name ?? null }
      } else {
        res = await resolveOne(client, p.mode, row.email, row.name ?? null, `bench-${i}`)
      }
      results.push({
        email: row.email, outcome: res.outcome, charged: res.charged, cost_usd: res.costUsd || 0,
        full_name: res.fullName, error: res.errorMessage, fields: res.fields || {},
      })
    }
    captured[p.name] = { cost_planning: p.cost, results }
  }
  return captured
}

function summarize(captured: Record<string, any>, n: number): void {
  console.log('\n| Provider | Hit rate | Edu cov | Dates cov | $/hit |')
  console.log('|---|---|---|---|---|')
  for (const [name, blob] of Object.entries<any>(captured)) {
    const hits = blob.results.filter((r: any) => r.outcome === 'complete' || r.outcome === 'partial')
    const edu = hits.filter((r: any) => r.fields.li_education_end_date).length
    const dates = hits.filter((r: any) => r.fields.li_job_start_date).length
    const spend = blob.results.reduce((s: number, r: any) => s + (r.cost_usd || 0), 0)
    const cph = hits.length ? spend / hits.length : blob.cost_planning
    const pct = (x: number) => (hits.length ? `${Math.round((x / hits.length) * 100)}%` : '—')
    console.log(`| ${name} | ${Math.round((hits.length / n) * 100)}% (${hits.length}/${n}) | ${pct(edu)} | ${pct(dates)} | $${cph.toFixed(4)} |`)
  }
}

function compare(captured: Record<string, any>, sample: Record<string, string>[]): void {
  for (const exp of sample) {
    console.log(`\n=== ${exp.email}  (${exp.name ?? '?'}) ===`)
    for (const [label, retKey, expKey] of COMPARE) {
      const expected = sval(exp[expKey])
      const cells: string[] = []
      for (const [pname, blob] of Object.entries<any>(captured)) {
        const row = blob.results.find((r: any) => r.email === exp.email)
        const got = row ? sval(row.fields[retKey]) : ''
        if (got) cells.push(`${pname}=${got}`)
      }
      if (!expected && !cells.length) continue
      const bucket = expected && cells.length ? 'both' : expected ? 'CLAY-ONLY (ours missing)' : 'OURS-ONLY (not in Clay)'
      console.log(`  ${label.padEnd(11)} | clay: ${expected || '—'}`)
      console.log(`  ${''.padEnd(11)} | ours: ${cells.join('; ') || '—'}    [${bucket}]`)
    }
  }
}

async function main(): Promise<number> {
  loadDotenv()
  const argv = process.argv.slice(2)
  const dry = argv.includes('--dry')
  let only: Set<string> | null = null
  const rest: string[] = []
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === '--dry') continue
    if (argv[i] === '--only' && argv[i + 1]) { only = new Set(argv[++i].split(',').map(s => s.trim()).filter(Boolean)) }
    else if (argv[i].startsWith('--only=')) only = new Set(argv[i].split('=')[1].split(',').map(s => s.trim()).filter(Boolean))
    else rest.push(argv[i])
  }
  let sample: Record<string, string>[]
  if (dry && !rest.length) {
    sample = [{ email: 'a@b.com', name: 'Jane Doe' }, { email: 'c@d.edu', name: 'John Roe' }]
  } else {
    if (!rest.length) { console.log('Usage: npx tsx scripts/benchmark-v3.ts <sample.csv> [--only ...] [--dry]'); return 1 }
    if (!existsSync(rest[0])) { console.log(`Sample not found: ${rest[0]}`); return 1 }
    sample = loadSample(rest[0])
  }
  console.log(`Loaded ${sample.length} subscribers${dry ? ' (DRY — no network)' : ''}`)
  if (only) console.log(`--only: ${Array.from(only).sort().join(', ')}`)

  const captured = await runReal(sample, only, dry)
  writeFileSync(CAPTURE_PATH, JSON.stringify({ sample, captured }, null, 2), 'utf8')
  console.log(`\nRaw capture written to ${CAPTURE_PATH}`)
  summarize(captured, sample.length)
  compare(captured, sample)
  console.log('\n⚠ Small samples are qualitative. Set MEASURED enrichment_providers.default_position only from a 20–50 row run.')
  return 0
}

main().then(c => process.exit(c)).catch(e => { console.error(e); process.exit(1) })
