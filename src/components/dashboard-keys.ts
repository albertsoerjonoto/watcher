// SWR cache key for the dashboard data fetch. Extracted from
// DashboardContent.tsx to break a circular import:
// DashboardPlaylistList → DashboardContent → DashboardPlaylistList.
//
// Anywhere that wants to mutate the dashboard cache should import from
// here, not from DashboardContent (which still re-exports for callers
// that already imported it).

export const DASHBOARD_KEY = "/api/dashboard";
