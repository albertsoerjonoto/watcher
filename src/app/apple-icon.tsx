import { ImageResponse } from "next/og";

export const size = { width: 180, height: 180 };
export const contentType = "image/png";

export default function AppleIcon() {
  return new ImageResponse(
    (
      <div
        style={{
          width: "100%",
          height: "100%",
          display: "flex",
          alignItems: "center",
          justifyContent: "center",
          backgroundColor: "white",
        }}
      >
        <span
          style={{
            fontSize: 144,
            fontWeight: 700,
            color: "#1DB954",
            lineHeight: 1,
          }}
        >
          W
        </span>
      </div>
    ),
    { ...size },
  );
}
