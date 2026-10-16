import Link from 'next/link'

export default function CheckEmailPage() {
  return (
    <div className="min-h-screen flex items-center justify-center bg-gray-50">
      <div className="w-full max-w-md">
        <div className="bg-white rounded-2xl shadow-sm border border-gray-200 p-8 text-center">
          <div className="mb-6">
            <div className="mx-auto w-12 h-12 bg-brand-50 rounded-full flex items-center justify-center mb-4">
              <svg className="w-6 h-6 text-brand-600" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={1.5}>
                <path strokeLinecap="round" strokeLinejoin="round" d="M21.75 6.75v10.5a2.25 2.25 0 01-2.25 2.25h-15a2.25 2.25 0 01-2.25-2.25V6.75m19.5 0A2.25 2.25 0 0019.5 4.5h-15a2.25 2.25 0 00-2.25 2.25m19.5 0v.243a2.25 2.25 0 01-1.07 1.916l-7.5 4.615a2.25 2.25 0 01-2.36 0L3.32 8.91a2.25 2.25 0 01-1.07-1.916V6.75" />
              </svg>
            </div>
            <span className="text-2xl font-bold text-brand-700 tracking-tight">Lycert</span>
          </div>

          <h1 className="text-xl font-bold text-gray-900 mb-2">Check your email</h1>
          <p className="text-sm text-gray-500 mb-6">
            We&apos;ve sent a confirmation link to your email address. Click the link to verify your
            account and continue setting up Lycert.
          </p>

          <div className="bg-amber-50 border border-amber-200 rounded-lg px-4 py-3 text-sm text-amber-800 mb-6">
            You must confirm your email before you can access your account.
          </div>

          <p className="text-xs text-gray-400">
            Didn&apos;t receive an email? Check your spam folder, or{' '}
            <Link href="/signup" className="text-brand-600 hover:text-brand-700 underline">
              try signing up again
            </Link>
            .
          </p>
        </div>
      </div>
    </div>
  )
}
