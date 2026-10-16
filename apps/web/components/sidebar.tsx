'use client'

import Link from 'next/link'
import { usePathname, useRouter } from 'next/navigation'
import { createClient } from '@/lib/supabase/client'

type Role = 'owner' | 'admin' | 'manager' | 'reviewer' | 'viewer'

interface SidebarProps {
  userEmail: string
  role: Role
}

const NAV_ITEMS = [
  { label: 'Dashboard',   href: '/dashboard',                    roles: ['owner','admin','manager','reviewer','viewer'], exact: true  },
  { label: 'Subscribers', href: '/dashboard/subscribers',        roles: ['owner','admin','manager','reviewer','viewer'], exact: false },
  { label: 'Cases',       href: '/dashboard/cases',              roles: ['owner','admin','manager','reviewer'],          exact: false },
  { label: 'Document Review', href: '/dashboard/verification/documents', roles: ['owner','admin'],                       exact: false },
  { label: 'Billing',     href: '/dashboard/settings/billing',   roles: ['owner'],                                      exact: false },
  { label: 'Audit Log',   href: '/dashboard/settings/audit-log', roles: ['owner','admin'],                              exact: false },
  { label: 'Integrations', href: '/dashboard/settings/integrations', roles: ['owner','admin'],                           exact: false },
  { label: 'Settings',    href: '/dashboard/settings',           roles: ['owner','admin'],                              exact: true  },
] as const

export function Sidebar({ userEmail, role }: SidebarProps) {
  const pathname = usePathname()
  const router = useRouter()

  async function handleSignOut() {
    const supabase = createClient()
    await supabase.auth.signOut()
    router.push('/login')
    router.refresh()
  }

  const visibleItems = NAV_ITEMS.filter(item =>
    (item.roles as readonly string[]).includes(role),
  )

  return (
    <aside className="w-56 flex-shrink-0 bg-gray-900 text-white flex flex-col h-screen sticky top-0">
      {/* Logo */}
      <div className="px-5 py-5 border-b border-gray-700">
        <span className="text-lg font-bold tracking-tight text-white">Lycert</span>
      </div>

      {/* Nav */}
      <nav className="flex-1 px-3 py-4 space-y-1 overflow-y-auto">
        {visibleItems.map(item => {
          const isActive = item.exact
            ? pathname === item.href
            : pathname.startsWith(item.href)
          return (
            <Link
              key={item.href}
              href={item.href}
              className={`flex items-center px-3 py-2 rounded-lg text-sm font-medium transition-colors ${
                isActive
                  ? 'bg-brand-600 text-white'
                  : 'text-gray-300 hover:bg-gray-800 hover:text-white'
              }`}
            >
              {item.label}
            </Link>
          )
        })}
      </nav>

      {/* User footer */}
      <div className="px-4 py-4 border-t border-gray-700 space-y-2">
        <p className="text-xs text-gray-400 truncate">{userEmail}</p>
        <span className="inline-flex items-center px-2 py-0.5 rounded text-xs font-medium bg-gray-700 text-gray-300 capitalize">
          {role}
        </span>
        <button
          onClick={handleSignOut}
          className="mt-2 w-full text-left text-xs text-gray-400 hover:text-white transition-colors"
        >
          Sign out
        </button>
      </div>
    </aside>
  )
}
