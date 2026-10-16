'use server'

import { createClient } from '@/lib/supabase/server'
import { computeLifecycleStage } from '@/lib/utils/lifecycle'

export interface ImportRow {
  email: string
  name: string
  stated_graduation_date: string
  institution_name?: string
  institution_location?: string
  account_country?: string
  account_name?: string
  external_id?: string
  plan_name?: string
}

export interface ImportResult {
  imported: number
  skipped: number
  error?: string
}

export async function importSubscribersAction(rows: ImportRow[]): Promise<ImportResult> {
  const supabase = await createClient()

  const { data: authData } = await supabase.auth.getUser()
  if (!authData.user) return { imported: 0, skipped: rows.length, error: 'Not authenticated' }

  const { data: tenantUser } = (await supabase
    .from('tenant_users')
    .select('tenant_id')
    .eq('user_id', authData.user.id)
    .maybeSingle()) as unknown as { data: { tenant_id: string } | null }

  if (!tenantUser) {
    return { imported: 0, skipped: rows.length, error: 'No tenant account found for this user. Please contact Lycert support.' }
  }

  const records = rows.map(row => ({
    tenant_id: tenantUser.tenant_id,
    email: row.email.toLowerCase().trim(),
    name: row.name.trim() || null,
    stated_graduation_date: row.stated_graduation_date || null,
    institution_name: row.institution_name?.trim() || null,
    institution_location: row.institution_location?.trim() || null,
    account_country: row.account_country?.trim() || null,
    account_name: row.account_name?.trim() || null,
    external_id: row.external_id?.trim() || null,
    plan_name: row.plan_name?.trim() || null,
    plan_type: 'edu' as const,
    lifecycle_stage: computeLifecycleStage(row.stated_graduation_date),
  }))

  const { data, error } = (await supabase
    .from('subscribers')
    .upsert(records as unknown as never[], { onConflict: 'tenant_id,email', ignoreDuplicates: false })
    .select('id')) as unknown as { data: { id: string }[] | null; error: { message: string } | null }

  if (error) return { imported: 0, skipped: rows.length, error: error.message }

  return { imported: data?.length ?? 0, skipped: rows.length - (data?.length ?? 0) }
}