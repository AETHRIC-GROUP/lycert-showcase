/**
 * FULL enrichment benchmark runner — every provider with a key, against a ground-truth sample.
 * (Detour 2026-06-29; generalises benchmark-v3.ts to all 9 enrichers + a ZeroBounce validity pass.)
 *
 * Drives the REAL prod TS clients/mappers in isolation. Sync clients return immediately; poll clients
 * (Icypeas/Dropcontact) are polled to terminal; FullEnrich is submit→pollBulk→parseWebhookResults.
 * ZeroBounce is a VALIDATOR (email validity), not an enricher — reported separately.
 *
 *   cd apps/web
 *   npx tsx scripts/benchmark-all.ts <sample.csv>                     # all providers, all rows (spends)
 *   npx tsx scripts/benchmark-all.ts <sample.csv> --limit 2           # first 2 rows (schema control)
 *   npx tsx scripts/benchmark-all.ts <sample.csv> --only pdl,icypeas  # subset
 *   npx tsx scripts/benchmark-all.ts --dry                            # no network, stubbed
 *
 * Credit safety: per-provider try/catch (one provider's failure never aborts the rest) + the capture
 * file is written after EVERY provider, so a crash/credit-exhaustion mid-run never loses prior results.
 * Keys read from repo-root .env.local. Set LYCERT_BENCH_DEBUG=1 to dump raw provider responses.
 */
import { readFileSync, writeFileSync, existsSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { dirname, resolve } from 'node:path'
import {
  HunterClient, FindymailClient, ReverseContactClient, DatagmaClient, PdlClient, ApolloClient,
} from '../lib/enrichment/providers/clients'
import { IcypeasClient } from '../lib/enrichment/providers/icypeas'
import { DropcontactClient } from '../lib/enrichment/providers/dropcontact'
import { FullEnrichClient, parseWebhookResults } from '../lib/enrichment/providers/fullenrich'
import { ZeroBounceClient } from '../lib/enrichment/providers/zerobounce'
import { classifyCompleteness, makeResult, ProviderOutcome, type ProviderResult } from '../lib/enrichment/providers/base'

const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..', '..')
const CAPTURE_PATH = resolve(REPO_ROOT, 'bench_capture_all.json')
const POLL_INTERVAL_MS = 6000
const MAX_POLLS = 25 // ~2.5 min ceiling per subscriber

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

type Mode = 'sync' | 'poll' | 'fullenrich'
type Provider = { name: string; env: string; cost: number; mode: Mode; note?: string; make: (k: string) => any }
const PROVIDERS: Provider[] = [
  { name: 'hunter', env: 'LYCERT_HUNTER_API_KEY', cost: 0.004, mode: 'sync', make: k => new HunterClient(k) },
  { name: 'findymail', env: 'LYCERT_FINDYMAIL_API_KEY', cost: 0.02, mode: 'sync', make: k => new FindymailClient(k) },
  { name: 'reversecontact', env: 'LYCERT_REVERSECONTACT_API_KEY', cost: 0.03, mode: 'sync', note: 'free trial: API calls disabled (expect error/403, no charge)', make: k => new ReverseContactClient(k) },
  { name: 'datagma', env: 'LYCERT_DATAGMA_API_KEY', cost: 0.03, mode: 'sync', make: k => new DatagmaClient(k) },
  { name: 'pdl', env: 'LYCERT_PDL_API_KEY', cost: 0.28, mode: 'sync', note: 'PAID ~$0.28/match', make: k => new PdlClient(k) },
  { name: 'apollo', env: 'LYCERT_APOLLO_API_KEY', cost: 0.0, mode: 'sync', make: k => new ApolloClient(k) },
  { name: 'icypeas', env: 'LYCERT_ICYPEAS_API_KEY', cost: 0.19, mode: 'poll', make: k => new IcypeasClient(k) },
  { name: 'dropcontact', env: 'LYCERT_DROPCONTACT_API_KEY', cost: 0.06, mode: 'poll', make: k => new DropcontactClient(k) },
  { name: 'fullenrich', env: 'LYCERT_FULLENRICH_API_KEY', cost: 0.05, mode: 'fullenrich', make: k => new FullEnrichClient(k, process.env.LYCERT_FULLENRICH_WEBHOOK_URL ?? '', null) },
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

async function resolvePoll(client: any, email: string, name: string | null, subId: string): Promise<ProviderResult> {
  const res: ProviderResult = await client.enrich(email, name, subId)
  if (res.outcome !== ProviderOutcome.PENDING || !res.asyncReference) return res
  for (let i = 0; i < MAX_POLLS; i++) {
    await sleep(POLL_INTERVAL_MS)
    const polled: ProviderResult = await client.poll(res.asyncReference)
    if (polled.outcome !== ProviderOutcome.PENDING) return polled
  }
  return res
}

async function resolveFullenrich(client: any, email: string, subId: string): Promise<ProviderResult> {
  const sub: ProviderResult = await client.enrich(email, null, subId)
  if (sub.outcome !== ProviderOutcome.PENDING || !sub.asyncReference) return sub
  for (let i = 0; i < MAX_POLLS; i++) {
    await sleep(POLL_INTERVAL_MS)
    const { status, payload } = await client.pollBulk(sub.asyncReference)
    if (process.env.LYCERT_BENCH_DEBUG) console.error('[bench] fullenrich poll', status)
    if (status && String(status).toUpperCase() === 'FINISHED' && payload) {
      const items = parseWebhookResults(payload)
      const mine = items.find((it: any) => String(it.subscriberId) === String(subId)) ?? items[0]
      if (!mine || !mine.matched) return makeResult('fullenrich', ProviderOutcome.MISS, { charged: false })
      const outcome = classifyCompleteness(mine.fields)
      return makeResult('fullenrich', outcome === ProviderOutcome.MISS ? ProviderOutcome.PARTIAL : outcome, {
        fields: mine.fields, charged: true, costUsd: 0.05, fullName: mine.fullName,
      })
    }
  }
  return sub
}

async function runProvider(p: Provider, sample: Record<string, string>[], dry: boolean): Promise<any> {
  const client = dry ? null : p.make(process.env[p.env]!)
  const results: any[] = []
  let spend = 0
  for (let i = 0; i < sample.length; i++) {
    const row = sample[i]
    let res: ProviderResult
    try {
      if (dry) {
        res = makeResult(p.name, ProviderOutcome.PARTIAL, { fields: { linkedin_profile_url: 'https://li/in/stub', li_current_employer_name: 'StubCo', li_job_title: 'Stub' }, charged: true, costUsd: p.cost, fullName: row.name ?? null })
      } else if (p.mode === 'sync') {
        res = await client.enrich(row.email, row.name ?? null, `bench-${i}`)
      } else if (p.mode === 'poll') {
        res = await resolvePoll(client, row.email, row.name ?? null, `bench-${i}`)
      } else {
        res = await resolveFullenrich(client, row.email, `bench-${i}`)
      }
    } catch (e) {
      res = makeResult(p.name, ProviderOutcome.ERROR, { errorMessage: String(e) })
    }
    spend += res.costUsd || 0
    results.push({ email: row.email, outcome: res.outcome, charged: res.charged, cost_usd: res.costUsd || 0, full_name: res.fullName ?? null, error: res.errorMessage ?? null, fields: res.fields || {} })
    process.stdout.write(`    ${p.name} ${i + 1}/${sample.length} ${res.outcome}${res.errorMessage ? ' (' + res.errorMessage.slice(0, 60) + ')' : ''}\n`)
  }
  console.log(`  ${p.name}: done — spend $${spend.toFixed(4)}`)
  return { cost_planning: p.cost, note: p.note ?? null, results }
}

async function runZeroBounce(sample: Record<string, string>[], dry: boolean): Promise<any> {
  if (dry) return { note: 'validator (not enricher)', results: sample.map(r => ({ email: r.email, status: 'valid', sub_status: '', free_email: false })) }
  const zb = new ZeroBounceClient(process.env.LYCERT_ZEROBOUNCE_API_KEY ?? '')
  const results: any[] = []
  for (const row of sample) {
    try {
      const v = await zb.validate(row.email)
      results.push({ email: row.email, status: v.status, raw_status: v.rawStatus, sub_status: v.subStatus, free_email: v.freeEmail })
      process.stdout.write(`    zerobounce ${row.email.split('@')[1]} -> ${v.status}\n`)
    } catch (e) {
      results.push({ email: row.email, status: 'error', error: String(e) })
    }
  }
  return { note: 'validator (not enricher) — email validity, not LinkedIn data', results }
}

function summarize(captured: Record<string, any>, n: number): void {
  console.log('\n| Provider | Hit rate | Edu cov | Dates cov | Spend | $/hit |')
  console.log('|---|---|---|---|---|---|')
  for (const [name, blob] of Object.entries<any>(captured)) {
    if (name === 'zerobounce') continue
    const hits = blob.results.filter((r: any) => r.outcome === 'complete' || r.outcome === 'partial')
    const edu = hits.filter((r: any) => r.fields?.li_education_end_date).length
    const dates = hits.filter((r: any) => r.fields?.li_job_start_date).length
    const spend = blob.results.reduce((s: number, r: any) => s + (r.cost_usd || 0), 0)
    const cph = hits.length ? spend / hits.length : 0
    const pct = (x: number) => (hits.length ? `${Math.round((x / hits.length) * 100)}%` : '—')
    console.log(`| ${name} | ${Math.round((hits.length / n) * 100)}% (${hits.length}/${n}) | ${pct(edu)} | ${pct(dates)} | $${spend.toFixed(2)} | $${cph.toFixed(4)} |`)
  }
}

async function main(): Promise<number> {
  loadDotenv()
  const argv = process.argv.slice(2)
  const dry = argv.includes('--dry')
  let only: Set<string> | null = null
  let limit: number | null = null
  const rest: string[] = []
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === '--dry') continue
    else if (argv[i] === '--only' && argv[i + 1]) only = new Set(argv[++i].split(',').map(s => s.trim()).filter(Boolean))
    else if (argv[i] === '--limit' && argv[i + 1]) limit = parseInt(argv[++i], 10)
    else rest.push(argv[i])
  }
  let sample: Record<string, string>[]
  if (dry && !rest.length) sample = [{ email: 'a@b.com', name: 'Jane Doe' }, { email: 'c@d.edu', name: 'John Roe' }]
  else {
    if (!rest.length) { console.log('Usage: npx tsx scripts/benchmark-all.ts <sample.csv> [--only ...] [--limit N] [--dry]'); return 1 }
    if (!existsSync(rest[0])) { console.log(`Sample not found: ${rest[0]}`); return 1 }
    sample = loadSample(rest[0])
  }
  if (limit != null) sample = sample.slice(0, limit)
  console.log(`Loaded ${sample.length} subscribers${dry ? ' (DRY)' : ''}${only ? ` | only: ${Array.from(only).join(',')}` : ''}`)

  const captured: Record<string, any> = {}
  const write = () => writeFileSync(CAPTURE_PATH, JSON.stringify({ sample, captured }, null, 2), 'utf8')

  for (const p of PROVIDERS) {
    if (only && !only.has(p.name)) continue
    if (!dry && !process.env[p.env]) { console.log(`  SKIP ${p.name}: ${p.env} not set`); continue }
    console.log(`\n>> ${p.name} (${p.mode})${p.note ? ' — ' + p.note : ''}`)
    captured[p.name] = await runProvider(p, sample, dry)
    write() // incremental: never lose a completed provider's results
  }
  if ((!only || only.has('zerobounce')) && (dry || process.env.LYCERT_ZEROBOUNCE_API_KEY)) {
    console.log(`\n>> zerobounce (validator)`)
    captured.zerobounce = await runZeroBounce(sample, dry)
    write()
  }

  console.log(`\nRaw capture → ${CAPTURE_PATH}`)
  summarize(captured, sample.length)
  let total = 0
  for (const [, blob] of Object.entries<any>(captured)) total += (blob.results ?? []).reduce((s: number, r: any) => s + (r.cost_usd || 0), 0)
  console.log(`\nTOTAL SPEND this run: $${total.toFixed(2)}`)
  return 0
}

main().then(c => process.exit(c)).catch(e => { console.error(e); process.exit(1) })
