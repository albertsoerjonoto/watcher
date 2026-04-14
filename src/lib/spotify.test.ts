import { describe, it, expect } from "vitest";
import { parsePlaylistId } from "./spotify";

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
