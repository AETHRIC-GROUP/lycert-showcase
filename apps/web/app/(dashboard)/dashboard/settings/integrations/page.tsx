import { createClient } from '@/lib/supabase/server'
import { redirect } from 'next/navigation'
import { EnrichmentWaterfallPanel } from '@/components/enrichment-waterfall-panel'
import { HubspotIntegrationCard } from '@/components/hubspot-integration-card'

export default async function IntegrationsPage() {
  const supabase = await createClient()
  const { data: { user } } = await supabase.auth.getUser()
  if (!user) redirect('/login')

  const { data: tu } = (await supabase
    .from('tenant_users')
    .select('role, tenant_id')
    .eq('user_id', user.id)
    .maybeSingle()) as unknown as { data: { role: string; tenant_id: string } | null }

  if (!tu || !['owner', 'admin'].includes(tu.role)) {
    redirect('/dashboard')
  }

  const tenantId = tu.tenant_id
  const [{ data: connection }, { data: mappings }, { data: segment }, { data: runs }] = await Promise.all([
    supabase.from('crm_connections').select('status, last_error').eq('tenant_id', tenantId).eq('provider', 'hubspot').maybeSingle(),
    supabase.from('crm_property_mappings').select('lycert_field, crm_property, status').eq('tenant_id', tenantId).eq('provider', 'hubspot').eq('direction', 'outbound').eq('status', 'conflict'),
    supabase.from('crm_segment_config').select('definition').eq('tenant_id', tenantId).eq('provider', 'hubspot').maybeSingle(),
    supabase.from('crm_sync_runs').select('status, finished_at, counts').eq('tenant_id', tenantId).eq('provider', 'hubspot').order('started_at', { ascending: false }).limit(1),
  ]) as unknown as [
    { data: { status: string; last_error: string | null } | null },
    { data: Array<{ lycert_field: string; crm_property: string; status: string }> | null },
    { data: { definition: { property: string; value: string } } | null },
    { data: Array<{ status: string; finished_at: string | null; counts: Record<string, number> | null }> | null },
  ]

  return (
    <div className="max-w-2xl">
      <div className="mb-6">
        <h1 className="text-xl font-bold text-gray-900">Integrations</h1>
        <p className="text-sm text-gray-500 mt-1">
          Enrichment providers are managed by Lycert. Owners and admins can reorder the
          waterfall and enable or disable individual providers for this account.
        </p>
      </div>

      {/* V2 waterfall: provider cards + drag-to-reorder + per-provider spend */}
      <div className="mb-8">
        <EnrichmentWaterfallPanel />
      </div>

      {/* CRM integrations — Bridge Part 6: Lycert orchestrates the client's own CRM + verification
          provider rather than owning authoritative verification (LYCERT_BRIDGE_ARCHITECTURE.md). */}
      <div>
        <h2 className="text-xs font-semibold text-gray-500 uppercase tracking-wide mb-3">
          CRM Integrations
        </h2>
        <div className="space-y-3">
          <HubspotIntegrationCard
            connected={connection?.status === 'connected' || connection?.status === 'error'}
            status={(connection?.status as 'connected' | 'error' | 'disconnected' | undefined) ?? null}
            lastError={connection?.last_error ?? null}
            conflicts={(mappings ?? []).map(m => ({ name: m.lycert_field, expectedType: '', actualType: '' }))}
            segmentConfigured={!!segment}
            segmentDefinition={segment?.definition ?? null}
            lastSyncRun={runs && runs.length > 0 ? { status: runs[0].status, finishedAt: runs[0].finished_at, counts: runs[0].counts } : null}
          />
        </div>
      </div>
    </div>
  )
}
