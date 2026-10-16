import { describe, it, expect } from 'vitest'
import { mapContactToSubscriber, filterBackfillable, DEFAULT_INBOUND_MAPPING, type HubspotContactRaw } from './backfill'

describe('mapContactToSubscriber', () => {
  it('maps a fully-populated contact using the default inbound mapping', () => {
    const contact: HubspotContactRaw = {
      id: '123',
      properties: {
        email: 'jane@example.edu', firstname: 'Jane', lastname: 'Doe',
        lycert_estimated_graduation_date: '2027-05-15', company: 'Example University', country: 'US',
      },
    }
    const mapped = mapContactToSubscriber(contact, DEFAULT_INBOUND_MAPPING)
    expect(mapped).toEqual({
      crmObjectId: '123', email: 'jane@example.edu', name: 'Jane Doe',
      statedGraduationDate: '2027-05-15', institutionName: 'Example University', accountCountry: 'US',
    })
  })

  it('normalizes a HubSpot midnight-UTC datetime date property to YYYY-MM-DD', () => {
    const contact: HubspotContactRaw = { id: '1', properties: { lycert_estimated_graduation_date: '2027-05-15T00:00:00.000Z' } }
    const mapped = mapContactToSubscriber(contact, DEFAULT_INBOUND_MAPPING)
    expect(mapped.statedGraduationDate).toBe('2027-05-15')
  })

  it('treats missing/empty properties as null, never throws', () => {
    const contact: HubspotContactRaw = { id: '1', properties: {} }
    const mapped = mapContactToSubscriber(contact, DEFAULT_INBOUND_MAPPING)
    expect(mapped).toEqual({
      crmObjectId: '1', email: null, name: null, statedGraduationDate: null, institutionName: null, accountCountry: null,
    })
  })

  it('name is null (not "") when both first and last name are absent', () => {
    const contact: HubspotContactRaw = { id: '1', properties: { email: 'x@y.com' } }
    expect(mapContactToSubscriber(contact, DEFAULT_INBOUND_MAPPING).name).toBeNull()
  })

  it('an unmapped lycert field (empty mapping) never crashes and returns all nulls', () => {
    const contact: HubspotContactRaw = { id: '1', properties: { email: 'x@y.com' } }
    expect(mapContactToSubscriber(contact, {}).email).toBeNull()
  })
})

describe('filterBackfillable', () => {
  it('drops rows with no email (subscribers requires one)', () => {
    const rows = [
      { crmObjectId: '1', email: 'a@b.com', name: null, statedGraduationDate: null, institutionName: null, accountCountry: null },
      { crmObjectId: '2', email: null, name: null, statedGraduationDate: null, institutionName: null, accountCountry: null },
    ]
    expect(filterBackfillable(rows).map(r => r.crmObjectId)).toEqual(['1'])
  })
})
