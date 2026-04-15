// Instant skeleton for the dashboard. Without a loading boundary,
// every navigation to "/" blocks on the full RSC payload (auth +
// 4 DB roundtrips through the Supabase txn pooler) before the browser
// repaints anything — that's the 2-5s lag the user reported when
// switching between Dashboard / Feed / Settings. With this file
// present Next paints the skeleton immediately on click and streams
// the real content in when ready.
export default function DashboardLoading() {
  return (
    <section className="space-y-6">
      <div className="flex items-start justify-between gap-4">
        <div className="space-y-2">
          <div className="h-5 w-40 animate-pulse rounded bg-neutral-800" />
          <div className="h-3 w-28 animate-pulse rounded bg-neutral-900" />
        </div>
        <div className="h-7 w-24 animate-pulse rounded bg-neutral-900" />
      </div>
      <div className="h-10 animate-pulse rounded bg-neutral-900" />
      <div className="space-y-2">
        <div className="h-3 w-20 animate-pulse rounded bg-neutral-900" />
        <ul className="divide-y divide-neutral-800 rounded-lg border border-neutral-800">
          {Array.from({ length: 4 }).map((_, i) => (
            <li key={i} className="flex items-start gap-3 p-4">
              <div className="h-14 w-14 shrink-0 animate-pulse rounded bg-neutral-800" />
              <div className="flex-1 space-y-2">
                <div className="h-4 w-1/2 animate-pulse rounded bg-neutral-800" />
                <div className="h-3 w-1/3 animate-pulse rounded bg-neutral-900" />
              </div>
            </li>
          ))}
        </ul>
      </div>
    </section>
  );
}
