import { readSessionUserId } from "@/lib/session";
import { SettingsContent } from "@/components/SettingsContent";

export const dynamic = "force-dynamic";

// Thin shell. Auth check is the synchronous HMAC-only `readSessionUserId`
// (no DB round-trip, no Prisma lazy-migration on cold start), so the
// function returns in ~5–10ms. Data is loaded client-side.
export default function SettingsPage() {
  const userId = readSessionUserId();
  if (!userId)
    return (
      <p className="text-neutral-500 dark:text-neutral-400">
        Sign in required.
      </p>
    );

  return <SettingsContent />;
}
