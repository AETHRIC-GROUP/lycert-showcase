/**
 * Scoring utilities — deterministic helpers shared by the engine and signals.
 * All dates are UTC-midnight Date objects so day differences are exact integers and
 * match Python's `date` arithmetic.
 */

/** Whole-day difference a - b (both UTC-midnight dates). Matches Python (a - b).days. */
export function dateDiffDays(a: Date, b: Date): number {
  return Math.round((a.getTime() - b.getTime()) / 86_400_000)
}

/** UTC-midnight Date for the given calendar parts, or null if out of range / overflowing. */
export function utcDate(year: number, month1: number, day: number): Date | null {
  if (month1 < 1 || month1 > 12 || day < 1 || day > 31) return null
  const d = new Date(Date.UTC(year, month1 - 1, day))
  // Reject overflow (e.g. Feb 30 → Mar 2), matching Python strptime's rejection.
  if (d.getUTCFullYear() !== year || d.getUTCMonth() !== month1 - 1 || d.getUTCDate() !== day) {
    return null
  }
  return d
}

/** Banker's rounding (round half to even) — matches Python's built-in round(). */
export function roundHalfEven(x: number): number {
  const floor = Math.floor(x)
  const diff = x - floor
  if (diff < 0.5) return floor
  if (diff > 0.5) return floor + 1
  // exactly .5 → round to even
  return floor % 2 === 0 ? floor : floor + 1
}
