import { describe, it, expect } from "vitest";
import { diffTracks, filterSelfAdds, type TrackKeyed } from "./diff";

const t = (
  id: string,
  addedAt: string | Date,
  extra: Partial<TrackKeyed> = {},
): TrackKeyed => ({
  spotifyTrackId: id,
  addedAt,
  title: `Song ${id}`,
  artists: ["Artist"],
  durationMs: 200_000,
  ...extra,
});

describe("diffTracks", () => {
  it("returns [] when incoming equals existing", () => {
    const a = [t("1", "2026-04-01T00:00:00Z"), t("2", "2026-04-02T00:00:00Z")];
    expect(diffTracks(a, a)).toEqual([]);
  });

  it("returns only new tracks", () => {
    const existing = [t("1", "2026-04-01T00:00:00Z")];
    const incoming = [
      t("1", "2026-04-01T00:00:00Z"),
      t("2", "2026-04-02T00:00:00Z"),
      t("3", "2026-04-03T00:00:00Z"),
    ];
    const added = diffTracks(existing, incoming);
    expect(added.map((x) => x.spotifyTrackId)).toEqual(["2", "3"]);
  });

  it("treats the same trackId added at different times as distinct additions", () => {
    const existing = [t("1", "2026-04-01T00:00:00Z")];
    const incoming = [
      t("1", "2026-04-01T00:00:00Z"),
      t("1", "2026-04-05T00:00:00Z"), // re-added
    ];
    const added = diffTracks(existing, incoming);
    expect(added).toHaveLength(1);
    expect(added[0].addedAt).toBe("2026-04-05T00:00:00Z");
  });

  it("accepts Date objects interchangeably with ISO strings", () => {
    const existing = [t("1", new Date("2026-04-01T00:00:00Z"))];
    const incoming = [t("1", "2026-04-01T00:00:00.000Z")];
    expect(diffTracks(existing, incoming)).toEqual([]);
  });

  it("preserves incoming order", () => {
    const existing: TrackKeyed[] = [];
    const incoming = [
      t("c", "2026-04-03T00:00:00Z"),
      t("a", "2026-04-01T00:00:00Z"),
      t("b", "2026-04-02T00:00:00Z"),
    ];
    const added = diffTracks(existing, incoming);
    expect(added.map((x) => x.spotifyTrackId)).toEqual(["c", "a", "b"]);
  });

  it("dedupes within the incoming page", () => {
    const incoming = [
      t("1", "2026-04-01T00:00:00Z"),
      t("1", "2026-04-01T00:00:00Z"),
    ];
    const added = diffTracks([], incoming);
    expect(added).toHaveLength(1);
  });

  it("handles empty existing", () => {
    const incoming = [t("1", "2026-04-01T00:00:00Z")];
    expect(diffTracks([], incoming)).toHaveLength(1);
  });

  it("handles empty incoming (track removed)", () => {
    const existing = [t("1", "2026-04-01T00:00:00Z")];
    expect(diffTracks(existing, [])).toEqual([]);
  });
});

describe("filterSelfAdds", () => {
  it("suppresses tracks added by the self user", () => {
    const tracks = [
      t("1", "2026-04-01T00:00:00Z", { addedBySpotifyId: "179366" }),
      t("2", "2026-04-02T00:00:00Z", { addedBySpotifyId: "friend" }),
      t("3", "2026-04-03T00:00:00Z", { addedBySpotifyId: null }),
    ];
    const filtered = filterSelfAdds(tracks, "179366");
    expect(filtered.map((x) => x.spotifyTrackId)).toEqual(["2", "3"]);
  });

  it("is a passthrough when self id is missing", () => {
    const tracks = [t("1", "2026-04-01T00:00:00Z", { addedBySpotifyId: "x" })];
    expect(filterSelfAdds(tracks, undefined)).toHaveLength(1);
    expect(filterSelfAdds(tracks, null)).toHaveLength(1);
  });
});
