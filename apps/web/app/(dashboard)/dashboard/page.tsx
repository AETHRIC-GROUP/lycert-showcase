export default function DashboardPage() {
  return (
    <div>
      <h1 className="text-2xl font-bold text-gray-900">Dashboard</h1>
      <p className="mt-1 text-sm text-gray-500">
        ROI analytics and subscriber overview — coming in Phase 2.
      </p>

      <div className="mt-8 grid grid-cols-1 gap-5 sm:grid-cols-2 lg:grid-cols-4">
        {[
          { label: 'Active Subscribers', value: '—' },
          { label: 'Open Cases',          value: '—' },
          { label: 'Converted This Quarter', value: '—' },
          { label: 'Pending Review',     value: '—' },
        ].map(stat => (
          <div
            key={stat.label}
            className="bg-white rounded-xl border border-gray-200 px-5 py-4"
          >
            <p className="text-xs text-gray-500 uppercase tracking-wide">{stat.label}</p>
            <p className="mt-1 text-3xl font-semibold text-gray-900">{stat.value}</p>
          </div>
        ))}
      </div>
    </div>
  )
}
