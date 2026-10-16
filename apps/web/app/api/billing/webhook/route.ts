import { NextRequest, NextResponse } from 'next/server'
import Stripe from 'stripe'
import { createClient } from '@supabase/supabase-js'

export const maxDuration = 60

// Enrichment limits by plan tier (monthly)
const PLAN_LIMITS: Record<string, number | null> = {
  starter: 500,
  growth: 2000,
  pro: 10000,
  enterprise: null, // unlimited
}

// Map Stripe Price IDs to Lycert plan tiers (set via env vars after Stripe setup)
function planTierFromPriceId(priceId: string): string {
  const map: Record<string, string> = {
    [process.env.LYCERT_STRIPE_PRICE_STARTER_MONTHLY ?? '__starter__']:    'starter',
    [process.env.LYCERT_STRIPE_PRICE_GROWTH_MONTHLY ?? '__growth__']:      'growth',
    [process.env.LYCERT_STRIPE_PRICE_PRO_MONTHLY ?? '__pro__']:            'pro',
    [process.env.LYCERT_STRIPE_PRICE_ENTERPRISE_MONTHLY ?? '__enterprise__']: 'enterprise',
  }
  return map[priceId] ?? 'starter'
}

function serviceClient() {
  return createClient(
    process.env.NEXT_PUBLIC_LYCERT_SUPABASE_URL!,
    process.env.LYCERT_SUPABASE_SERVICE_ROLE_KEY!,
  )
}

export async function POST(req: NextRequest) {
  const stripeKey = process.env.LYCERT_STRIPE_SECRET_KEY
  const webhookSecret = process.env.LYCERT_STRIPE_WEBHOOK_SECRET

  if (!stripeKey || !webhookSecret) {
    console.error('billing/webhook: LYCERT_STRIPE_SECRET_KEY or LYCERT_STRIPE_WEBHOOK_SECRET not set')
    return NextResponse.json({ error: 'Billing not configured' }, { status: 503 })
  }

  const stripe = new Stripe(stripeKey, { apiVersion: '2025-02-24.acacia' as const })
  const body = await req.text()
  const sig = req.headers.get('stripe-signature')

  if (!sig) return NextResponse.json({ error: 'Missing stripe-signature' }, { status: 400 })

  let event: Stripe.Event
  try {
    event = stripe.webhooks.constructEvent(body, sig, webhookSecret)
  } catch (err) {
    console.error('billing/webhook: signature verification failed', err)
    return NextResponse.json({ error: 'Invalid signature' }, { status: 400 })
  }

  const db = serviceClient()

  switch (event.type) {
    case 'customer.subscription.created':
    case 'customer.subscription.updated': {
      const sub = event.data.object as Stripe.Subscription
      const priceId = sub.items.data[0]?.price.id ?? ''
      const tier = planTierFromPriceId(priceId)

      await db
        .from('tenants')
        .update({
          stripe_subscription_id: sub.id,
          stripe_subscription_status: sub.status,
          plan_tier: tier,
          enrichment_credits_limit: PLAN_LIMITS[tier] ?? null,
        })
        .eq('stripe_customer_id', sub.customer as string)
      break
    }

    case 'customer.subscription.deleted': {
      const sub = event.data.object as Stripe.Subscription
      await db
        .from('tenants')
        .update({
          stripe_subscription_status: 'canceled',
          plan_tier: 'starter',
        })
        .eq('stripe_customer_id', sub.customer as string)
      break
    }

    case 'invoice.paid': {
      const inv = event.data.object as Stripe.Invoice
      // Reset monthly enrichment usage at the start of each billing cycle
      await db
        .from('tenants')
        .update({
          enrichment_credits_used: 0,
          billing_cycle_start: new Date().toISOString(),
          stripe_subscription_status: 'active',
        })
        .eq('stripe_customer_id', inv.customer as string)
      break
    }

    case 'invoice.payment_failed': {
      const inv = event.data.object as Stripe.Invoice
      await db
        .from('tenants')
        .update({ stripe_subscription_status: 'past_due' })
        .eq('stripe_customer_id', inv.customer as string)
      break
    }

    default:
      // Unhandled event — acknowledged but ignored
      break
  }

  return NextResponse.json({ received: true })
}
