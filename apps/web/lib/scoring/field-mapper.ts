/**
 * Field mapper — TypeScript port of apps/api/scoring/field_mapper.py (the parts used by scoring).
 * Parses dates in the same format order as Python strptime, extracts the education end year,
 * and maps a raw design-partner row to a canonical SubscriberRecord. Missing fields are never errors.
 */
import type { SubscriberRecord } from './models'
import { utcDate } from './util'

const NULLISH = new Set(['', 'nan', 'nat', 'none'])

/** Parse a date from various string/numeric formats → UTC-midnight Date, or null. */
export function parseDate(value: unknown): Date | null {
  if (value == null) return null
  if (value instanceof Date) {
    return utcDate(value.getUTCFullYear(), value.getUTCMonth() + 1, value.getUTCDate())
  }
  let s = String(value).trim()
  if (NULLISH.has(s.toLowerCase())) return null
  s = s.split(' ')[0].split('T')[0]

  // Format order mirrors Python: first match wins (preserves m/d vs d/m disambiguation).
  // Day/month groups are \d{1,2} — Python strptime accepts non-zero-padded values
  // (the data has '7.07.26', '2.04.25'); a 2-digit-only regex would null them out.
  const fmts: Array<[RegExp, (m: RegExpMatchArray) => Date | null]> = [
    [/^(\d{4})-(\d{1,2})-(\d{1,2})$/, m => utcDate(+m[1], +m[2], +m[3])],             // %Y-%m-%d
    [/^(\d{1,2})\.(\d{1,2})\.(\d{2})$/, m => utcDate(yy(+m[3]), +m[2], +m[1])],       // %d.%m.%y
    [/^(\d{1,2})\.(\d{1,2})\.(\d{4})$/, m => utcDate(+m[3], +m[2], +m[1])],           // %d.%m.%Y
    [/^(\d{1,2})\/(\d{1,2})\/(\d{4})$/, m => utcDate(+m[3], +m[1], +m[2])],           // %m/%d/%Y
    [/^(\d{1,2})\/(\d{1,2})\/(\d{2})$/, m => utcDate(yy(+m[3]), +m[1], +m[2])],       // %m/%d/%y
    // %d/%m/%Y and %d/%m/%y share the slash shape with the two above; Python tries the
    // m/d variants first, so a string only reaches these if the m/d parse produced an
    // invalid date (e.g. month > 12 in the first slot). Iteration order + null return replicate that.
    [/^(\d{1,2})\/(\d{1,2})\/(\d{4})$/, m => utcDate(+m[3], +m[2], +m[1])],           // %d/%m/%Y
    [/^(\d{1,2})\/(\d{1,2})\/(\d{2})$/, m => utcDate(yy(+m[3]), +m[2], +m[1])],       // %d/%m/%y
    [/^(\d{4})\/(\d{1,2})\/(\d{1,2})$/, m => utcDate(+m[1], +m[2], +m[3])],           // %Y/%m/%d
  ]
  for (const [re, build] of fmts) {
    const m = s.match(re)
    if (m) {
      const d = build(m)
      if (d) return d
    }
  }

  // Excel serial number (days since 1899-12-30).
  const serial = Number(s)
  if (Number.isFinite(serial) && serial > 1000 && serial < 100_000) {
    return new Date(Date.UTC(1899, 11, 30) + Math.trunc(serial) * 86_400_000)
  }
  return null
}

/** Two-digit year per Python strptime %y: 00–68 → 2000s, 69–99 → 1900s. */
function yy(n: number): number {
  return n <= 68 ? 2000 + n : 1900 + n
}

/** Latest 4-digit year from a free-text education range, e.g. "2019 – 2023" → 2023-01-01 (UTC). */
export function extractEducationYear(value: unknown): Date | null {
  if (value == null || value === '') return null
  const years = String(value).match(/\b(20\d{2}|19\d{2})\b/g)
  if (!years || years.length === 0) return null
  const max = Math.max(...years.map(Number))
  return new Date(Date.UTC(max, 0, 1))
}

/** A raw design-partner row keyed by the client's column names. */
export type PartnerRow = Record<string, string | number | null | undefined>

function str(row: PartnerRow, field: string): string {
  const v = row[field]
  if (v == null) return ''
  const s = String(v).trim()
  return NULLISH.has(s.toLowerCase()) ? '' : s
}

function int(row: PartnerRow, field: string): number | null {
  const v = row[field]
  if (v == null) return null
  const s = String(v).trim()
  if (NULLISH.has(s.toLowerCase())) return null
  const n = Number(s)
  return Number.isFinite(n) ? Math.trunc(n) : null
}

/** Map a raw design-partner row → SubscriberRecord. Mirrors test_regression._row_to_record. */
export function rowToRecord(row: PartnerRow): SubscriberRecord {
  return {
    email: str(row, 'email'),
    accountName: str(row, 'Account Name'),
    institutionName: str(row, 'Institution Name'),
    institutionLocation: str(row, 'Institution Location'),
    accountCountry: str(row, 'Account Location'),
    statedGraduationDate: parseDate(row['Expected Graduation']),
    renewalDeltaDays: int(row, 'Difference Before Last Renewal'),
    proofSubmissionDate: parseDate(row['Proof Submission Date']),
    subscriptionStartDate: parseDate(row['Subscription Start Date']),
    subscriptionEndDate: parseDate(row['Subscription End Date']),
    liCurrentEmployerName: str(row, 'LI Job Company Name'),
    liJobEndDate: parseDate(row['LI Job End Date']),
    liJobTitle: str(row, 'LI Title'),
    liEducationEndDate: extractEducationYear(row['LI Education Date Range']),
    liCurrentEmployerDomain: str(row, 'Company Domain Name'),
  }
}
