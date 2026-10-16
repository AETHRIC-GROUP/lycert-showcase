import { createServerClient, type CookieOptions } from '@supabase/ssr'
import { NextRequest, NextResponse } from 'next/server'

function getTenantIdFromJwt(accessToken: string | undefined): string | null {
  if (!accessToken) return null
  try {
    const payload = JSON.parse(atob(accessToken.split('.')[1]))
    return payload.tenant_id ?? null
  } catch {
    return null
  }
}

export async function middleware(request: NextRequest) {
  let supabaseResponse = NextResponse.next({ request })

  const supabase = createServerClient(
    process.env.NEXT_PUBLIC_LYCERT_SUPABASE_URL!,
    process.env.NEXT_PUBLIC_LYCERT_SUPABASE_ANON_KEY!,
    {
      cookies: {
        getAll() {
          return request.cookies.getAll()
        },
        setAll(cookiesToSet: { name: string; value: string; options?: CookieOptions }[]) {
          cookiesToSet.forEach(({ name, value }) => request.cookies.set(name, value))
          supabaseResponse = NextResponse.next({ request })
          cookiesToSet.forEach(({ name, value, options }) =>
            supabaseResponse.cookies.set(name, value, options ?? {}),
          )
        },
      },
    },
  )

  // Refresh session if expired — do not remove or move this call.
  const { data: { user } } = await supabase.auth.getUser()
  const { data: { session } } = await supabase.auth.getSession()
  const tenantId = getTenantIdFromJwt(session?.access_token)

  const { pathname } = request.nextUrl

  // Unauthenticated → /login
  if (!user && (pathname.startsWith('/dashboard') || pathname === '/onboarding')) {
    const url = request.nextUrl.clone()
    url.pathname = '/login'
    return NextResponse.redirect(url)
  }

  // Authenticated with tenant, on onboarding/auth pages → /dashboard
  if (user && tenantId && (
    pathname === '/' ||
    pathname === '/login' ||
    pathname === '/forgot-password' ||
    pathname === '/signup' ||
    pathname === '/onboarding'
  )) {
    const url = request.nextUrl.clone()
    url.pathname = '/dashboard'
    return NextResponse.redirect(url)
  }

  // Authenticated without tenant on /dashboard → /onboarding
  if (user && !tenantId && pathname.startsWith('/dashboard')) {
    const url = request.nextUrl.clone()
    url.pathname = '/onboarding'
    return NextResponse.redirect(url)
  }

  // Authenticated without tenant on / or auth pages (not signup/onboarding) → /onboarding
  if (user && !tenantId && (pathname === '/' || pathname === '/login')) {
    const url = request.nextUrl.clone()
    url.pathname = '/onboarding'
    return NextResponse.redirect(url)
  }

  return supabaseResponse
}

export const config = {
  matcher: [
    '/((?!_next/static|_next/image|favicon.ico|.*\\.(?:svg|png|jpg|jpeg|gif|webp)$).*)',
  ],
}
