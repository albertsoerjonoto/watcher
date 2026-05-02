import { readSessionUserId } from "@/lib/session";
import { loadSettingsData } from "@/lib/settings-data";
import { SettingsContent } from "@/components/SettingsContent";

export const dynamic = "force-dynamic";

// Auth gate is sync HMAC, then loadSettingsData runs the parallel
// queries (including the user lookup). Result is inlined as
// fallbackData so cold launches never show the skeleton.
export default async function SettingsPage() {
  const userId = readSessionUserId();
  if (!userId)
    return (
      <p className="text-neutral-500 dark:text-neutral-400">
        Sign in required.
      </p>
    );

  const fallbackData = await loadSettingsData(userId);
  if (!fallbackData)
    return (
      <p className="text-neutral-500 dark:text-neutral-400">
        Sign in required.
      </p>
    );

  return <SettingsContent fallbackData={fallbackData} />;
}
