import { NextRequest, NextResponse } from 'next/server'
import Stripe from 'stripe'
import { createClient } from '@/lib/supabase/server'

export const maxDuration = 30

export async function POST(req: NextRequest) {
  const stripeKey = process.env.LYCERT_STRIPE_SECRET_KEY
  if (!stripeKey) {
    return NextResponse.json({ error: 'Billing not configured' }, { status: 503 })
  }

  const supabase = await createClient()
  const { data: { user } } = await supabase.auth.getUser()
  if (!user) return NextResponse.json({ error: 'Not authenticated' }, { status: 401 })

  const { data: tu } = (await supabase
    .from('tenant_users')
    .select('tenant_id')
    .eq('user_id', user.id)
    .maybeSingle()) as unknown as { data: { tenant_id: string } | null }

  if (!tu) return NextResponse.json({ error: 'No tenant account' }, { status: 403 })

  const { data: tenant } = (await supabase
    .from('tenants')
    .select('id,stripe_customer_id')
    .eq('id', tu.tenant_id)
    .maybeSingle()) as unknown as { data: { id: string; stripe_customer_id: string | null } | null }

  if (!tenant?.stripe_customer_id) {
    return NextResponse.json({ error: 'No billing account set up yet' }, { status: 400 })
  }

  const stripe = new Stripe(stripeKey, { apiVersion: '2025-02-24.acacia' as const })
  const origin = req.headers.get('origin') ?? 'https://lycert.com'

  const session = await stripe.billingPortal.sessions.create({
    customer: tenant.stripe_customer_id,
    return_url: `${origin}/dashboard/settings/billing`,
  })

  return NextResponse.json({ url: session.url })
}
