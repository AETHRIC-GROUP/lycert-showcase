/**
 * Persist one FullEnrich result item to the DB — shared by the webhook receiver and the poll
 * reconciler (the timeout/poll sweep) so both apply results identically. Pure merge/idempotency logic
 * lives in fullenrich-webhook.ts (applyFullenrichResult); this is the thin IO wrapper around it:
 * load existing row + subscriber name → apply → upsert → accumulate job stats → re-enqueue scoring.
 *
 * Idempotent: applyFullenrichResult only does work while the subscriber is still pending on fullenrich,
 * so the webhook and the poller can both run without double-merging or double-charging.
 */
import type { SupabaseClient } from '@supabase/supabase-js'
import { enqueue, QUEUES, type RpcClient } from './queue'
import { applyFullenrichResult, type ExistingEnrichment } from './fullenrich-webhook'
import type { WebhookResultItem } from './providers/fullenrich'

export type ApplyItemResult = { applied: boolean; matched: boolean; skipped: boolean }

export async function applyFullenrichItem(db: SupabaseClient, item: WebhookResultItem): Promise<ApplyItemResult> {
  const rpc = db as unknown as RpcClient

  const { data: existing } = await db
    .from('subscriber_enrichment').select('*').eq('subscriber_id', item.subscriberId).maybeSingle()
  const tenantId = (existing as Record<string, unknown> | null)?.tenant_id as string | undefined
  const { data: sub } = await db
    .from('subscribers').select('name').eq('id', item.subscriberId).maybeSingle()
  const subscriberName = (sub as { name?: string | null } | null)?.name ?? null

  const res = applyFullenrichResult(existing as ExistingEnrichment | null, item, subscriberName)
  if (res.status !== 'applied') return { applied: false, matched: false, skipped: true }

  // tenant_id is NOT NULL and applyFullenrichResult's update omits it; upsert runs INSERT...ON CONFLICT,
  // so the proposed row must carry it or it fails the not-null check before the conflict resolves. We
  // only reach here when `existing` is non-null (applyFullenrichResult returns no_existing_row otherwise),
  // so tenantId is always present.
  const { error: upErr } = await db
    .from('subscriber_enrichment')
    .upsert({ subscriber_id: item.subscriberId, tenant_id: tenantId, ...res.update }, { onConflict: 'subscriber_id' })
  if (upErr) throw new Error(`persist: ${upErr.message}`)

  if (item.jobId) {
    await db.rpc('q_job_accumulate', {
      p_job_id: item.jobId,
      p_stats: res.delta.perProvider,
      p_success: res.delta.success,
      p_miss: res.delta.miss,
      p_error: 0,
      p_low_quality: 0,
      p_pdl_credits: 0,
      p_cost: res.delta.costUsd,
      p_async_pending: res.delta.asyncPending,
      // Async completion never re-ticks processed — the subscriber was counted in the sync phase.
      p_processed: 0,
    })
  }

  // Re-score: late FullEnrich data may change the LinkedIn-derived (Tier C) signals.
  if (tenantId) {
    await enqueue(rpc, QUEUES.scoring, [{ subscriberId: item.subscriberId, tenantId, referenceDate: null }])
  }

  return { applied: true, matched: res.matched, skipped: false }
}
