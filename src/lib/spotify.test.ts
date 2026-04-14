import { describe, it, expect } from "vitest";
import { parsePlaylistId, extractTracksPage } from "./spotify";

describe("parsePlaylistId", () => {
  it("accepts a bare id", () => {
    expect(parsePlaylistId("7b3K3nqunOP5Wm5wvLABmf")).toBe(
      "7b3K3nqunOP5Wm5wvLABmf",
    );
  });
  it("accepts a spotify: URI", () => {
    expect(parsePlaylistId("spotify:playlist:7b3K3nqunOP5Wm5wvLABmf")).toBe(
      "7b3K3nqunOP5Wm5wvLABmf",
    );
  });
  it("accepts an open.spotify.com URL with query", () => {
    expect(
      parsePlaylistId(
        "https://open.spotify.com/playlist/7b3K3nqunOP5Wm5wvLABmf?si=abc",
      ),
    ).toBe("7b3K3nqunOP5Wm5wvLABmf");
  });
  it("accepts an intl-prefixed URL", () => {
    expect(
      parsePlaylistId(
        "https://open.spotify.com/intl-id/playlist/2AyxU8MhBdpjN5iS9ag4du",
      ),
    ).toBe("2AyxU8MhBdpjN5iS9ag4du");
  });
  it("returns null for garbage", () => {
    expect(parsePlaylistId("not a playlist")).toBeNull();
  });
});

describe("extractTracksPage", () => {
  it("returns null for non-objects", () => {
    expect(extractTracksPage(null)).toBeNull();
    expect(extractTracksPage(undefined)).toBeNull();
    expect(extractTracksPage("string")).toBeNull();
    expect(extractTracksPage(42)).toBeNull();
  });

  it("returns null when no tracks field present", () => {
    expect(extractTracksPage({ name: "foo", id: "bar" })).toBeNull();
  });

  it("extracts the standard nested shape", () => {
    const page = extractTracksPage({
      name: "foo",
      tracks: {
        items: [{ added_at: "2024-01-01" }],
        next: "https://api.spotify.com/next",
        total: 1,
      },
    });
    expect(page).not.toBeNull();
    expect(page?.items).toHaveLength(1);
    expect(page?.next).toBe("https://api.spotify.com/next");
    expect(page?.total).toBe(1);
  });

  it("extracts the flattened top-level shape", () => {
    // Observed in the wild on some accounts: playlist object has
    // `items` directly at the root instead of a nested `tracks`.
    const page = extractTracksPage({
      collaborative: false,
      name: "foo",
      items: [{ added_at: "2024-01-01" }, { added_at: "2024-01-02" }],
      type: "playlist",
    });
    expect(page).not.toBeNull();
    expect(page?.items).toHaveLength(2);
    expect(page?.next).toBeNull();
    expect(page?.total).toBe(2);
  });

  it("prefers nested shape when both are present", () => {
    const page = extractTracksPage({
      tracks: { items: [{ added_at: "nested" }], next: null, total: 1 },
      items: [{ added_at: "flat-a" }, { added_at: "flat-b" }],
    });
    expect(page?.items).toHaveLength(1);
    expect(
      (page?.items[0] as unknown as { added_at: string }).added_at,
    ).toBe("nested");
  });

  it("handles missing next/total gracefully", () => {
    const page = extractTracksPage({ items: [] });
    expect(page?.items).toHaveLength(0);
    expect(page?.next).toBeNull();
    expect(page?.total).toBe(0);
  });
});
