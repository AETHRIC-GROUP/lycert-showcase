/**
 * CEDS scoring regression — TypeScript engine must match the Python reference oracle
 * row-for-row at reference date 2026-05-26.
 *
 * Parity gate (DECISIONS.md 2026-06-13): Total Score within ±1, Confidence Tier exact —
 * the identical bar the Python `test_regression.py` enforces.
 *
 * Fixture: ./__fixtures__/ceds_regression.json is generated from the same reference files
 * (docs/reference/sample_accounts.xlsx + scored_sample_accounts_20260526.csv) by
 * `python scripts/build_scoring_regression_fixture.py`. Rebuild it if those files change.
 */
import { describe, it, expect } from 'vitest'
import fixture from './__fixtures__/ceds_regression.json'
import { scoreRow } from './engine'
import { rowToRecord } from './field-mapper'
import { defaultScoringConfig } from './models'

// 2026-05-26, UTC midnight — matches Python date(2026, 5, 26).
const REFERENCE_DATE = new Date(Date.UTC(2026, 4, 26))

type FixtureRow = {
  input: Record<string, string | number>
  expected: { total_score: number; confidence_tier: number }
}

describe('CEDS scoring regression (parity with Python engine)', () => {
  const rows = fixture as FixtureRow[]
  const config = defaultScoringConfig()

  it('scores every sample account within ±1 total and exact tier', () => {
    const mismatches: string[] = []
    rows.forEach((row, idx) => {
      const record = rowToRecord(row.input)
      const result = scoreRow(record, config, REFERENCE_DATE)
      const scoreDiff = Math.abs(result.totalScore - row.expected.total_score)
      const tierOk = result.confidenceTier === row.expected.confidence_tier
      if (scoreDiff > 1 || !tierOk) {
        mismatches.push(
          `row ${idx + 1} (${row.input.email}): score ${result.totalScore} vs ` +
            `${row.expected.total_score}, tier ${result.confidenceTier} vs ` +
            `${row.expected.confidence_tier} | signals=${result.signalsFired} gaps=${result.dataGaps}`,
        )
      }
    })
    expect(mismatches, mismatches.join('\n')).toEqual([])
  })

  it('has a non-empty fixture', () => {
    expect(rows.length).toBeGreaterThan(0)
  })
})
