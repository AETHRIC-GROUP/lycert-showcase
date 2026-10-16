import { NextRequest, NextResponse } from 'next/server'
import { createClient } from '@/lib/supabase/server'
import { createClient as createServiceClient } from '@supabase/supabase-js'
import type { LifecycleStage } from '@/lib/utils/lifecycle'
import { enqueue, type RpcClient } from '@/lib/enrichment/queue'
import { VERIFICATION_QUEUES } from '@/lib/verification/worker-io'
import { isVerificationExpired, verificationExpiryPatch, type VerificationCadenceRow } from '@/lib/verification/cadence'

export const maxDuration = 60

const LOCKED_STAGES = new Set<LifecycleStage>(['converted', 'churned', 'dismissed'])

function computeStage(
  graduationDateStr: string | null,
  currentStage: LifecycleStage,
  gracePeriodDays: number,
): LifecycleStage {
  if (LOCKED_STAGES.has(currentStage) || currentStage === 're_verification_pending') {
    return currentStage
  }
  if (!graduationDateStr) return currentStage

  const today = new Date()
  today.setHours(0, 0, 0, 0)
  const grad = new Date(graduationDateStr)
  if (isNaN(grad.getTime())) return currentStage

  const daysToGrad = Math.floor((grad.getTime() - today.getTime()) / 86_400_000)

  if (daysToGrad > 90) return 'active_student'
  if (daysToGrad > 0) return 'approaching_graduation'
  if (daysToGrad >= -gracePeriodDays) return 'active_student' // within grace period
  return 'post_graduation_unverified'
}

function makeServiceClient() {
  return createServiceClient(
    process.env.NEXT_PUBLIC_LYCERT_SUPABASE_URL!,
    process.env.LYCERT_SUPABASE_SERVICE_ROLE_KEY!,
  )
}

/**
 * Re-verification cadence (verification Part 9.3): confirmations past verification_expires_at lapse to
 * 'verification_expired' (an exact scoring no-op — never adverse) and the subscriber is re-enqueued on
 * verification_q so the waterfall re-checks. Consent/provider gates all still apply on the re-run.
 */
async function runVerificationCadence(
  db: ReturnType<typeof makeServiceClient>,
  tenantId: string,
  actorId: string | null,
): Promise<number> {
  const now = new Date()
  const { data } = (await db
    .from('subscribers')
    .select('id, verification_status, verification_expires_at')
    .eq('tenant_id', tenantId)
    .in('verification_status', ['verified_enrolled', 'verified_not_enrolled'])
    .lte('verification_expires_at', now.toISOString())) as unknown as { data: VerificationCadenceRow[] | null }

  const expired = (data ?? []).filter(r => isVerificationExpired(r, now))
  for (const r of expired) {
    await db.from('subscribers').update(verificationExpiryPatch()).eq('id', r.id).eq('tenant_id', tenantId)
    await db.from('audit_logs').insert({
      tenant_id: tenantId,
      actor_type: actorId ? 'user' : 'system',
      actor_id: actorId,
      action: 'subscriber.verification_expired',
      resource_type: 'subscriber',
      resource_id: r.id,
      metadata: { previous_status: r.verification_status, expired_at: r.verification_expires_at },
    })
  }
  if (expired.length) {
    await enqueue(db as unknown as RpcClient, VERIFICATION_QUEUES.verification,
      expired.map(r => ({ subscriberId: r.id, tenantId })))
  }
  return expired.length
}

async function runForTenant(
  db: ReturnType<typeof makeServiceClient>,
  tenantId: string,
  actorId: string | null,
): Promise<{ evaluated: number; updated: number }> {
  const { data: config } = (await db
    .from('tenant_scoring_config')
    .select('grace_period_days')
    .eq('tenant_id', tenantId)
    .maybeSingle()) as unknown as { data: { grace_period_days: number } | null }

  const gracePeriodDays = config?.grace_period_days ?? 90

  const { data: subscribers, error: fetchError } = (await db
    .from('subscribers')
    .select('id, stated_graduation_date, lifecycle_stage')
    .eq('tenant_id', tenantId)) as unknown as {
    data: { id: string; stated_graduation_date: string | null; lifecycle_stage: LifecycleStage }[] | null
    error: { message: string } | null
  }

  if (fetchError || !subscribers) return { evaluated: 0, updated: 0 }

  const today = new Date().toISOString().slice(0, 10)
  let updated = 0

  for (const sub of subscribers) {
    const newStage = computeStage(sub.stated_graduation_date, sub.lifecycle_stage, gracePeriodDays)
    if (newStage === sub.lifecycle_stage) continue

    await db.from('subscribers').update({ lifecycle_stage: newStage }).eq('id', sub.id)
    await db.from('audit_logs').insert({
      tenant_id: tenantId,
      actor_type: actorId ? 'user' : 'system',
      actor_id: actorId,
      action: 'subscriber.lifecycle_stage_updated',
      resource_type: 'subscriber',
      resource_id: sub.id,
      metadata: {
        previous_stage: sub.lifecycle_stage,
        new_stage: newStage,
        job_date: today,
        triggered_by: actorId ? 'manual' : 'cron',
      },
    })
    updated++
  }

  return { evaluated: subscribers.length, updated }
}

export async function POST(req: NextRequest) {
  // --- Vercel cron path: Authorization: Bearer {CRON_SECRET} ---
  const cronSecret = process.env.CRON_SECRET
  const authHeader = req.headers.get('Authorization')
  if (cronSecret && authHeader === `Bearer ${cronSecret}`) {
    const db = makeServiceClient()
    const { data: tenants } = (await db
      .from('tenants')
      .select('id')
      .eq('onboarding_complete', true)) as unknown as { data: { id: string }[] | null }

    if (!tenants?.length) {
      return NextResponse.json({ job_date: new Date().toISOString().slice(0, 10), tenants: 0, updated: 0 })
    }

    let totalEvaluated = 0
    let totalUpdated = 0
    let totalExpired = 0
    for (const tenant of tenants) {
      const result = await runForTenant(db, tenant.id, null)
      totalEvaluated += result.evaluated
      totalUpdated += result.updated
      totalExpired += await runVerificationCadence(db, tenant.id, null)
    }

    return NextResponse.json({
      job_date: new Date().toISOString().slice(0, 10),
      tenants: tenants.length,
      evaluated: totalEvaluated,
      updated: totalUpdated,
      verification_expired: totalExpired,
    })
  }

  // --- Manual path: requires authenticated user with owner/admin role ---
  const supabase = await createClient()
  const { data: { user } } = await supabase.auth.getUser()
  if (!user) return NextResponse.json({ error: 'Not authenticated' }, { status: 401 })

  const { data: tu } = (await supabase
    .from('tenant_users')
    .select('tenant_id, role')
    .eq('user_id', user.id)
    .maybeSingle()) as unknown as { data: { tenant_id: string; role: string } | null }

  if (!tu) return NextResponse.json({ error: 'No tenant account' }, { status: 403 })
  if (!['owner', 'admin'].includes(tu.role)) {
    return NextResponse.json({ error: 'Owner or admin role required' }, { status: 403 })
  }

  const db = makeServiceClient()
  const result = await runForTenant(db, tu.tenant_id, user.id)
  const expired = await runVerificationCadence(db, tu.tenant_id, user.id)

  return NextResponse.json({
    job_date: new Date().toISOString().slice(0, 10),
    evaluated: result.evaluated,
    updated: result.updated,
    verification_expired: expired,
  })
}
