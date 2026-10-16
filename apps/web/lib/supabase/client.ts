'use client'

import { createBrowserClient } from '@supabase/ssr'
import type { Database } from '@/lib/database.types'

export function createClient() {
  return createBrowserClient<Database>(
    process.env.NEXT_PUBLIC_LYCERT_SUPABASE_URL!,
    process.env.NEXT_PUBLIC_LYCERT_SUPABASE_ANON_KEY!,
  )
}
