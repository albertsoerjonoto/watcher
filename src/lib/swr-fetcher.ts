// Shared SWR fetcher used across DashboardContent / FeedContent /
// SettingsContent. Throws on non-OK so SWR's error path triggers and
// the error boundary in the calling component can render a message.

export const fetcher = async <T = unknown>(url: string): Promise<T> => {
  const r = await fetch(url);
  if (!r.ok) throw new Error(`${url}: ${r.status}`);
  return (await r.json()) as T;
};
