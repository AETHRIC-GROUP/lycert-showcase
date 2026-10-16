/** Tier B signals — user-submitted data. Port of scoring/signals/tier_b.py. */
import {
  ACADEMIC_INDICATORS,
  COUNTRY_ALIASES,
  PERSONAL_DOMAINS,
  type ScoringConfig,
  type Signal,
  type SubscriberRecord,
} from '../models'
import { roundHalfEven } from '../util'

export function scoreB1(record: SubscriberRecord, config: ScoringConfig): Signal {
  const email = record.email.trim().toLowerCase()
  if (!email || !email.includes('@')) return [0, '', '']
  const domain = email.split('@').at(-1) as string
  if (PERSONAL_DOMAINS.has(domain)) {
    return [config.signalB1PersonalWeight, 'B1_personal_email', `Uses personal email domain (${domain})`]
  }
  // Cross-link: a mailbox on the verified institution domain — or any subdomain of it (e.g.
  // edu.cegepgarneau.ca under cegepgarneau.ca) — is academic, even when the domain carries no
  // .edu/.ac TLD marker. Guards against flagging genuine students as professionals.
  const verified = (record.institutionDomainVerified ?? '').trim().toLowerCase().replace(/^@/, '').replace(/^\*?\./, '')
  if (verified && (domain === verified || domain.endsWith('.' + verified))) {
    return [config.signalB1AcademicExculpatory, 'B1_academic_email_exculpatory', `Email domain matches verified institution domain (${domain})`]
  }
  for (const indicator of ACADEMIC_INDICATORS) {
    if (domain.includes(indicator)) {
      return [config.signalB1AcademicExculpatory, 'B1_academic_email_exculpatory', `Email domain suggests academic affiliation (${domain})`]
    }
  }
  return [0, '', '']
}

export function scoreB2(record: SubscriberRecord, config: ScoringConfig): Signal {
  const inst = record.institutionName.trim()
  const account = record.accountName.trim()
  const w = config.signalB2Weight
  if (!inst) return [roundHalfEven((w * 15) / 20), 'B2_institution_missing', 'Institution name is blank or missing']
  if (account && inst.toLowerCase() === account.toLowerCase()) {
    return [w, 'B2_institution_equals_account', 'Institution name is identical to account name']
  }
  if (inst.length < 4) return [roundHalfEven((w * 15) / 20), 'B2_institution_too_short', `Institution name is suspiciously short ('${inst}')`]
  return [0, '', '']
}

function normalizeCountry(name: string): string {
  const s = name.trim().toLowerCase()
  return COUNTRY_ALIASES[s] ?? s
}

function titleCase(s: string): string {
  return s.replace(/\b\w/g, c => c.toUpperCase())
}

export function scoreB3(record: SubscriberRecord, config: ScoringConfig): Signal {
  // Country source: prefer the PDL Location-Cleaner normalised field when present (more robust
  // than a fixed alias list — e.g. resolves "Deutschland" → Germany); otherwise fall back to the
  // raw location's trailing segment + COUNTRY_ALIASES, matching the CEDS behaviour exactly.
  const extractCountry = (loc: string): string => {
    const parts = loc.split(',').map(p => p.trim())
    return parts.length ? normalizeCountry(parts[parts.length - 1]) : ''
  }
  const countryOf = (normalized: string | undefined, rawLoc: string): string => {
    const n = (normalized ?? '').trim()
    if (n) return normalizeCountry(n)
    const raw = rawLoc.trim()
    return raw ? extractCountry(raw) : ''
  }
  const cInst = countryOf(record.institutionCountryNormalized, record.institutionLocation)
  const cAccount = countryOf(record.accountCountryNormalized, record.accountCountry)
  if (!cInst || !cAccount) return [0, '', '']
  if (cInst !== cAccount) {
    return [config.signalB3Weight, 'B3_country_mismatch', `Institution country (${titleCase(cInst)}) differs from account country (${titleCase(cAccount)})`]
  }
  return [0, '', '']
}
