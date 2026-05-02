import "./globals.css";
import type { Metadata, Viewport } from "next";
import Link from "next/link";
import { LayoutDashboard, Newspaper, Settings as SettingsIcon } from "lucide-react";
import { AutoRefresh } from "@/components/AutoRefresh";
import { PerfTracker } from "@/components/PerfTracker";
import { SWRegister } from "@/components/SWRegister";
import { SWRProvider } from "@/components/SWRProvider";

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
        <SWRProvider>
        <header className="border-b border-neutral-200 dark:border-neutral-800">
          <nav className="mx-auto flex max-w-3xl items-center gap-4 p-4 text-sm">
            <Link
              href="/"
              title="Dashboard"
              aria-label="Dashboard"
              className="text-neutral-600 hover:text-black dark:text-neutral-300 dark:hover:text-white"
            >
              <LayoutDashboard className="h-5 w-5" />
            </Link>
            <Link
              href="/feed"
              title="Feed"
              aria-label="Feed"
              className="text-neutral-600 hover:text-black dark:text-neutral-300 dark:hover:text-white"
            >
              <Newspaper className="h-5 w-5" />
            </Link>
            <div className="ml-auto flex items-center gap-4">
              <div className="flex items-center gap-3 rounded-lg border border-neutral-200 px-2 py-1 dark:border-neutral-800">
                <AutoRefresh />
                <div id="dashboard-toolbar-slot" className="contents" />
              </div>
              <Link
                href="/settings"
                title="Settings"
                aria-label="Settings"
                className="text-neutral-600 hover:text-black dark:text-neutral-300 dark:hover:text-white"
              >
                <SettingsIcon className="h-5 w-5" />
              </Link>
            </div>
          </nav>
        </header>
        <main className="mx-auto max-w-3xl p-4">{children}</main>
        <PerfTracker />
        <SWRegister />
        </SWRProvider>
      </body>
    </html>
  );
}
