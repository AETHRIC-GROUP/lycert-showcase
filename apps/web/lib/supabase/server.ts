import { createServerClient, type CookieOptions } from '@supabase/ssr'
import { cookies } from 'next/headers'
import type { Database } from '@/lib/database.types'

export async function createClient() {
  const cookieStore = cookies()

  // Standard cookie-based client — used to read the session.
  const base = createServerClient<Database>(
    process.env.NEXT_PUBLIC_LYCERT_SUPABASE_URL!,
    process.env.NEXT_PUBLIC_LYCERT_SUPABASE_ANON_KEY!,
    {
      cookies: {
        getAll() {
          return cookieStore.getAll()
        },
        setAll(cookiesToSet: { name: string; value: string; options?: CookieOptions }[]) {
          try {
            cookiesToSet.forEach(({ name, value, options }) =>
              cookieStore.set(name, value, options),
            )
          } catch {
            // Server Component context — cookies().set() throws here, which is expected.
          }
        },
      },
    },
  )

  // Explicitly extract the access token and forward it in the Authorization header.
  // @supabase/ssr does not always propagate the JWT to PostgREST in Next.js 14
  // server actions / server components, causing 401 on REST calls even when
  // auth.getUser() succeeds. Passing it explicitly is the reliable fix.
  const { data: { session } } = await base.auth.getSession()

  if (!session?.access_token) return base

  return createServerClient<Database>(
    process.env.NEXT_PUBLIC_LYCERT_SUPABASE_URL!,
    process.env.NEXT_PUBLIC_LYCERT_SUPABASE_ANON_KEY!,
    {
      global: {
        headers: { Authorization: `Bearer ${session.access_token}` },
      },
      cookies: {
        getAll() {
          return cookieStore.getAll()
        },
        setAll(cookiesToSet: { name: string; value: string; options?: CookieOptions }[]) {
          try {
            cookiesToSet.forEach(({ name, value, options }) =>
              cookieStore.set(name, value, options),
            )
          } catch {}
        },
      },
    },
  )
}
