import { redirect } from 'next/navigation'
import { createClient } from '@/lib/supabase/server'
import { Sidebar } from '@/components/sidebar'
import { DpaBanner } from '@/components/dpa-banner'
import type { Database } from '@/lib/database.types'

type UserRole = Database['public']['Enums']['user_role']

export default async function DashboardLayout({ children }: { children: React.ReactNode }) {
  const supabase = await createClient()

  const { data: authData } = await supabase.auth.getUser()
  const user = authData.user

  if (!user) {
    redirect('/login')
  }

  let role: UserRole = 'viewer'
  let showDpaBanner = true

  type TURow = { role: UserRole; tenant_id: string }
  type TRow = { dpa_signed_at: string | null }

  const { data: tenantUser } = (await supabase
    .from('tenant_users')
    .select('role, tenant_id')
    .eq('user_id', user.id)
    .maybeSingle()) as unknown as { data: TURow | null }

  if (tenantUser) {
    role = tenantUser.role
    const { data: tenant } = (await supabase
      .from('tenants')
      .select('dpa_signed_at')
      .eq('id', tenantUser.tenant_id)
      .maybeSingle()) as unknown as { data: TRow | null }
    showDpaBanner = !tenant?.dpa_signed_at
  }

  return (
    <div className="flex min-h-screen bg-gray-50">
      <Sidebar userEmail={user.email ?? ''} role={role} />
      <div className="flex-1 flex flex-col min-w-0">
        {showDpaBanner && <DpaBanner />}
        <main className="flex-1 p-8 overflow-y-auto">{children}</main>
      </div>
    </div>
  )
}