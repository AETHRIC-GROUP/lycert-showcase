'use client'

import { useTransition } from 'react'
import { assignCaseAction } from '@/lib/actions/cases'

export function AssignButton({ caseId }: { caseId: string }) {
  const [pending, startTransition] = useTransition()

  return (
    <button
      disabled={pending}
      onClick={() => startTransition(() => { void assignCaseAction(caseId) })}
      className="text-xs text-brand-600 hover:text-brand-800 font-medium disabled:opacity-50"
    >
      {pending ? 'Assigning…' : 'Assign to me'}
    </button>
  )
}