'use server'

import { revalidatePath } from 'next/cache'
import { createClient } from '@/lib/supabase/server'
import type { Enums } from '@/lib/database.types'

export async function assignCaseAction(caseId: string): Promise<{ error?: string }> {
  const supabase = await createClient()
  const { data: authData } = await supabase.auth.getUser()
  if (!authData.user) return { error: 'Not authenticated' }

  const { data: tu } = (await supabase
    .from('tenant_users').select('id, tenant_id').eq('user_id', authData.user.id).maybeSingle()
  ) as unknown as { data: { id: string; tenant_id: string } | null }

  if (!tu) return { error: 'No tenant account found' }

  const { error } = await (supabase.from('cases') as any)
    .update({ assigned_to: tu.id, status: 'in_review' })
    .eq('id', caseId)

  if (error) return { error: error.message }

  await (supabase.from('audit_logs') as any).insert({
    tenant_id: tu.tenant_id,
    actor_id: tu.id,
    actor_type: 'user' as Enums<'actor_type'>,
    action: 'case.assigned',
    resource_type: 'case',
    resource_id: caseId,
    metadata: {},
  })

  revalidatePath('/dashboard/cases')
  return {}
}

export async function addCommentAction(caseId: string, tenantId: string, authorId: string, body: string): Promise<{ error?: string }> {
  const supabase = await createClient()

  const { error } = await (supabase.from('case_comments') as any).insert({
    case_id: caseId,
    tenant_id: tenantId,
    author_id: authorId,
    body: body.trim(),
  })

  if (error) return { error: error.message }

  await (supabase.from('audit_logs') as any).insert({
    tenant_id: tenantId,
    actor_id: authorId,
    actor_type: 'user' as Enums<'actor_type'>,
    action: 'case.comment_added',
    resource_type: 'case',
    resource_id: caseId,
    metadata: {},
  })

  revalidatePath(`/dashboard/cases/${caseId}`)
  return {}
}
