'use client'

import Link from 'next/link'
import { rowsToCSV } from '@/lib/utils/csv'

type AuditRow = {
  id: string; created_at: string; action: string; actor_type: string
  resource_type: string; resource_id: string | null; metadata: Record<string, unknown> | null; actor_id: string | null
  tenant_users: { display_name: string | null; email: string } | null
}

type TeamMember = { id: string; display_name: string | null; email: string }

interface Props {
  rows: AuditRow[]
  count: number
  page: number
  totalPages: number
  actionFilter: string
  fromFilter: string
  toFilter: string
  actorFilter: string
  teamMembers: TeamMember[]
}

export function AuditLogClient({ rows, page, totalPages, actionFilter, fromFilter, toFilter, actorFilter, teamMembers }: Props) {
  function download() {
    const csv = rowsToCSV(rows.map(r => ({
      timestamp: r.created_at,
      action: r.action,
      actor: r.tenant_users?.display_name ?? r.tenant_users?.email ?? r.actor_type,
      resource_type: r.resource_type,
      resource_id: r.resource_id ?? '',
    })))
    const blob = new Blob([csv], { type: 'text/csv' })
    const url = URL.createObjectURL(blob)
    const a = document.createElement('a')
    a.href = url; a.download = 'audit-log.csv'; a.click()
    URL.revokeObjectURL(url)
  }

  const qs = (extra?: Record<string, string>) => {
    const p: Record<string, string> = {}
    if (actionFilter) p.action = actionFilter
    if (fromFilter) p.from = fromFilter
    if (toFilter) p.to = toFilter
    if (actorFilter) p.actor = actorFilter
    Object.assign(p, extra)
    const s = new URLSearchParams(p).toString()
    return s ? `?${s}` : ''
  }

  const hasFilters = actionFilter || fromFilter || toFilter || actorFilter

  return (
    <div>
      <form action="/dashboard/settings/audit-log" method="GET" className="flex flex-wrap gap-3 mb-4">
        <input type="search" name="action" defaultValue={actionFilter}
          placeholder="Filter by action…"
          className="rounded-lg border border-gray-300 px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-brand-500 w-48" />

        <select name="actor" defaultValue={actorFilter}
          className="rounded-lg border border-gray-300 px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-brand-500">
          <option value="">All actors</option>
          {teamMembers.map(m => (
            <option key={m.id} value={m.id}>{m.display_name ?? m.email}</option>
          ))}
        </select>

        <div className="flex items-center gap-2">
          <input type="date" name="from" defaultValue={fromFilter}
            className="rounded-lg border border-gray-300 px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-brand-500" />
          <span className="text-gray-400 text-sm">to</span>
          <input type="date" name="to" defaultValue={toFilter}
            className="rounded-lg border border-gray-300 px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-brand-500" />
        </div>

        <button type="submit"
          className="px-4 py-2 border border-gray-300 rounded-lg text-sm text-gray-700 hover:bg-gray-50">Apply</button>
        {hasFilters && (
          <Link href="/dashboard/settings/audit-log"
            className="px-4 py-2 text-sm text-gray-500 hover:text-gray-700">Clear</Link>
        )}
        <button type="button" onClick={download}
          className="ml-auto px-4 py-2 border border-gray-300 rounded-lg text-sm text-gray-700 hover:bg-gray-50">
          Export CSV
        </button>
      </form>

      {rows.length === 0 ? (
        <div className="bg-white rounded-xl border border-gray-200 p-12 text-center">
          <p className="text-sm text-gray-500">No audit log entries yet.</p>
        </div>
      ) : (
        <div className="bg-white rounded-xl border border-gray-200 overflow-hidden">
          <div className="overflow-x-auto">
            <table className="w-full text-sm">
              <thead className="bg-gray-50 border-b border-gray-200">
                <tr>
                  {['Timestamp', 'Action', 'Actor', 'Resource', 'Resource ID'].map(h => (
                    <th key={h} className="px-4 py-3 text-left text-xs font-medium text-gray-500 uppercase tracking-wide whitespace-nowrap">{h}</th>
                  ))}
                </tr>
              </thead>
              <tbody className="divide-y divide-gray-100">
                {rows.map(r => (
                  <tr key={r.id} className="hover:bg-gray-50">
                    <td className="px-4 py-2 text-gray-500 text-xs whitespace-nowrap">
                      {new Date(r.created_at).toLocaleString('en-GB', { dateStyle: 'short', timeStyle: 'short' })}
                    </td>
                    <td className="px-4 py-2 font-mono text-xs text-gray-700">{r.action}</td>
                    <td className="px-4 py-2 text-gray-600 text-xs">
                      {r.tenant_users?.display_name ?? r.tenant_users?.email ?? (
                        <span className="capitalize text-gray-400">{r.actor_type}</span>
                      )}
                    </td>
                    <td className="px-4 py-2 text-gray-600 text-xs">{r.resource_type}</td>
                    <td className="px-4 py-2 text-gray-400 font-mono text-xs truncate max-w-xs">
                      {r.resource_id ?? '—'}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>

          {totalPages > 1 && (
            <div className="px-4 py-3 border-t border-gray-200 flex justify-between text-sm text-gray-600">
              <span>Page {page} of {totalPages}</span>
              <div className="flex gap-2">
                {page > 1 && <Link href={`/dashboard/settings/audit-log${qs({ page: String(page - 1) })}`} className="px-3 py-1 border rounded hover:bg-gray-50">← Prev</Link>}
                {page < totalPages && <Link href={`/dashboard/settings/audit-log${qs({ page: String(page + 1) })}`} className="px-3 py-1 border rounded hover:bg-gray-50">Next →</Link>}
              </div>
            </div>
          )}
        </div>
      )}
    </div>
  )
}
