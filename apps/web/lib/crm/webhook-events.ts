/**
 * Pure parsing/classification of HubSpot webhook payloads (Bridge Part 6.6). HubSpot always delivers an
 * array of events in one POST (batches <100, verified 2026-10-12). Each raw event maps to one of three
 * actions the worker understands — the handler route's only job is signature-verify + classify + enqueue
 * ONE message per event; it never processes inline (Bridge 6.6's own rule).
 */

export interface RawHubspotWebhookEvent {
  objectId: number
  portalId: number
  eventId: number
  subscriptionType: string
  occurredAt: number
  propertyName?: string
  propertyValue?: string
  primaryObjectId?: number
  mergedObjectIds?: number[]
}

export type WebhookAction =
  | { type: 'upsert'; crmObjectId: string }
  | { type: 'delete'; crmObjectId: string }
  | { type: 'merge'; primaryObjectId: string; mergedObjectIds: string[] }

/** Returns null for a subscriptionType we don't recognize — never throws on an unexpected payload shape. */
export function classifyWebhookEvent(e: RawHubspotWebhookEvent): WebhookAction | null {
  switch (e.subscriptionType) {
    case 'object.creation':
    case 'contact.propertyChange':
      return { type: 'upsert', crmObjectId: String(e.objectId) }
    case 'contact.deletion':
      return { type: 'delete', crmObjectId: String(e.objectId) }
    case 'contact.merge':
      if (e.primaryObjectId == null) return null
      return {
        type: 'merge',
        primaryObjectId: String(e.primaryObjectId),
        mergedObjectIds: (e.mergedObjectIds ?? []).map(String),
      }
    default:
      return null
  }
}

export interface PortalScopedAction { portalId: string; action: WebhookAction }

/** Parses the raw POST body into a flat list of (portal, action) pairs — the route resolves portalId to
 * a tenant before enqueueing, since the payload has no concept of a Lycert tenant. Skips anything
 * malformed or unrecognized rather than throwing (a batch may contain a mix of event types). */
export function parseWebhookBody(rawBody: string): PortalScopedAction[] {
  let events: unknown
  try {
    events = JSON.parse(rawBody)
  } catch {
    return []
  }
  if (!Array.isArray(events)) return []
  const out: PortalScopedAction[] = []
  for (const e of events) {
    if (!e || typeof e !== 'object') continue
    const raw = e as RawHubspotWebhookEvent
    if (typeof raw.objectId !== 'number' || typeof raw.portalId !== 'number') continue
    const action = classifyWebhookEvent(raw)
    if (action) out.push({ portalId: String(raw.portalId), action })
  }
  return out
}
