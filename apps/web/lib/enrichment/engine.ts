import type { SupabaseClient } from '@supabase/supabase-js'

// ── Shared TypeScript enrichment engine ──────────────────────────────────────
// Waterfall: PDL bulk (primary) → Apollo (fallback on PDL miss, gap-filler on
// PDL hit). Runs entirely on Vercel — no Railway dependency.
//
// Provider semantics on subscriber_enrichment.enrichment_provider (enum:
// clay | pdl | apollo):
//   'pdl'    — PDL matched (Apollo may have filled gaps; see audit metadata)
//   'apollo' — PDL missed, Apollo matched
//   miss     — provider 'pdl' + provider_miss_reason set, all li_* fields null

const PDL_BASE = 'https://api.peopledatalabs.com/v5'
const APOLLO_BASE = 'https://api.apollo.io/api/v1'
const MIN_LIKELIHOOD = 4
const BULK_CHUNK = 100

// Fields Apollo is allowed to fill when PDL leaves them null. PDL data is
// never overwritten — Apollo only fills gaps.
const GAP_FILL_FIELDS = [
  'linkedin_profile_url',
  'li_job_title',
  'li_job_title_levels',
  'li_current_employer_name',
  'li_current_employer_domain',
  'li_current_employer_linkedin_url',
  'li_employer_size',
  'li_employer_industry',
  'li_job_start_date',
  'li_job_end_date',
  'li_country',
  'li_state',
  'li_city',
] as const

// ── Coercion helpers (PDL boolean bug, bare URLs) ────────────────────────────

export function safeStr(val: unknown): string | null {
  if (val == null) return null
  if (typeof val === 'boolean') return null // PDL occasionally returns boolean for location fields
  const s = String(val).trim()
  return s || null
}

export function safeUrl(url: unknown): string | null {
  const s = safeStr(url)
  if (!s) return null
  if (s.startsWith('http://') || s.startsWith('https://')) return s
  return `https://${s}`
}

function parsePdlDate(dateStr: string | null | undefined): string | null {
  if (!dateStr) return null
  const s = String(dateStr).trim()
  if (s.length === 4) return `${s}-01-01`
  if (s.length === 7) return `${s}-01`
  if (s.length === 10) return s
  return null
}

function extractEduEndDate(education: Record<string, unknown>[]): string | null {
  const dates: string[] = []
  for (const entry of education) {
    const raw = entry.end_date as string | null | undefined
    const parsed = parsePdlDate(raw)
    if (parsed) {
      // Year-only → round to Dec 31 (conservative, matches Python implementation)
      const adjusted = raw && String(raw).length === 4 ? `${String(raw)}-12-31` : parsed
      dates.push(adjusted)
    }
  }
  return dates.length ? dates.sort().reverse()[0] : null
}

function latestEduInstitution(education: Record<string, unknown>[]): string | null {
  if (!education.length) return null
  const withEnd = education
    .filter(e => e.end_date)
    .sort((a, b) => (String(b.end_date) > String(a.end_date) ? 1 : -1))
  const source = withEnd.length ? withEnd[0] : education[0]
  return ((source.school as Record<string, unknown>)?.name as string) ?? null
}

function mapEmployeeCount(count: number | null | undefined): string | null {
  if (count == null) return null
  if (count <= 10) return '1-10'
  if (count <= 50) return '11-50'
  if (count <= 200) return '51-200'
  if (count <= 500) return '201-500'
  if (count <= 1000) return '501-1000'
  if (count <= 5000) return '1001-5000'
  if (count <= 10000) return '5001-10000'
  return '10001+'
}

// ── PDL ──────────────────────────────────────────────────────────────────────

function mapPdlPerson(
  data: Record<string, unknown>,
  likelihood: number,
  subscriberId: string,
  tenantId: string,
): Record<string, unknown> {
  const experience = (data.experience as Record<string, unknown>[]) || []
  const education = (data.education as Record<string, unknown>[]) || []
  const primaryJob = experience.find(e => e.is_primary) ?? experience[0] ?? null

  return {
    subscriber_id: subscriberId,
    tenant_id: tenantId,
    pdl_person_id: safeStr(data.id),
    pdl_likelihood_score: likelihood,
    linkedin_profile_url: safeUrl(data.linkedin_url),
    li_job_title: safeStr(data.job_title),
    li_job_title_levels: data.job_title_levels ?? null,
    li_current_employer_name: safeStr(data.job_company_name),
    li_current_employer_domain: safeStr(data.job_company_website),
    li_current_employer_linkedin_url: safeUrl(data.job_company_linkedin_url),
    li_employer_size: safeStr(data.job_company_size),
    li_employer_industry: safeStr(data.job_company_industry),
    li_job_start_date: parsePdlDate(data.job_start_date as string),
    li_job_end_date: primaryJob ? parsePdlDate(primaryJob.end_date as string) : null,
    li_education_institution: latestEduInstitution(education),
    li_education_end_date: extractEduEndDate(education),
    li_country: safeStr(data.location_country),
    li_state: safeStr(data.location_region),
    li_city: safeStr(data.location_locality),
    li_skills: ((data.skills as unknown[]) || []).slice(0, 10),
    enrichment_provider: 'pdl',
    provider_miss_reason: null,
  }
}

interface PdlBulkItem {
  subscriber_id: string
  status: number
  likelihood: number
  data: Record<string, unknown>
}

async function pdlBulkEnrich(
  requests: Array<{ subscriber_id: string; email: string; name?: string | null }>,
  apiKey: string,
): Promise<PdlBulkItem[]> {
  const body = {
    requests: requests.map(req => ({
      metadata: { lycert_subscriber_id: req.subscriber_id },
      params: {
        email: req.email,
        min_likelihood: MIN_LIKELIHOOD,
        // NOTE: no `required` clause — requiring experience AND education
        // rejected real matches that lacked either field. Missing fields are
        // recorded as data gaps and never penalised (legal requirement).
        ...(req.name ? { name: req.name } : {}),
      },
    })),
  }

  const res = await fetch(`${PDL_BASE}/person/bulk`, {
    method: 'POST',
    headers: { 'X-Api-Key': apiKey, 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(30_000),
  })

  if (!res.ok && res.status !== 207) {
    const text = await res.text().catch(() => '')
    throw new Error(`PDL bulk error ${res.status}: ${text.slice(0, 300)}`)
  }

  const items = await res.json() as Record<string, unknown>[]
  return items.map(item => ({
    subscriber_id: ((item.metadata as Record<string, unknown>)?.lycert_subscriber_id as string) ?? '',
    status: (item.status as number) ?? 404,
    likelihood: (item.likelihood as number) ?? 0,
    data: (item.data as Record<string, unknown>) ?? {},
  }))
}

// ── Apollo ───────────────────────────────────────────────────────────────────

type ApolloResult =
  | { kind: 'match'; fields: Record<string, unknown> }
  | { kind: 'no_match' }
  | { kind: 'unavailable'; detail: string } // plan-gated: API not accessible on current Apollo plan
  | { kind: 'error'; detail: string }

async function apolloEnrich(
  email: string,
  name: string | null,
  apiKey: string,
): Promise<ApolloResult> {
  // Apollo auth is an x-api-key header (NOT Authorization: Bearer — that
  // returns 401). Params go in the query string per the official docs.
  const params = new URLSearchParams({
    email,
    reveal_personal_emails: 'false',
    reveal_phone_number: 'false',
  })
  if (name) {
    params.set('name', name)
    const parts = name.trim().split(/\s+/)
    if (parts.length >= 2) {
      params.set('first_name', parts[0])
      params.set('last_name', parts.slice(1).join(' '))
    }
  }

  let res: Response
  try {
    res = await fetch(`${APOLLO_BASE}/people/match?${params.toString()}`, {
      method: 'POST',
      headers: {
        'x-api-key': apiKey,
        'Content-Type': 'application/json',
        'Cache-Control': 'no-cache',
        accept: 'application/json',
      },
      signal: AbortSignal.timeout(15_000),
    })
  } catch (err) {
    return { kind: 'error', detail: `network: ${String(err)}` }
  }

  if (res.status === 404) return { kind: 'no_match' }
  if (!res.ok) {
    const text = await res.text().catch(() => '')
    const detail = `http ${res.status}: ${text.slice(0, 300)}`
    // Apollo free plans gate people/match behind a paid plan (API_INACCESSIBLE).
    // That is a permanent condition until the plan changes — treat it as
    // "Apollo unavailable", not a transient error.
    if (res.status === 403 && text.includes('API_INACCESSIBLE')) {
      return { kind: 'unavailable', detail }
    }
    return { kind: 'error', detail }
  }

  const data = await res.json().catch(() => null) as Record<string, unknown> | null
  const person = (data?.person as Record<string, unknown>) ?? null
  if (!person) return { kind: 'no_match' }

  const org = (person.organization as Record<string, unknown>) ?? {}
  const empHist = (person.employment_history as Record<string, unknown>[]) ?? []
  const current = empHist.find(e => e.current) ?? empHist[0] ?? {}
  const seniority = person.seniority as string | null

  return {
    kind: 'match',
    fields: {
      linkedin_profile_url: safeUrl(person.linkedin_url),
      li_current_employer_name: safeStr(org.name),
      li_current_employer_domain: safeStr(org.website_url),
      li_current_employer_linkedin_url: safeUrl(org.linkedin_url),
      li_employer_size: mapEmployeeCount(org.estimated_num_employees as number),
      li_employer_industry: safeStr(org.industry),
      li_job_start_date: parsePdlDate(current.start_date as string),
      li_job_end_date: parsePdlDate(current.end_date as string),
      li_job_title: safeStr(person.title),
      li_job_title_levels: seniority ? [seniority] : null,
      li_country: safeStr(person.country),
      li_state: safeStr(person.state),
      li_city: safeStr(person.city),
    },
  }
}

// ── Engine ───────────────────────────────────────────────────────────────────

export interface EnrichTarget {
  id: string
  email: string
  name: string | null
}

export interface EnrichTotals {
  enriched: number
  miss: number
  errors: number
  gapFilled: number
}

export interface EngineOptions {
  serviceDb: SupabaseClient
  tenantId: string
  pdlKey: string
  apolloKey: string | null
  retentionDays: number
}

async function writeAudit(
  serviceDb: SupabaseClient,
  tenantId: string,
  subscriberId: string,
  action: string,
  metadata: Record<string, unknown>,
) {
  await serviceDb.from('audit_logs').insert({
    tenant_id: tenantId,
    actor_type: 'system',
    actor_id: null,
    action,
    resource_type: 'subscriber',
    resource_id: subscriberId,
    metadata,
  })
}

export async function enrichSubscribers(
  targets: EnrichTarget[],
  opts: EngineOptions,
): Promise<EnrichTotals> {
  const { serviceDb, tenantId, pdlKey, apolloKey, retentionDays } = opts
  const now = new Date().toISOString()
  const deleteAt = new Date(Date.now() + retentionDays * 86_400_000).toISOString()
  const totals: EnrichTotals = { enriched: 0, miss: 0, errors: 0, gapFilled: 0 }

  for (let i = 0; i < targets.length; i += BULK_CHUNK) {
    const chunk = targets.slice(i, i + BULK_CHUNK)
    let pdlResults: PdlBulkItem[] = []

    try {
      pdlResults = await pdlBulkEnrich(
        chunk.map(s => ({ subscriber_id: s.id, email: s.email ?? '', name: s.name ?? null })),
        pdlKey,
      )
    } catch (err) {
      console.error('[enrich/engine] pdl bulk error chunk=%d err=%s', i, String(err))
      totals.errors += chunk.length
      continue
    }

    for (const result of pdlResults) {
      const sub = chunk.find(s => s.id === result.subscriber_id)
      if (!sub) continue

      try {
        if (result.status === 200) {
          // ── PDL hit. Apollo fills any gaps PDL left. ──
          const record = mapPdlPerson(result.data, result.likelihood, result.subscriber_id, tenantId)
          const gaps = GAP_FILL_FIELDS.filter(f => record[f] == null)
          let filledFields: string[] = []

          if (gaps.length && apolloKey) {
            const apollo = await apolloEnrich(sub.email ?? '', sub.name ?? null, apolloKey)
            if (apollo.kind === 'match') {
              for (const f of gaps) {
                const v = apollo.fields[f]
                if (v != null) {
                  record[f] = v
                  filledFields.push(f)
                }
              }
            } else if (apollo.kind === 'unavailable') {
              // Plan-gated — PDL data stands on its own; nothing to fill.
              console.log('[enrich/engine] apollo unavailable (plan) — gap-fill skipped sub=%s', sub.id)
            } else if (apollo.kind === 'error') {
              console.error('[enrich/engine] apollo gap-fill error sub=%s %s', sub.id, apollo.detail)
              await writeAudit(serviceDb, tenantId, sub.id, 'subscriber.enrichment_error', {
                provider: 'apollo', phase: 'gap_fill', detail: apollo.detail,
              })
            }
          }

          await serviceDb
            .from('subscriber_enrichment')
            .upsert({ ...record, enriched_at: now, delete_at: deleteAt }, { onConflict: 'subscriber_id' })
          await writeAudit(serviceDb, tenantId, sub.id, 'subscriber.enriched', {
            provider: 'pdl',
            ...(filledFields.length ? { gap_fill_provider: 'apollo', gap_filled_fields: filledFields } : {}),
          })
          totals.enriched++
          if (filledFields.length) totals.gapFilled++
          console.log('[enrich/engine] pdl hit sub=%s likelihood=%d gap_filled=%d',
            sub.id, result.likelihood, filledFields.length)
        } else {
          // ── PDL miss. Apollo is the full fallback. ──
          console.log('[enrich/engine] pdl miss sub=%s status=%d — trying apollo', sub.id, result.status)
          const apollo = apolloKey
            ? await apolloEnrich(sub.email ?? '', sub.name ?? null, apolloKey)
            : ({ kind: 'no_match' } as ApolloResult)

          if (apollo.kind === 'match') {
            await serviceDb
              .from('subscriber_enrichment')
              .upsert(
                {
                  subscriber_id: sub.id,
                  tenant_id: tenantId,
                  ...apollo.fields,
                  li_education_institution: null, // Apollo does not return education history
                  li_education_end_date: null,
                  enrichment_provider: 'apollo',
                  provider_miss_reason: null,
                  enriched_at: now,
                  delete_at: deleteAt,
                },
                { onConflict: 'subscriber_id' },
              )
            await writeAudit(serviceDb, tenantId, sub.id, 'subscriber.enriched', { provider: 'apollo' })
            totals.enriched++
            console.log('[enrich/engine] apollo fallback hit sub=%s', sub.id)
          } else if (apollo.kind === 'no_match' || apollo.kind === 'unavailable') {
            // Definitive miss from all available providers — record it so the
            // UI can say so instead of showing an empty enrichment state.
            // 'unavailable' = Apollo plan-gated; reason string distinguishes it
            // and misses never block a retry after the plan changes.
            const apolloOutcome = apollo.kind === 'no_match' ? 'no_match' : 'unavailable'
            await serviceDb
              .from('subscriber_enrichment')
              .upsert(
                {
                  subscriber_id: sub.id,
                  tenant_id: tenantId,
                  enrichment_provider: 'pdl',
                  provider_miss_reason: `pdl_${result.status}_apollo_${apolloOutcome}`,
                  enriched_at: now,
                  delete_at: deleteAt,
                },
                { onConflict: 'subscriber_id' },
              )
            await writeAudit(serviceDb, tenantId, sub.id, 'subscriber.enrichment_miss', {
              pdl_status: result.status,
              apollo: apolloOutcome,
              ...(apollo.kind === 'unavailable' ? { apollo_detail: apollo.detail } : {}),
            })
            totals.miss++
            console.log('[enrich/engine] miss sub=%s pdl_status=%d apollo=%s', sub.id, result.status, apolloOutcome)
          } else {
            // Apollo errored (auth, rate limit, network) — do NOT write a miss
            // row so the subscriber is retried on the next run. Persist the
            // detail to audit_logs so it can be diagnosed without log access.
            console.error('[enrich/engine] apollo fallback error sub=%s %s', sub.id, apollo.detail)
            await writeAudit(serviceDb, tenantId, sub.id, 'subscriber.enrichment_error', {
              provider: 'apollo', phase: 'fallback', pdl_status: result.status, detail: apollo.detail,
            })
            totals.errors++
          }
        }
      } catch (err) {
        console.error('[enrich/engine] subscriber error sub=%s err=%s', result.subscriber_id, String(err))
        totals.errors++
      }
    }
  }

  return totals
}
