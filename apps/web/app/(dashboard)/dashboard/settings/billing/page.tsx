import { createClient } from '@/lib/supabase/server'
import { BillingClient } from '@/components/billing-client'

type TenantRow = {
  id: string
  plan_tier: string
  stripe_customer_id: string | null
  stripe_subscription_id: string | null
  stripe_subscription_status: string | null
  enrichment_credits_used: number
  enrichment_credits_limit: number | null
  billing_cycle_start: string | null
}

const PLAN_ENRICHMENT_LIMITS: Record<string, number | null> = {
  starter: 500,
  growth: 2000,
  pro: 10000,
  enterprise: null,
}

const PLAN_LABELS: Record<string, string> = {
  starter: 'Starter',
  growth: 'Growth',
  pro: 'Pro',
  enterprise: 'Enterprise',
}

export default async function BillingPage() {
  const supabase = await createClient()

  const { data: authData } = await supabase.auth.getUser()
  if (!authData.user) return null

  const { data: tu } = (await supabase
    .from('tenant_users')
    .select('tenant_id, role')
    .eq('user_id', authData.user.id)
    .maybeSingle()) as unknown as { data: { tenant_id: string; role: string } | null }

  const { data: tenant } = (await supabase
    .from('tenants')
    .select('id,plan_tier,stripe_customer_id,stripe_subscription_id,stripe_subscription_status,enrichment_credits_used,enrichment_credits_limit,billing_cycle_start')
    .eq('id', tu?.tenant_id ?? '')
    .maybeSingle()) as unknown as { data: TenantRow | null }

  if (!tenant) return <div className="text-gray-500 text-sm">Tenant not found.</div>

  const isOwner = tu?.role === 'owner'
  const creditsUsed = tenant.enrichment_credits_used ?? 0
  const creditsLimit = tenant.enrichment_credits_limit ?? PLAN_ENRICHMENT_LIMITS[tenant.plan_tier] ?? null
  const cycleStart = tenant.billing_cycle_start
    ? new Date(tenant.billing_cycle_start).toLocaleDateString('en-GB', { day: 'numeric', month: 'long' })
    : null

  return (
    <div className="max-w-3xl">
      <div className="mb-6">
        <h1 className="text-2xl font-bold text-gray-900">Billing</h1>
        <p className="mt-1 text-sm text-gray-500">Manage your subscription and usage.</p>
      </div>

      {/* Current plan */}
      <div className="bg-white rounded-xl border border-gray-200 p-6 mb-4">
        <h2 className="text-sm font-semibold text-gray-700 mb-4">Current Plan</h2>
        <div className="flex items-center justify-between">
          <div>
            <div className="text-2xl font-bold text-gray-900">{PLAN_LABELS[tenant.plan_tier] ?? tenant.plan_tier}</div>
            {tenant.stripe_subscription_status ? (
              <span className={`mt-1 inline-flex items-center px-2 py-0.5 rounded text-xs font-medium ${
                tenant.stripe_subscription_status === 'active' ? 'bg-green-100 text-green-700' :
                tenant.stripe_subscription_status === 'trialing' ? 'bg-blue-100 text-blue-700' :
                tenant.stripe_subscription_status === 'past_due' ? 'bg-red-100 text-red-700' :
                'bg-gray-100 text-gray-600'
              }`}>
                {tenant.stripe_subscription_status === 'active' ? 'Active' :
                 tenant.stripe_subscription_status === 'trialing' ? 'Trial' :
                 tenant.stripe_subscription_status === 'past_due' ? 'Payment past due' :
                 tenant.stripe_subscription_status === 'canceled' ? 'Canceled' :
                 tenant.stripe_subscription_status}
              </span>
            ) : (
              <span className="mt-1 inline-flex items-center px-2 py-0.5 rounded text-xs font-medium bg-yellow-100 text-yellow-700">
                No active subscription
              </span>
            )}
          </div>
          <BillingClient
            hasStripeCustomer={!!tenant.stripe_customer_id}
            isOwner={isOwner}
          />
        </div>
      </div>

      {/* Enrichment usage */}
      <div className="bg-white rounded-xl border border-gray-200 p-6 mb-4">
        <h2 className="text-sm font-semibold text-gray-700 mb-4">Enrichment Usage This Month</h2>
        {cycleStart && (
          <p className="text-xs text-gray-400 mb-3">Billing cycle started {cycleStart}</p>
        )}
        <div className="flex items-end justify-between mb-2">
          <span className="text-3xl font-bold text-gray-900">{creditsUsed.toLocaleString()}</span>
          <span className="text-sm text-gray-500">
            {creditsLimit !== null ? `of ${creditsLimit.toLocaleString()} enrichments` : 'Unlimited'}
          </span>
        </div>
        {creditsLimit !== null && (
          <>
            <div className="w-full bg-gray-100 rounded-full h-2">
              <div
                className={`h-2 rounded-full transition-all ${
                  creditsUsed / creditsLimit > 0.8 ? 'bg-red-500' : 'bg-brand-600'
                }`}
                style={{ width: `${Math.min(100, Math.round((creditsUsed / creditsLimit) * 100))}%` }}
              />
            </div>
            <p className="text-xs text-gray-400 mt-1">
              {Math.round((creditsUsed / creditsLimit) * 100)}% used
              {creditsUsed / creditsLimit > 0.8 && (
                <span className="ml-2 text-red-600 font-medium">Approaching limit</span>
              )}
            </p>
          </>
        )}
      </div>

    </div>
  )
}
