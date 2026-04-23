export default function SettingsLoading() {
  return (
    <section className="space-y-6">
      <div className="h-6 w-24 animate-pulse rounded bg-neutral-200 dark:bg-neutral-800" />
      {Array.from({ length: 3 }).map((_, i) => (
        <div
          key={i}
          className="space-y-3 rounded-lg border border-neutral-200 p-4 dark:border-neutral-800"
        >
          <div className="h-4 w-32 animate-pulse rounded bg-neutral-200 dark:bg-neutral-800" />
          <div className="h-3 w-48 animate-pulse rounded bg-neutral-100 dark:bg-neutral-900" />
          <div className="h-8 w-28 animate-pulse rounded bg-neutral-100 dark:bg-neutral-900" />
        </div>
      ))}
    </section>
  );
}
