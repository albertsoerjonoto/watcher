import type { Config } from "tailwindcss";

export default {
  content: ["./src/**/*.{ts,tsx}"],
  darkMode: "media",
  theme: {
    extend: {
      colors: {
        spotify: "#1DB954",
      },
    },
  },
  plugins: [],
} satisfies Config;
