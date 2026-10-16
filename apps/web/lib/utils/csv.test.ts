/** CSV decode/mojibake tests — guards the import path against accent corruption. */
import { describe, it, expect } from 'vitest'
import { decodeCsvBytes, looksLikeMojibake, parseDateInOrder, inferDateOrder, parseDate } from './csv'

const utf8 = (s: string) => new TextEncoder().encode(s).buffer
/** Encode a string's code points as raw single bytes (Latin-1/Windows-1252 low range). */
const latin1 = (s: string) => {
  const b = new Uint8Array(s.length)
  for (let i = 0; i < s.length; i++) b[i] = s.charCodeAt(i) & 0xff
  return b.buffer
}

describe('decodeCsvBytes', () => {
  it('decodes UTF-8 accents correctly', () => {
    expect(decodeCsvBytes(utf8('Québec, Canada'))).toBe('Québec, Canada')
  })

  it('strips a UTF-8 BOM', () => {
    const withBom = new Uint8Array([0xef, 0xbb, 0xbf, ...Array.from(new Uint8Array(utf8('email')))]).buffer
    expect(decodeCsvBytes(withBom)).toBe('email')
  })

  it('falls back to Windows-1252 for non-UTF-8 bytes (é = 0xE9) instead of producing U+FFFD', () => {
    // "Québec" in Windows-1252: é is a single 0xE9 byte, invalid as standalone UTF-8.
    const out = decodeCsvBytes(latin1('Québec'))
    expect(out).toBe('Québec')
    expect(out).not.toContain('�')
  })
})

describe('looksLikeMojibake', () => {
  it('flags replacement chars and classic double-encodings', () => {
    expect(looksLikeMojibake('Qu�bec')).toBe(true) // lost byte
    expect(looksLikeMojibake('Ã©cole')).toBe(true)       // UTF-8 read as 1252
    expect(looksLikeMojibake('Qu√©bec')).toBe(true)      // UTF-8 read as Mac Roman
  })
  it('flags literal "?" substitution corruption (bytes already destroyed at source)', () => {
    expect(looksLikeMojibake('Ver??nica Arriola')).toBe(true)      // ó → ??
    expect(looksLikeMojibake('Urbanizaci??n el Tikal Sur')).toBe(true)
  })
  it('passes clean text', () => {
    expect(looksLikeMojibake('Québec, Canada')).toBe(false)
    expect(looksLikeMojibake('São Paulo, Brazil')).toBe(false)
    expect(looksLikeMojibake('plain ascii')).toBe(false)
    expect(looksLikeMojibake('Is this right? Yes.')).toBe(false)   // sentence "?" must not trip it
    expect(looksLikeMojibake('Why? Because.')).toBe(false)
  })
})

describe('inferDateOrder', () => {
  it('detects day-first from any day>12 value (real sample column)', () => {
    // From "Sample Lycert accounts-same_country.csv" — all dotted D.M.YY.
    const col = ['30.5.25', '17.5.25', '31.12.25', '10.01.25', '11.05.25', '5.09.25']
    expect(inferDateOrder(col)).toBe('dmy')
  })
  it('detects month-first when the second component is the one that exceeds 12', () => {
    expect(inferDateOrder(['5/30/25', '12/31/25', '1/15/26'])).toBe('mdy')
  })
  it('defaults to day-first when the column is fully ambiguous', () => {
    expect(inferDateOrder(['4/5/25', '6/7/25', '1.2.25'])).toBe('dmy')
  })
})

describe('parseDateInOrder', () => {
  it('parses dotted European dates the old new Date() parser silently dropped', () => {
    expect(parseDateInOrder('30.5.25', 'dmy')).toBe('2025-05-30')   // was skipped (day>12)
    expect(parseDateInOrder('31.12.25', 'dmy')).toBe('2025-12-31')  // Student B — was skipped
    expect(parseDateInOrder('13.8.24', 'dmy')).toBe('2024-08-13')
  })
  it('fixes the dangerous silent month-first misparse for ambiguous dotted dates', () => {
    // new Date('10.01.25') used to yield October → now correctly 10 January under day-first.
    expect(parseDateInOrder('10.01.25', 'dmy')).toBe('2025-01-10')
    expect(parseDateInOrder('11.05.25', 'dmy')).toBe('2025-05-11') // was stored Nov 4
    expect(parseDateInOrder('5.09.25', 'dmy')).toBe('2025-09-05')  // was stored May
  })
  it('handles slashes, ISO, trailing time and 4-digit years', () => {
    expect(parseDateInOrder('17/02/2027 00:00', 'dmy')).toBe('2027-02-17')
    expect(parseDateInOrder('2025-09-30', 'dmy')).toBe('2025-09-30')
    expect(parseDateInOrder('2025/12/01', 'dmy')).toBe('2025-12-01')
  })
  it('respects column order only when both components are ≤12', () => {
    expect(parseDateInOrder('04/05/25', 'dmy')).toBe('2025-05-04')
    expect(parseDateInOrder('04/05/25', 'mdy')).toBe('2025-04-05')
  })
  it('does not drift by a day (no local-timezone round-trip)', () => {
    expect(parseDateInOrder('01.01.25', 'dmy')).toBe('2025-01-01')
  })
  it('rejects impossible and empty dates', () => {
    expect(parseDateInOrder('31.02.25', 'dmy')).toBeNull() // 31 Feb
    expect(parseDateInOrder('', 'dmy')).toBeNull()
    expect(parseDateInOrder('not a date', 'dmy')).toBeNull()
  })
  it('parseDate() back-compat defaults to day-first', () => {
    expect(parseDate('30.5.25')).toBe('2025-05-30')
  })
})
