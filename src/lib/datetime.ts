// All user-visible timestamps render in Jakarta time (Asia/Jakarta, UTC+7).
// The app is single-user (Albert) so we don't try to detect locale — every
// date label across the app goes through these helpers.

const TZ = "Asia/Jakarta";

const dateFmt = new Intl.DateTimeFormat("en-GB", {
  timeZone: TZ,
  day: "2-digit",
  month: "short",
  year: "numeric",
});

const dateTimeFmt = new Intl.DateTimeFormat("en-GB", {
  timeZone: TZ,
  day: "2-digit",
  month: "short",
  year: "numeric",
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
  return dateTimeFmt.format(date);
}

// YYYY-MM-DD in Jakarta TZ — used as a stable group key in the feed.
export function dayKeyJakarta(d: Date | string): string {
  const date = d instanceof Date ? d : new Date(d);
  return dayKeyFmt.format(date);
}
