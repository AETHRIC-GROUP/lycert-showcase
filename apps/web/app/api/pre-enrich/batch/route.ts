import { NextResponse } from 'next/server'
import { createClient } from '@/lib/supabase/server'
import { createClient as createServiceClient, type SupabaseClient } from '@supabase/supabase-js'
import {
  cleanSchool,
  cleanLocation,
  runPreEnrichment,
  type RawCleaner,
  type PreEnrichSubscriber,
} from '@/lib/enrichment/pre-enrichment'

export const maxDuration = 60

/** Upsert institutions and return its trust_tier (existing or 'medium'), or null on failure.
 * Mirrors Python pre_enrichment._upsert_institution (service role bypasses RLS). */
async function upsertInstitution(db: SupabaseClient, fields: Record<string, unknown>): Promise<string | null> {
  const domain = fields.domain as string | null
  if (!domain) return 'medium'
  try {
    const { data: existing } = await db
      .from('institutions').select('id, trust_tier').eq('domain', domain).maybeSingle()
    if (existing) return (existing.trust_tier as string) ?? 'medium'
    await db.from('institutions').insert(fields)
    return 'medium'
  } catch {
    return null
  }
}

export async function POST() {
  const supabase = await createClient()
  const { data: { session } } = await supabase.auth.getSession()
  if (!session) return NextResponse.json({ error: 'Not authenticated' }, { status: 401 })

  let tenantId: string | null = null
  try {
    const payload = JSON.parse(Buffer.from(session.access_token.split('.')[1], 'base64').toString())
    tenantId = payload.tenant_id ?? null
  } catch { /* noop */ }
  if (!tenantId) return NextResponse.json({ error: 'No tenant in session' }, { status: 403 })

  const pdlKey = process.env.LYCERT_PDL_API_KEY ?? ''
  const serviceDb = createServiceClient(
    process.env.NEXT_PUBLIC_LYCERT_SUPABASE_URL!,
    process.env.LYCERT_SUPABASE_SERVICE_ROLE_KEY!,
  )

  const { data: subs, error: fetchErr } = await serviceDb
    .from('subscribers')
    // The subscribers column is `account_country` (there is no `account_location`); alias it to the
    // key runPreEnrichment expects. Selecting the non-existent name 500s as "DB fetch failed".
    .select('id, email, institution_name, account_location:account_country, institution_location, ' +
            'stated_graduation_date, auto_renew, institution_domain_verified')
    .eq('tenant_id', tenantId)
    .is('deleted_at', null) // never pre-enrich archived (soft-deleted) subscribers
    .is('email_domain_type', null)

  if (fetchErr) {
    return NextResponse.json({ error: 'DB fetch failed', detail: fetchErr.message }, { status: 500 })
  }

  // No PDL key → School/Location cleaners can't run; still classify email + compute priority.
  const deps = {
    cleanSchool: async (name: string): Promise<RawCleaner | null> =>
      pdlKey ? cleanSchool(name, pdlKey) : null,
    cleanLocation: async (loc: string): Promise<RawCleaner | null> =>
      pdlKey ? cleanLocation(loc, pdlKey) : null,
    upsertInstitution: (fields: Record<string, unknown>) => upsertInstitution(serviceDb, fields),
    // Free academic-domain reference lookup (no PDL credits). Exact-equality on the candidate strips;
    // most-specific (longest) match wins (campus.ul.pt over ul.pt).
    lookupAcademicDomain: async (candidates: string[]) => {
      if (!candidates.length) return null
      const { data } = await serviceDb
        .from('academic_domains').select('domain, name, country').in('domain', candidates)
      if (!data || !data.length) return null
      const best = data.reduce((a, b) => (b.domain.length > a.domain.length ? b : a))
      return { domain: best.domain as string, name: best.name as string, country: (best.country as string) ?? null }
    },
  }

  const rows = (subs ?? []) as unknown as Array<PreEnrichSubscriber & { id: string }>
  let updated = 0
  let errCount = 0

  for (const sub of rows) {
    try {
      const updates = await runPreEnrichment(sub, deps)
      const { error: updateErr } = await serviceDb
        .from('subscribers').update(updates).eq('id', sub.id).eq('tenant_id', tenantId)
      if (updateErr) errCount++
      else updated++
    } catch {
      errCount++
    }
  }

  console.log('[pre-enrich/batch] tenant=%s total=%d updated=%d errors=%d pdl=%s',
    tenantId, rows.length, updated, errCount, pdlKey ? 'on' : 'off')

  return NextResponse.json({
    status: 'complete',
    total: rows.length,
    updated,
    errors: errCount,
    pdl_cleaners: pdlKey ? 'enabled' : 'skipped (no LYCERT_PDL_API_KEY)',
  })
}
