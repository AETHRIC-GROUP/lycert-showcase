'use server'

import { revalidatePath } from 'next/cache'
import { createClient } from '@/lib/supabase/server'
import type { Enums } from '@/lib/database.types'

const STATUS_MAP: Record<string, Enums<'case_status'>> = {
  proceed_outreach:       'approved_for_outreach',
  dismiss_false_positive: 'dismissed',
  escalate:               'in_review',
}

const ACTION_MAP: Record<string, string> = {
  proceed_outreach:       'case.approved_for_outreach',
  dismiss_false_positive: 'case.dismissed',
  escalate:               'case.escalated',
}

export async function submitCaseDecisionAction(
  caseId: string,
  decision: string,
  note: string,
  durationSeconds: number,
): Promise<{ error?: string }> {
  const supabase = await createClient()

  const { data: authData } = await supabase.auth.getUser()
  if (!authData.user) return { error: 'Not authenticated' }

  const { data: tu } = (await supabase
    .from('tenant_users')
    .select('id, tenant_id')
    .eq('user_id', authData.user.id)
    .maybeSingle()) as unknown as { data: { id: string; tenant_id: string } | null }

  if (!tu) return { error: 'No tenant account found' }

  const { error: updateError } = await (supabase.from('cases') as any).update({
    decision: decision as Enums<'case_decision'>,
    decision_note: note,
    review_duration_seconds: durationSeconds,
    decided_at: new Date().toISOString(),
    status: STATUS_MAP[decision] ?? 'in_review',
  }).eq('id', caseId)

  if (updateError) return { error: updateError.message }

  await (supabase.from('audit_logs') as any).insert({
    tenant_id: tu.tenant_id,
    actor_id: tu.id,
    actor_type: 'user' as Enums<'actor_type'>,
    action: ACTION_MAP[decision] ?? 'case.decision_submitted',
    resource_type: 'case',
    resource_id: caseId,
    metadata: { decision, note, review_duration_seconds: durationSeconds },
  })

  revalidatePath(`/dashboard/cases/${caseId}`)
  revalidatePath('/dashboard/cases')
  return {}
}
