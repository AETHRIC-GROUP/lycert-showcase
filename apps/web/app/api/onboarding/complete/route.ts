import { NextRequest, NextResponse } from 'next/server'
import Stripe from 'stripe'
import { createClient } from '@/lib/supabase/server'
import { createClient as createServiceClient } from '@supabase/supabase-js'

export const maxDuration = 30

export async function POST(req: NextRequest) {
  const supabase = await createClient()
  const { data: { user } } = await supabase.auth.getUser()
  if (!user) return NextResponse.json({ error: 'Not authenticated' }, { status: 401 })

  const body = await req.json()
  const { company_name, slug, dpa_signed_by } = body as {
    company_name?: string
    slug?: string
    dpa_signed_by?: string
  }

  if (!company_name?.trim()) return NextResponse.json({ error: 'Company name is required' }, { status: 400 })
  if (!slug?.trim() || !/^[a-z0-9-]+$/.test(slug)) return NextResponse.json({ error: 'Invalid slug' }, { status: 400 })
  if (!dpa_signed_by?.trim()) return NextResponse.json({ error: 'DPA signatory name is required' }, { status: 400 })

  const db = createServiceClient(
    process.env.NEXT_PUBLIC_LYCERT_SUPABASE_URL!,
    process.env.LYCERT_SUPABASE_SERVICE_ROLE_KEY!,
  )

  // Check if user already has a tenant
  const { data: existing } = await db
    .from('tenant_users')
    .select('tenant_id')
    .eq('user_id', user.id)
    .maybeSingle()

  if (existing) return NextResponse.json({ error: 'Account already set up' }, { status: 409 })

  // Check slug uniqueness
  const { data: slugConflict } = await db
    .from('tenants')
    .select('id')
    .eq('slug', slug.trim())
    .maybeSingle()

  if (slugConflict) return NextResponse.json({ error: 'That account slug is already taken. Please choose another.' }, { status: 409 })

  // Create Stripe customer
  let stripeCustomerId: string | null = null
  const stripeKey = process.env.LYCERT_STRIPE_SECRET_KEY
  if (stripeKey) {
    try {
      const stripe = new Stripe(stripeKey, { apiVersion: '2025-02-24.acacia' as const })
      const customer = await stripe.customers.create({
        email: user.email,
        name: company_name.trim(),
        metadata: { lycert_slug: slug.trim() },
      })
      stripeCustomerId = customer.id
    } catch {
      // Non-fatal — billing can be initialised later
    }
  }

  // Create tenant
  const { data: tenant, error: tenantError } = await db
    .from('tenants')
    .insert({
      name: company_name.trim(),
      slug: slug.trim(),
      plan_tier: 'starter',
      stripe_customer_id: stripeCustomerId,
      dpa_signed_at: new Date().toISOString(),
      dpa_signed_by: dpa_signed_by.trim(),
      fcra_review_completed: true,
      onboarding_complete: true,
    })
    .select('id')
    .single()

  if (tenantError || !tenant) {
    return NextResponse.json(
      { error: 'Failed to create account. Please try again.' },
      { status: 500 },
    )
  }

  // Create tenant_user (owner)
  const { error: tuError } = await db.from('tenant_users').insert({
    tenant_id: tenant.id,
    user_id: user.id,
    role: 'owner',
    email: user.email ?? '',
    accepted_at: new Date().toISOString(),
  })

  if (tuError) {
    // Roll back tenant
    await db.from('tenants').delete().eq('id', tenant.id)
    return NextResponse.json({ error: 'Failed to create account. Please try again.' }, { status: 500 })
  }

  // Seed default scoring config
  await db.from('tenant_scoring_config').insert({
    tenant_id: tenant.id,
    grace_period_days: 90,
    vertical_tag: 'generic',
  })

  return NextResponse.json({ tenant_id: tenant.id })
}
