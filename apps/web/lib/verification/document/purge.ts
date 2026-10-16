/**
 * Process-and-purge (LYCERT_DOCUMENT_REVIEW_ARCHITECTURE.md Stage G / Part 5) — the single most important
 * safety mechanism: the raw document must be destroyed the instant a verdict is recorded, and unconditionally
 * by the 24h hard ceiling. The purge worker calls selectPurgeable() to find raw files due for deletion, then
 * (for each) deletes the storage object, nulls transient_storage_ref, and stamps purged_at.
 */

export interface PurgeableRow {
  id: string
  transient_storage_ref: string | null
  storage_delete_at: string // ISO
  purged_at: string | null
}

/**
 * A row is purgeable when it still holds a raw file (ref present, not yet purged) AND its deletion time has
 * arrived. Verdict-reached rows get `storage_delete_at` set to now() so they purge on the very next sweep;
 * everything else purges by the 24h ceiling regardless.
 */
export function selectPurgeable(rows: PurgeableRow[], now: Date): PurgeableRow[] {
  const t = now.getTime()
  return rows.filter(
    r => r.transient_storage_ref != null && r.purged_at == null && new Date(r.storage_delete_at).getTime() <= t,
  )
}

/** The patch applied to a row once its raw file is destroyed. */
export function purgedPatch(now: Date): { transient_storage_ref: null; purged_at: string } {
  return { transient_storage_ref: null, purged_at: now.toISOString() }
}
