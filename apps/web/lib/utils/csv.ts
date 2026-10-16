export interface ParsedCSVRow {
  [key: string]: string
}

/**
 * Decode raw CSV bytes to text. `FileReader.readAsText` assumes UTF-8, but Excel-on-Windows
 * commonly exports Windows-1252 (and other tools Mac Roman) — decoding those bytes as UTF-8 turns
 * accented characters (é, ü, ç, ö…) into the replacement character. We strip a UTF-8 BOM, try
 * strict UTF-8 first, and fall back to Windows-1252 so accents survive instead of being destroyed.
 */
export function decodeCsvBytes(buf: ArrayBuffer): string {
  let bytes = new Uint8Array(buf)
  if (bytes.length >= 3 && bytes[0] === 0xef && bytes[1] === 0xbb && bytes[2] === 0xbf) {
    bytes = bytes.subarray(3) // strip UTF-8 BOM
  }
  try {
    return new TextDecoder('utf-8', { fatal: true }).decode(bytes)
  } catch {
    return new TextDecoder('windows-1252').decode(bytes)
  }
}

/**
 * Heuristic flag for text that was already mojibake'd before upload (UTF-8 misread as Latin-1 or
 * Mac Roman at the source, e.g. an Excel-for-Mac re-save). We can't recover this — the right action
 * is to re-export the source as UTF-8 — but we can warn before importing tens of thousands of rows.
 */
export function looksLikeMojibake(text: string): boolean {
  return (
    text.includes('�') || // replacement char — bytes already lost
    /Ã[ -¿]/.test(text) || // é→Ã©, ü→Ã¼ … (UTF-8 read as Windows-1252)
    /â€[¢]/.test(text) || // smart-quote/em-dash mojibake
    /√[©®°¥¢º§†‚Ñ‹]/.test(text) || // é→√©, ü→√º … (UTF-8 read as Mac Roman)
    // Literal '?' substitution: a lossy ASCII export already replaced accented bytes with '?', so the
    // characters are gone for good (Verónica→"Ver??nica", Urbanizaci??n). A '?' wedged between letters
    // is the signature; a sentence-ending '?' (followed by a space/end) never trips it.
    /[A-Za-z]\?{1,2}[A-Za-z]/.test(text)
  )
}

export function parseCSV(text: string): { headers: string[]; rows: ParsedCSVRow[] } {
  const lines = text.trim().split(/\r?\n/)
  if (lines.length < 2) return { headers: [], rows: [] }
  const headers = parseCSVLine(lines[0])
  const rows = lines.slice(1)
    .map(line => {
      const values = parseCSVLine(line)
      const row: ParsedCSVRow = {}
      headers.forEach((h, i) => { row[h] = values[i] ?? '' })
      return row
    })
    .filter(row => Object.values(row).some(v => v.trim() !== ''))
  return { headers, rows }
}

function parseCSVLine(line: string): string[] {
  const result: string[] = []
  let current = ''
  let inQuotes = false
  for (let i = 0; i < line.length; i++) {
    const c = line[i]
    if (c === '"') {
      if (inQuotes && line[i + 1] === '"') { current += '"'; i++ }
      else { inQuotes = !inQuotes }
    } else if (c === ',' && !inQuotes) {
      result.push(current.trim())
      current = ''
    } else {
      current += c
    }
  }
  result.push(current.trim())
  return result
}

export function isValidEmail(email: string): boolean {
  return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email.trim())
}

export type DateOrder = 'dmy' | 'mdy'

/** Two-digit year → 4-digit, per Python strptime %y (00–68 → 2000s, 69–99 → 1900s). Kept identical
 *  to lib/scoring/field-mapper.ts so import and scoring agree on the year of every date string. */
function expandYear(n: number): number {
  if (n >= 100) return n
  return n <= 68 ? 2000 + n : 1900 + n
}

/** Split a non-ISO date into its first/second/year components, accepting '.', '/' or '-' separators
 *  and an optional trailing time (`17/02/2027 00:00`). Year-first / ISO shapes return null — callers
 *  handle those separately. `a` and `b` are the ambiguous day/month pair, in source order. */
function splitDayMonthYear(value: string): { a: number; b: number; year: number } | null {
  const head = (value ?? '').trim().split(/[ T]/)[0]
  const m = head.match(/^(\d{1,2})[./-](\d{1,2})[./-](\d{2}|\d{4})$/)
  if (!m) return null
  return { a: +m[1], b: +m[2], year: expandYear(+m[3]) }
}

/** Build 'YYYY-MM-DD' from numeric parts, or null if it isn't a real calendar date (e.g. 31 Apr,
 *  30 Feb). Built from components directly — no local-timezone Date round-trip — so it never drifts
 *  by a day the way `new Date(s).toISOString()` does. */
function toIsoDate(y: number, mo: number, d: number): string | null {
  if (mo < 1 || mo > 12 || d < 1 || d > 31) return null
  const dt = new Date(Date.UTC(y, mo - 1, d))
  if (dt.getUTCFullYear() !== y || dt.getUTCMonth() !== mo - 1 || dt.getUTCDate() !== d) return null
  return `${y}-${String(mo).padStart(2, '0')}-${String(d).padStart(2, '0')}`
}

/**
 * Infer whether a column of date strings is day-first or month-first from unambiguous evidence: a
 * value whose first component is >12 can only be day-first; one whose second component is >12 can
 * only be month-first. Majority vote across the column; defaults to day-first when there is no
 * evidence either way (most non-US data — and the safer default for graduation dates). Resolving the
 * order once per column means a few all-≤12 values inherit the format proven by their neighbours.
 */
export function inferDateOrder(values: string[]): DateOrder {
  let dmy = 0
  let mdy = 0
  for (const v of values) {
    const p = splitDayMonthYear(v)
    if (!p) continue
    if (p.a > 12 && p.b <= 12) dmy++
    else if (p.b > 12 && p.a <= 12) mdy++
  }
  return mdy > dmy ? 'mdy' : 'dmy'
}

/**
 * Parse one date string to 'YYYY-MM-DD', or null. Handles ISO, dotted/slashed/dashed dates with
 * 2- or 4-digit years, an optional trailing time, and Excel serial numbers. An unambiguous component
 * (>12) always wins; a genuinely ambiguous day/month pair (both ≤12) is resolved by `order`.
 */
export function parseDateInOrder(value: string, order: DateOrder = 'dmy'): string | null {
  if (!value?.trim()) return null
  const head = value.trim().split(/[ T]/)[0]

  const iso = head.match(/^(\d{4})[-/.](\d{1,2})[-/.](\d{1,2})$/) // year-first
  if (iso) return toIsoDate(+iso[1], +iso[2], +iso[3])

  const p = splitDayMonthYear(head)
  if (p) {
    const { a, b, year } = p
    let day: number
    let mo: number
    if (a > 12 && b <= 12) { day = a; mo = b }       // unambiguous day-first
    else if (b > 12 && a <= 12) { day = b; mo = a }  // unambiguous month-first
    else if (order === 'mdy') { mo = a; day = b }    // ambiguous → column order
    else { day = a; mo = b }
    return toIsoDate(year, mo, day)
  }

  const serial = Number(head) // Excel serial (days since 1899-12-30)
  if (Number.isFinite(serial) && serial > 1000 && serial < 100_000) {
    const dt = new Date(Date.UTC(1899, 11, 30) + Math.trunc(serial) * 86_400_000)
    return toIsoDate(dt.getUTCFullYear(), dt.getUTCMonth() + 1, dt.getUTCDate())
  }
  return null
}

/** Single-value date parse (day-first default). When parsing a whole column, infer the order once
 *  with {@link inferDateOrder} and call {@link parseDateInOrder} so ambiguous values stay consistent. */
export function parseDate(value: string): string | null {
  return parseDateInOrder(value, 'dmy')
}

export function rowsToCSV(rows: Record<string, string>[]): string {
  if (!rows.length) return ''
  const headers = Object.keys(rows[0])
  return [
    headers.join(','),
    ...rows.map(r => headers.map(h => `"${(r[h] ?? '').replace(/"/g, '""')}"`).join(',')),
  ].join('\n')
}