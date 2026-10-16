/**
 * Pure backfill mapping (Bridge Part 6.5 inbound fields + Part 6.6 initial backfill). Segment discovery
 * (M1: property mode only) stores the EDU-segment filter; inbound field mapping says which HubSpot
 * property feeds which Lycert field. Both are config, not hardcoded — this module is deps-free so it's
 * testable without a HubSpot or Supabase connection.
 */

/** Default inbound mapping (email required; the rest are Bridge 6.5's named optional fields for M1). */
export const DEFAULT_INBOUND_MAPPING: Record<string, string> = {
  email: 'email',
  first_name: 'firstname',
  last_name: 'lastname',
  stated_graduation_date: 'lycert_estimated_graduation_date', // may be re-pointed to a client-owned property
  institution_name: 'company',
  account_country: 'country',
}

export interface InboundMapping { [lycertField: string]: string }

export interface HubspotContactRaw { id: string; properties: Record<string, string | null> }

export interface MappedSubscriberFields {
  crmObjectId: string
  email: string | null
  name: string | null
  statedGraduationDate: string | null
  institutionName: string | null
  accountCountry: string | null
}

/** Maps one HubSpot contact's raw properties into Lycert's subscriber shape, per the stored mapping. */
export function mapContactToSubscriber(contact: HubspotContactRaw, mapping: InboundMapping): MappedSubscriberFields {
  const get = (lycertField: string): string | null => {
    const crmProp = mapping[lycertField]
    if (!crmProp) return null
    const v = contact.properties[crmProp]
    return v === undefined || v === '' ? null : v
  }
  const first = get('first_name')
  const last = get('last_name')
  const name = [first, last].filter(Boolean).join(' ').trim() || null
  return {
    crmObjectId: contact.id,
    email: get('email'),
    name,
    statedGraduationDate: normalizeHubspotDate(get('stated_graduation_date')),
    institutionName: get('institution_name'),
    accountCountry: get('account_country'),
  }
}

/** HubSpot `date` properties come back as midnight-UTC ISO datetimes or YYYY-MM-DD; normalize to the latter. */
function normalizeHubspotDate(raw: string | null): string | null {
  if (!raw) return null
  const d = new Date(raw)
  if (Number.isNaN(d.getTime())) return null
  return d.toISOString().slice(0, 10)
}

/** Filters out contacts with no usable email — a subscriber row requires one (UNIQUE(tenant_id, email)). */
export function filterBackfillable(rows: MappedSubscriberFields[]): MappedSubscriberFields[] {
  return rows.filter(r => !!r.email)
}
