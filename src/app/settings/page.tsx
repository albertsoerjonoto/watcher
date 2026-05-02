import { getCurrentUser } from "@/lib/session";
import { SettingsContent } from "@/components/SettingsContent";

export const dynamic = "force-dynamic";

// Thin shell: auth check only. Data is loaded client-side by
// SettingsContent's SWR with the SWRProvider's localStorage cache.
export default async function SettingsPage() {
  const user = await getCurrentUser();
  if (!user)
    return (
      <p className="text-neutral-500 dark:text-neutral-400">
        Sign in required.
      </p>
    );

  return <SettingsContent />;
}
