// All user-visible timestamps render in Jakarta time (Asia/Jakarta, UTC+7).
// The app is single-user (Albert) so we don't try to detect locale — every
// date label across the app goes through these helpers.

const TZ = "Asia/Jakarta";

const dateFmt = new Intl.DateTimeFormat("en-GB", {
  timeZone: TZ,
  weekday: "short",
  day: "2-digit",
  month: "short",
});

const dateTimeFmt = new Intl.DateTimeFormat("en-GB", {
  timeZone: TZ,
  weekday: "short",
  day: "2-digit",
  month: "short",
  hour: "2-digit",
  minute: "2-digit",
  hour12: false,
});

const dayKeyFmt = new Intl.DateTimeFormat("en-CA", {
  timeZone: TZ,
  year: "numeric",
  month: "2-digit",
  day: "2-digit",
});

export function formatDateJakarta(d: Date | string | null | undefined): string {
  if (!d) return "—";
  const date = d instanceof Date ? d : new Date(d);
  if (isNaN(date.getTime())) return "—";
  return dateFmt.format(date);
}

export function formatDateTimeJakarta(
  d: Date | string | null | undefined,
): string {
  if (!d) return "—";
  const date = d instanceof Date ? d : new Date(d);
  if (isNaN(date.getTime())) return "—";
  return dateTimeFmt.format(date).replace(",", "").replace(":", ".");
}

// YYYY-MM-DD in Jakarta TZ — used as a stable group key in the feed.
export function dayKeyJakarta(d: Date | string): string {
  const date = d instanceof Date ? d : new Date(d);
  return dayKeyFmt.format(date);
}

// "today" / "yesterday" / "N days ago" relative to now in Jakarta calendar
// days. Day boundaries follow Jakarta TZ so "today" matches what the user
// sees on the wall clock.
export function formatRelativeJakarta(
  d: Date | string | null | undefined,
): string {
  if (!d) return "—";
  const date = d instanceof Date ? d : new Date(d);
  if (isNaN(date.getTime())) return "—";
  const todayKey = dayKeyJakarta(new Date());
  const thenKey = dayKeyJakarta(date);
  if (todayKey === thenKey) return "today";
  const [ty, tm, td] = todayKey.split("-").map(Number);
  const [py, pm, pd] = thenKey.split("-").map(Number);
  const diffDays = Math.round(
    (Date.UTC(ty, tm - 1, td) - Date.UTC(py, pm - 1, pd)) / 86_400_000,
  );
  if (diffDays === 1) return "yesterday";
  if (diffDays > 1) return `${diffDays} days ago`;
  if (diffDays === -1) return "tomorrow";
  return `in ${-diffDays} days`;
}
