/**
 * The Lycert HubSpot property group (Bridge Part 6.7) — the full set of 14 contact properties.
 * Bootstrap (Part 6.4) creates ALL of these up front, even though M1 only ever WRITES four of them
 * (see writeback.ts) — so conflict detection runs against the real shape from day one, not a subset.
 *
 * HubSpot enumeration properties require an explicit `options` list at creation time; the Bridge doc's
 * Part 6.7 table gives these as prose "Values / meaning" — treated here as the literal option set.
 * `lycert_recommended_offer` is explicitly called out as "tenant-configurable" (not a fixed set); the
 * doc's own example list is used as the seeded default.
 */

export const LYCERT_PROPERTY_GROUP = { name: 'lycert', label: 'Lycert' } as const

export type HubspotPropertyType = 'string' | 'number' | 'bool' | 'enumeration' | 'date' | 'datetime'
export type HubspotFieldType = 'text' | 'textarea' | 'number' | 'select' | 'date' | 'checkbox'

export interface LycertPropertyDef {
  name: string
  label: string
  type: HubspotPropertyType
  fieldType: HubspotFieldType
  options?: Array<{ label: string; value: string }>
}

function opts(values: string[]): Array<{ label: string; value: string }> {
  return values.map(v => ({ label: v, value: v }))
}

export const LYCERT_PROPERTIES: LycertPropertyDef[] = [
  {
    name: 'lycert_education_status', label: 'Lycert Education Status', type: 'enumeration', fieldType: 'select',
    options: opts(['enrolled_confirmed', 'likely_enrolled', 'likely_graduated', 'graduation_confirmed_by_student', 'unknown']),
  },
  { name: 'lycert_estimated_graduation_date', label: 'Lycert Estimated Graduation Date', type: 'date', fieldType: 'date' },
  {
    name: 'lycert_status_confidence', label: 'Lycert Status Confidence', type: 'enumeration', fieldType: 'select',
    options: opts(['provider_confirmed', 'high', 'medium', 'low']),
  },
  {
    name: 'lycert_status_source', label: 'Lycert Status Source', type: 'enumeration', fieldType: 'select',
    options: opts(['verification_provider', 'signup_declaration', 'enrichment', 'combined']),
  },
  {
    name: 'lycert_lifecycle_stage', label: 'Lycert Lifecycle Stage', type: 'enumeration', fieldType: 'select',
    options: opts(['active_student', 'approaching_graduation', 'recent_graduate', 'post_graduation', 'converted']),
  },
  { name: 'lycert_conversion_score', label: 'Lycert Conversion Score', type: 'number', fieldType: 'number' },
  {
    name: 'lycert_recommended_offer', label: 'Lycert Recommended Offer', type: 'enumeration', fieldType: 'select',
    options: opts(['graduate_discount', 'startup_plan', 'team_plan', 'none']),
  },
  {
    name: 'lycert_eligibility_review', label: 'Lycert Eligibility Review', type: 'enumeration', fieldType: 'select',
    options: opts(['none', 'review_recommended', 'under_review', 'cleared']),
  },
  {
    name: 'lycert_reverification_status', label: 'Lycert Reverification Status', type: 'enumeration', fieldType: 'select',
    options: opts(['not_required', 'due', 'link_issued', 'in_progress', 'reconfirmed', 'not_completed']),
  },
  { name: 'lycert_reverification_due_date', label: 'Lycert Reverification Due Date', type: 'date', fieldType: 'date' },
  { name: 'lycert_reverification_url', label: 'Lycert Reverification URL', type: 'string', fieldType: 'text' },
  { name: 'lycert_last_verified_date', label: 'Lycert Last Verified Date', type: 'date', fieldType: 'date' },
  { name: 'lycert_personalization_line', label: 'Lycert Personalization Line', type: 'string', fieldType: 'textarea' },
  { name: 'lycert_last_synced', label: 'Lycert Last Synced', type: 'datetime', fieldType: 'date' },
]

/** M1 only ever writes these four (Bridge Part 12 M1). The rest exist but stay empty until M2+/M3. */
export const M1_WRITEBACK_FIELDS = [
  'lycert_estimated_graduation_date',
  'lycert_lifecycle_stage',
  'lycert_education_status',
  'lycert_last_synced',
] as const

export interface ExistingProperty { name: string; type: string }

export interface BootstrapPlan {
  toCreate: LycertPropertyDef[]
  conflicts: Array<{ name: string; expectedType: string; actualType: string }>
  ok: string[]
}

/**
 * Pure planning step (Part 6.4): given what already exists in the portal, decide what to create vs
 * flag as a conflict. Never overwrites an existing property of a different type. Idempotent — a
 * second run against the result of the first produces an empty `toCreate`.
 */
export function planPropertyBootstrap(existing: ExistingProperty[]): BootstrapPlan {
  const byName = new Map(existing.map(p => [p.name, p.type]))
  const toCreate: LycertPropertyDef[] = []
  const conflicts: BootstrapPlan['conflicts'] = []
  const ok: string[] = []
  for (const def of LYCERT_PROPERTIES) {
    const actual = byName.get(def.name)
    if (actual === undefined) {
      toCreate.push(def)
    } else if (actual !== def.type) {
      conflicts.push({ name: def.name, expectedType: def.type, actualType: actual })
    } else {
      ok.push(def.name)
    }
  }
  return { toCreate, conflicts, ok }
}
