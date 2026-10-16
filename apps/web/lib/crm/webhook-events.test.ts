import { describe, it, expect } from 'vitest'
import { classifyWebhookEvent, parseWebhookBody } from './webhook-events'

describe('classifyWebhookEvent', () => {
  it('maps object.creation and contact.propertyChange to upsert', () => {
    expect(classifyWebhookEvent({ objectId: 1, portalId: 9, eventId: 1, subscriptionType: 'object.creation', occurredAt: 0 }))
      .toEqual({ type: 'upsert', crmObjectId: '1' })
    expect(classifyWebhookEvent({ objectId: 2, portalId: 9, eventId: 1, subscriptionType: 'contact.propertyChange', occurredAt: 0, propertyName: 'email' }))
      .toEqual({ type: 'upsert', crmObjectId: '2' })
  })

  it('maps contact.deletion to delete', () => {
    expect(classifyWebhookEvent({ objectId: 3, portalId: 9, eventId: 1, subscriptionType: 'contact.deletion', occurredAt: 0 }))
      .toEqual({ type: 'delete', crmObjectId: '3' })
  })

  it('maps contact.merge to merge, carrying primary + merged ids', () => {
    expect(classifyWebhookEvent({
      objectId: 4, portalId: 9, eventId: 1, subscriptionType: 'contact.merge', occurredAt: 0,
      primaryObjectId: 10, mergedObjectIds: [4, 5],
    })).toEqual({ type: 'merge', primaryObjectId: '10', mergedObjectIds: ['4', '5'] })
  })

  it('returns null for merge events missing primaryObjectId — never guesses', () => {
    expect(classifyWebhookEvent({ objectId: 4, portalId: 9, eventId: 1, subscriptionType: 'contact.merge', occurredAt: 0 })).toBeNull()
  })

  it('returns null for an unrecognized subscriptionType rather than throwing', () => {
    expect(classifyWebhookEvent({ objectId: 1, portalId: 9, eventId: 1, subscriptionType: 'something.new', occurredAt: 0 })).toBeNull()
  })
})

describe('parseWebhookBody', () => {
  it('parses a real-shaped batch into portal-scoped actions', () => {
    const body = JSON.stringify([
      { objectId: 1, portalId: 12345678, eventId: 1, subscriptionType: 'object.creation', occurredAt: 0 },
      { objectId: 2, portalId: 12345678, eventId: 2, subscriptionType: 'contact.deletion', occurredAt: 0 },
    ])
    expect(parseWebhookBody(body)).toEqual([
      { portalId: '12345678', action: { type: 'upsert', crmObjectId: '1' } },
      { portalId: '12345678', action: { type: 'delete', crmObjectId: '2' } },
    ])
  })

  it('skips malformed entries in a mixed batch rather than failing the whole batch', () => {
    const body = JSON.stringify([
      { objectId: 1, portalId: 9, eventId: 1, subscriptionType: 'object.creation', occurredAt: 0 },
      { not: 'an event' },
      null,
      { objectId: 'not-a-number', portalId: 9, subscriptionType: 'object.creation' },
    ])
    expect(parseWebhookBody(body)).toEqual([{ portalId: '9', action: { type: 'upsert', crmObjectId: '1' } }])
  })

  it('returns an empty array for invalid JSON or a non-array body, never throws', () => {
    expect(parseWebhookBody('not json')).toEqual([])
    expect(parseWebhookBody('{}')).toEqual([])
    expect(parseWebhookBody('')).toEqual([])
  })
})
