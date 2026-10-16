/**
 * pgmq access layer — typed wrappers over the public.q_* SECURITY DEFINER functions
 * (migration 0030). The Node worker (Vercel route, invoked by pg_cron via pg_net) uses these.
 *
 * Chunk sizes are the one number that silently breaks this at scale (ENGINE_CONSOLIDATION_PLAN.md):
 * each worker invocation must finish well within the function timeout incl. the slowest provider.
 * Tunable here; watched first during the backfill load test.
 */

// Enrichment chunk: ~120s usable budget ÷ ~8s worst-case per subscriber (RC+Datagma+PDL) ≈ 15.
export const ENRICHMENT_CHUNK_SIZE = 15
// Scoring has no external calls → CPU-bound only; far larger.
export const SCORING_CHUNK_SIZE = 200
// Visibility timeout: how long a message is hidden while a chunk processes (retry on crash after).
export const ENRICHMENT_VT_SECONDS = 120
export const SCORING_VT_SECONDS = 60
// Past this delivery count a message is routed to the dead-letter queue (observable, never silent).
export const MAX_READ_CT = 5

export const QUEUES = {
  enrichment: 'enrichment_jobs_q',
  enrichmentDlq: 'enrichment_dlq',
  scoring: 'scoring_q',
  scoringDlq: 'scoring_dlq',
} as const

export type QueueMessage<T = Record<string, unknown>> = { msgId: number; readCt: number; message: T }

/** Minimal Supabase-client surface (for testability). */
export interface RpcClient {
  rpc(fn: string, args: Record<string, unknown>): PromiseLike<{ data: unknown; error: { message: string } | null }>
}

async function call(db: RpcClient, fn: string, args: Record<string, unknown>): Promise<unknown> {
  const { data, error } = await db.rpc(fn, args)
  if (error) throw new Error(`${fn}: ${error.message}`)
  return data
}

/** Enqueue one message per element. Returns the assigned msg_ids. */
export async function enqueue(db: RpcClient, queue: string, messages: unknown[]): Promise<number[]> {
  if (!messages.length) return []
  const data = await call(db, 'q_send', { p_queue: queue, p_msgs: messages })
  return Array.isArray(data) ? (data as number[]) : []
}

/** Read up to qty messages, hidden for vt seconds. */
export async function readBatch<T = Record<string, unknown>>(
  db: RpcClient, queue: string, qty: number, vt: number,
): Promise<QueueMessage<T>[]> {
  const rows = (await call(db, 'q_read', { p_queue: queue, p_qty: qty, p_vt: vt })) as Array<{
    msg_id: number; read_ct: number; message: T
  }>
  return (rows ?? []).map(r => ({ msgId: r.msg_id, readCt: r.read_ct, message: r.message }))
}

export async function archive(db: RpcClient, queue: string, msgId: number): Promise<void> {
  await call(db, 'q_archive', { p_queue: queue, p_msg_id: msgId })
}

export async function deleteMessage(db: RpcClient, queue: string, msgId: number): Promise<void> {
  await call(db, 'q_delete', { p_queue: queue, p_msg_id: msgId })
}

/** Route a message to its dead-letter queue (send to DLQ + archive from source). */
export async function toDlq(db: RpcClient, fromQueue: string, dlq: string, msgId: number, message: unknown): Promise<void> {
  await call(db, 'q_to_dlq', { p_from: fromQueue, p_dlq: dlq, p_msg_id: msgId, p_msg: message })
}

export async function metrics(db: RpcClient): Promise<Array<{ queueName: string; queueLength: number }>> {
  const rows = (await call(db, 'q_metrics', {})) as Array<{ queue_name: string; queue_length: number }>
  return (rows ?? []).map(r => ({ queueName: r.queue_name, queueLength: r.queue_length }))
}
