'use client'

import { useState, useTransition } from 'react'
import { addCommentAction } from '@/lib/actions/cases'

interface Comment {
  id: string
  body: string
  created_at: string
  author: string
}

interface Props {
  caseId: string
  tenantId: string
  authorId: string
  initialComments: Comment[]
}

export function CaseComments({ caseId, tenantId, authorId, initialComments }: Props) {
  const [comments, setComments] = useState(initialComments)
  const [body, setBody] = useState('')
  const [error, setError] = useState<string | null>(null)
  const [pending, startTransition] = useTransition()

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault()
    if (body.trim().length < 5) { setError('Comment must be at least 5 characters.'); return }
    setError(null)
    const result = await addCommentAction(caseId, tenantId, authorId, body)
    if (result.error) { setError(result.error); return }
    setComments(prev => [...prev, {
      id: crypto.randomUUID(),
      body: body.trim(),
      created_at: new Date().toISOString(),
      author: 'You',
    }])
    setBody('')
  }

  return (
    <div className="mt-5 bg-white rounded-xl border border-gray-200 p-5">
      <h2 className="text-sm font-semibold text-gray-700 mb-4">Comments</h2>

      {comments.length === 0 ? (
        <p className="text-sm text-gray-400 mb-4">No comments yet.</p>
      ) : (
        <div className="space-y-3 mb-4">
          {comments.map(c => (
            <div key={c.id} className="bg-gray-50 rounded-lg px-4 py-3">
              <div className="flex justify-between items-center mb-1">
                <span className="text-xs font-medium text-gray-700">{c.author}</span>
                <span className="text-xs text-gray-400">
                  {new Date(c.created_at).toLocaleString('en-GB', { dateStyle: 'short', timeStyle: 'short' })}
                </span>
              </div>
              <p className="text-sm text-gray-800">{c.body}</p>
            </div>
          ))}
        </div>
      )}

      <form onSubmit={e => startTransition(() => { void handleSubmit(e) })}>
        <textarea
          value={body}
          onChange={e => setBody(e.target.value)}
          rows={3}
          placeholder="Add a comment…"
          className="w-full rounded-lg border border-gray-300 px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-brand-500"
        />
        {error && <p className="text-xs text-red-600 mt-1">{error}</p>}
        <button
          type="submit"
          disabled={pending || body.trim().length < 5}
          className="mt-2 px-4 py-2 bg-brand-600 text-white text-sm font-medium rounded-lg hover:bg-brand-700 disabled:opacity-50 disabled:cursor-not-allowed transition-colors"
        >
          {pending ? 'Saving…' : 'Add comment'}
        </button>
      </form>
    </div>
  )
}