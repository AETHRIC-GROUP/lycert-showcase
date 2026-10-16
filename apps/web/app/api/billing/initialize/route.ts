import { NextRequest, NextResponse } from 'next/server'
import Stripe from 'stripe'
import { createClient } from '@/lib/supabase/server'
import { createClient as createServiceClient } from '@supabase/supabase-js'

export const maxDuration = 30

export async function POST(_req: NextRequest) {
  const stripeKey = process.env.LYCERT_STRIPE_SECRET_KEY
  if (!stripeKey) {
    return NextResponse.json(
      { error: 'LYCERT_STRIPE_SECRET_KEY is not set. Check Vercel Project Settings → Environment Variables.' },
      { status: 503 },
    )
  }

  const supabase = await createClient()
  const { data: { user } } = await supabase.auth.getUser()
  if (!user) return NextResponse.json({ error: 'Not authenticated' }, { status: 401 })

  const { data: tu } = (await supabase
    .from('tenant_users')
    .select('tenant_id, role')
    .eq('user_id', user.id)
    .maybeSingle()) as unknown as { data: { tenant_id: string; role: string } | null }

  if (!tu) return NextResponse.json({ error: 'No tenant account' }, { status: 403 })
  if (tu.role !== 'owner') return NextResponse.json({ error: 'Owner role required' }, { status: 403 })

  const { data: tenant } = (await supabase
    .from('tenants')
    .select('id, name, stripe_customer_id')
    .eq('id', tu.tenant_id)
    .maybeSingle()) as unknown as { data: { id: string; name: string; stripe_customer_id: string | null } | null }

  if (!tenant) return NextResponse.json({ error: 'Tenant not found' }, { status: 404 })
  if (tenant.stripe_customer_id) {
    return NextResponse.json({ customer_id: tenant.stripe_customer_id })
  }

  const stripe = new Stripe(stripeKey, { apiVersion: '2025-02-24.acacia' as const })
  const customer = await stripe.customers.create({
    email: user.email,
    name: tenant.name,
    metadata: { lycert_tenant_id: tenant.id },
  })

  const serviceClient = createServiceClient(
    process.env.NEXT_PUBLIC_LYCERT_SUPABASE_URL!,
    process.env.LYCERT_SUPABASE_SERVICE_ROLE_KEY!,
  )
  const { error } = await serviceClient
    .from('tenants')
    .update({ stripe_customer_id: customer.id })
    .eq('id', tenant.id)

  if (error) {
    return NextResponse.json({ error: 'Failed to save billing account' }, { status: 500 })
  }

  return NextResponse.json({ customer_id: customer.id })
}
