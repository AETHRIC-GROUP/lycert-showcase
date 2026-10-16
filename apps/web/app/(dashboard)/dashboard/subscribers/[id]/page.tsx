import { notFound } from 'next/navigation'
import Link from 'next/link'
import { createClient } from '@/lib/supabase/server'
import { SubscriberTabs } from '@/components/subscribers/subscriber-tabs'
import { CopyVerificationLinkButton } from '@/components/verification/copy-verification-link-button'

interface PageProps {
  params: { id: string }
}

export default async function SubscriberDetailPage({ params }: PageProps) {
  const supabase = await createClient()

  const [subRes, scoresRes, enrichRes, casesRes, auditRes] = await Promise.all([
    (supabase.from('subscribers').select('*').eq('id', params.id).single()) as unknown as Promise<{ data: Record<string, unknown> | null }>,
    (supabase.from('subscriber_scores').select('*').eq('subscriber_id', params.id).order('scored_at', { ascending: false })) as unknown as Promise<{ data: Record<string, unknown>[] | null }>,
    (supabase.from('subscriber_enrichment').select('*').eq('subscriber_id', params.id).maybeSingle()) as unknown as Promise<{ data: Record<string, unknown> | null }>,
    (supabase.from('cases').select('id, opened_at, status, decision, decided_at, score_id').eq('subscriber_id', params.id).order('opened_at', { ascending: false })) as unknown as Promise<{ data: Record<string, unknown>[] | null }>,
    (supabase.from('audit_logs').select('id, created_at, action, actor_type, resource_type, metadata').eq('resource_id', params.id).order('created_at', { ascending: false }).limit(50)) as unknown as Promise<{ data: Record<string, unknown>[] | null }>,
  ])

  if (!subRes.data) notFound()
  const isArchived = !!(subRes.data as { deleted_at?: string | null }).deleted_at

  // Role gate for owner/admin-only affordances (the invite API enforces it server-side as well).
  const { data: { user } } = await supabase.auth.getUser()
  const { data: tu } = (await supabase
    .from('tenant_users').select('role').eq('user_id', user?.id ?? '').maybeSingle()) as unknown as { data: { role: string } | null }
  const canInvite = ['owner', 'admin'].includes(tu?.role ?? '')

  return (
    <div>
      <div className="mb-4 flex items-center justify-between">
        <Link href="/dashboard/subscribers" className="text-sm text-brand-600 hover:underline">
          ← All subscribers
        </Link>
        {canInvite && !isArchived && <CopyVerificationLinkButton subscriberId={params.id} />}
      </div>
      {isArchived && (
        <div className="mb-4 rounded-lg border border-amber-200 bg-amber-50 px-4 py-2.5 text-sm text-amber-800">
          This subscriber is <span className="font-medium">archived</span> and excluded from scoring and
          enrichment. Restore it from the Archived view to make it active again.
        </div>
      )}
      <SubscriberTabs
        subscriber={subRes.data as Parameters<typeof SubscriberTabs>[0]['subscriber']}
        scores={(scoresRes.data ?? []) as Parameters<typeof SubscriberTabs>[0]['scores']}
        enrichment={(enrichRes.data ?? null) as Parameters<typeof SubscriberTabs>[0]['enrichment']}
        cases={(casesRes.data ?? []) as Parameters<typeof SubscriberTabs>[0]['cases']}
        auditLog={(auditRes.data ?? []) as Parameters<typeof SubscriberTabs>[0]['auditLog']}
      />
    </div>
  )
}