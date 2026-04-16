import { ImageResponse } from "next/og";
import { readFile } from "node:fs/promises";
import { join } from "node:path";

export const size = { width: 180, height: 180 };
export const contentType = "image/png";

export default async function AppleIcon() {
  const fontData = await readFile(
    join(process.cwd(), "src/assets/inter-bold.ttf"),
  );

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
            fontSize: 120,
            fontFamily: "Inter",
            fontWeight: 700,
            color: "#1DB954",
            lineHeight: 1,
            marginTop: 8,
          }}
        >
          W
        </span>
      </div>
    ),
    {
      ...size,
      fonts: [{ name: "Inter", data: fontData, weight: 700, style: "normal" }],
    },
  );
}
