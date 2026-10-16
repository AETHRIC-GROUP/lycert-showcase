import { createClient } from '@/lib/supabase/server'
import { AuditLogClient } from '@/components/audit-log-client'

interface PageProps {
  searchParams: { action?: string; page?: string; from?: string; to?: string; actor?: string }
}

type AuditRow = {
  id: string
  created_at: string
  action: string
  actor_type: string
  resource_type: string
  resource_id: string | null
  metadata: Record<string, unknown> | null
  actor_id: string | null
  tenant_users: { display_name: string | null; email: string } | null
}

type TenantUserRow = { id: string; display_name: string | null; email: string }

export default async function AuditLogPage({ searchParams }: PageProps) {
  const supabase = await createClient()
  const actionFilter = searchParams.action ?? ''
  const fromFilter = searchParams.from ?? ''
  const toFilter = searchParams.to ?? ''
  const actorFilter = searchParams.actor ?? ''
  const page = Math.max(1, parseInt(searchParams.page ?? '1', 10))
  const pageSize = 100

  // Fetch team members for actor filter dropdown
  const { data: teamMembers } = (await supabase
    .from('tenant_users')
    .select('id, display_name, email')
    .order('email')) as unknown as { data: TenantUserRow[] | null }

  let query = supabase
    .from('audit_logs')
    .select('id, created_at, action, actor_type, resource_type, resource_id, metadata, actor_id, tenant_users(display_name, email)', { count: 'exact' })
    .order('created_at', { ascending: false })
    .range((page - 1) * pageSize, page * pageSize - 1)

  if (actionFilter) query = query.ilike('action', `%${actionFilter}%`)
  if (fromFilter) query = (query as any).gte('created_at', fromFilter)
  if (toFilter) query = (query as any).lte('created_at', toFilter + 'T23:59:59Z')
  if (actorFilter) query = (query as any).eq('actor_id', actorFilter)

  const { data, count } = await (query as unknown as Promise<{ data: AuditRow[] | null; count: number | null }>)

  const rows = data ?? []
  const totalPages = Math.ceil((count ?? 0) / pageSize)

  return (
    <div>
      <div className="flex items-center justify-between mb-6">
        <div>
          <h1 className="text-2xl font-bold text-gray-900">Audit Log</h1>
          <p className="mt-1 text-sm text-gray-500">{count ?? 0} entries</p>
        </div>
      </div>

      <AuditLogClient
        rows={rows}
        count={count ?? 0}
        page={page}
        totalPages={totalPages}
        actionFilter={actionFilter}
        fromFilter={fromFilter}
        toFilter={toFilter}
        actorFilter={actorFilter}
        teamMembers={teamMembers ?? []}
      />
    </div>
  )
}
