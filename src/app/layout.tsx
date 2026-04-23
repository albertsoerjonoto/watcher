import "./globals.css";
import type { Metadata, Viewport } from "next";
import Link from "next/link";
import { AutoRefresh } from "@/components/AutoRefresh";

export const metadata: Metadata = {
  title: "Watcher",
  description: "Get notified when new tracks are added to your playlists.",
  manifest: "/manifest.webmanifest",
  appleWebApp: { capable: true, title: "Watcher", statusBarStyle: "default" },
};

export const viewport: Viewport = {
  themeColor: [
    { media: "(prefers-color-scheme: light)", color: "#ffffff" },
    { media: "(prefers-color-scheme: dark)", color: "#0b0b0b" },
  ],
  maximumScale: 1,
  userScalable: false,
};

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en">
      <body>
        <header className="border-b border-neutral-200 dark:border-neutral-800">
          <nav className="mx-auto flex max-w-3xl items-center gap-4 p-4 text-sm">
            <Link href="/" className="text-neutral-600 hover:text-black dark:text-neutral-300 dark:hover:text-white">
              Dashboard
            </Link>
            <Link href="/feed" className="text-neutral-600 hover:text-black dark:text-neutral-300 dark:hover:text-white">
              Feed
            </Link>
            <div className="ml-auto flex items-center gap-4">
              <AutoRefresh />
              <Link href="/settings" className="text-neutral-600 hover:text-black dark:text-neutral-300 dark:hover:text-white">
                Settings
              </Link>
            </div>
          </nav>
        </header>
        <main className="mx-auto max-w-3xl p-4">{children}</main>
      </body>
    </html>
  );
}
