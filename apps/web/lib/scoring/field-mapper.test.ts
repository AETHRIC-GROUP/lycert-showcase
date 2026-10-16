/** field-mapper unit tests — date parsing parity with Python strptime. */
import { describe, it, expect } from 'vitest'
import { parseDate, extractEducationYear } from './field-mapper'

function iso(d: Date | null): string | null {
  return d ? d.toISOString().slice(0, 10) : null
}

describe('parseDate', () => {
  it('parses ISO with and without time', () => {
    expect(iso(parseDate('2025-04-26'))).toBe('2025-04-26')
    expect(iso(parseDate('2025-04-26 00:00:00'))).toBe('2025-04-26')
    expect(iso(parseDate('2025-05-17T16:57:00'))).toBe('2025-05-17')
  })

  it('parses 1- and 2-digit day/month d.m.y (Python strptime leniency)', () => {
    expect(iso(parseDate('7.07.26'))).toBe('2026-07-07')
    expect(iso(parseDate('2.04.25'))).toBe('2025-04-02')
    expect(iso(parseDate('17.02.25'))).toBe('2025-02-17')
    expect(iso(parseDate('10.08.25 9:21'))).toBe('2025-08-10')
  })

  it('returns null for blanks / unparseable', () => {
    expect(parseDate('')).toBeNull()
    expect(parseDate('nan')).toBeNull()
    expect(parseDate(null)).toBeNull()
  })

  it('extracts the latest education year', () => {
    expect(iso(extractEducationYear('2019 – 2023'))).toBe('2023-01-01')
    expect(iso(extractEducationYear('2024'))).toBe('2024-01-01')
    expect(extractEducationYear('')).toBeNull()
  })
})
