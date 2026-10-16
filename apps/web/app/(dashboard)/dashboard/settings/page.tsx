import { createClient } from '@/lib/supabase/server'
import { redirect } from 'next/navigation'
import { LifecycleCard } from '@/components/lifecycle-card'

export default async function SettingsPage() {
  const supabase = await createClient()
  const { data: { user } } = await supabase.auth.getUser()
  if (!user) redirect('/login')

  const { data: tu } = (await supabase
    .from('tenant_users')
    .select('role')
    .eq('user_id', user.id)
    .maybeSingle()) as unknown as { data: { role: string } | null }

  if (!tu || !['owner', 'admin'].includes(tu.role)) {
    redirect('/dashboard')
  }

  return (
    <div className="max-w-3xl">
      <div className="mb-6">
        <h1 className="text-2xl font-bold text-gray-900">Settings</h1>
        <p className="mt-1 text-sm text-gray-500">Admin tools and system configuration.</p>
      </div>

      <LifecycleCard />
    </div>
  )
}
