import { getCurrentUser } from "@/lib/session";
import { loadSettingsData } from "@/lib/settings-data";
import { SettingsContent } from "@/components/SettingsContent";

export const dynamic = "force-dynamic";

export default async function SettingsPage() {
  const user = await getCurrentUser();
  if (!user)
    return (
      <p className="text-neutral-500 dark:text-neutral-400">
        Sign in required.
      </p>
    );

  // SSR fallback shared with /api/settings via loadSettingsData(). The
  // SWR client in SettingsContent uses this object as fallbackData so
  // first paint is SSR'd, then revalidates from /api/settings. Repeat
  // visits hit the SWRProvider's localStorage cache and skip the network.
  const fallbackData = await loadSettingsData(user);

  return <SettingsContent fallbackData={fallbackData} />;
}
