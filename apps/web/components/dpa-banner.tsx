export function DpaBanner() {
  return (
    <div className="bg-red-600 text-white px-4 py-3 text-sm flex items-center justify-between">
      <div className="flex items-center gap-2">
        <svg className="w-4 h-4 flex-shrink-0" fill="currentColor" viewBox="0 0 20 20">
          <path
            fillRule="evenodd"
            d="M8.485 2.495c.673-1.167 2.357-1.167 3.03 0l6.28 10.875c.673 1.167-.17 2.625-1.516 2.625H3.72c-1.347 0-2.189-1.458-1.515-2.625L8.485 2.495zM10 5a.75.75 0 01.75.75v3.5a.75.75 0 01-1.5 0v-3.5A.75.75 0 0110 5zm0 9a1 1 0 100-2 1 1 0 000 2z"
            clipRule="evenodd"
          />
        </svg>
        <span>
          <strong>Your Data Processing Agreement has not been signed.</strong> No subscriber data
          can be processed until this step is complete.
        </span>
      </div>
      <a
        href="mailto:support@lycert.com?subject=DPA%20Request"
        className="ml-4 flex-shrink-0 underline hover:no-underline font-medium"
      >
        Contact Lycert
      </a>
    </div>
  )
}
