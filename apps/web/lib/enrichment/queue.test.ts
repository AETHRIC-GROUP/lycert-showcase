/** pgmq access-layer tests with a fake RPC client. */
import { describe, it, expect } from 'vitest'
import { enqueue, readBatch, archive, toDlq, type RpcClient } from './queue'

function fakeDb(responses: Record<string, unknown> = {}): RpcClient & { calls: Array<{ fn: string; args: Record<string, unknown> }> } {
  const calls: Array<{ fn: string; args: Record<string, unknown> }> = []
  return {
    calls,
    rpc(fn, args) {
      calls.push({ fn, args })
      return Promise.resolve({ data: responses[fn] ?? null, error: null })
    },
  }
}

describe('queue access layer', () => {
  it('enqueue sends the message array and returns ids', async () => {
    const db = fakeDb({ q_send: [10, 11] })
    const ids = await enqueue(db, 'enrichment_jobs_q', [{ subscriber_id: 'a' }, { subscriber_id: 'b' }])
    expect(ids).toEqual([10, 11])
    expect(db.calls[0]).toEqual({ fn: 'q_send', args: { p_queue: 'enrichment_jobs_q', p_msgs: [{ subscriber_id: 'a' }, { subscriber_id: 'b' }] } })
  })

  it('enqueue of empty list is a no-op', async () => {
    const db = fakeDb()
    expect(await enqueue(db, 'q', [])).toEqual([])
    expect(db.calls).toHaveLength(0)
  })

  it('readBatch maps rows to {msgId, readCt, message}', async () => {
    const db = fakeDb({ q_read: [{ msg_id: 1, read_ct: 2, message: { subscriber_id: 'a' } }] })
    const msgs = await readBatch(db, 'enrichment_jobs_q', 15, 120)
    expect(msgs).toEqual([{ msgId: 1, readCt: 2, message: { subscriber_id: 'a' } }])
    expect(db.calls[0].args).toEqual({ p_queue: 'enrichment_jobs_q', p_qty: 15, p_vt: 120 })
  })

  it('archive + toDlq call the right RPCs', async () => {
    const db = fakeDb({ q_to_dlq: 99 })
    await archive(db, 'enrichment_jobs_q', 5)
    await toDlq(db, 'enrichment_jobs_q', 'enrichment_dlq', 5, { subscriber_id: 'a' })
    expect(db.calls.map(c => c.fn)).toEqual(['q_archive', 'q_to_dlq'])
  })

  it('propagates RPC errors', async () => {
    const db: RpcClient = { rpc: () => Promise.resolve({ data: null, error: { message: 'boom' } }) }
    await expect(enqueue(db, 'q', [{ x: 1 }])).rejects.toThrow('q_send: boom')
  })
})
