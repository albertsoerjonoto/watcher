export default function FeedLoading() {
  return (
    <section className="space-y-6">
      <div className="h-6 w-24 animate-pulse rounded bg-neutral-800" />
      {Array.from({ length: 2 }).map((_, g) => (
        <div key={g} className="space-y-2">
          <div className="h-3 w-16 animate-pulse rounded bg-neutral-900" />
          <ul className="divide-y divide-neutral-800 rounded-lg border border-neutral-800">
            {Array.from({ length: 4 }).map((_, i) => (
              <li key={i} className="flex items-center gap-3 p-3">
                <div className="h-10 w-10 shrink-0 animate-pulse rounded bg-neutral-800" />
                <div className="flex-1 space-y-2">
                  <div className="h-4 w-1/2 animate-pulse rounded bg-neutral-800" />
                  <div className="h-3 w-1/3 animate-pulse rounded bg-neutral-900" />
                </div>
              </li>
            ))}
          </ul>
        </div>
      ))}
    </section>
  );
}
