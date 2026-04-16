// GET /api/debug/notifications
//
// Diagnostic endpoint: checks every layer of the notification pipeline
// and returns a structured report. Auth-gated (requires active session).
// No Spotify calls — pure DB reads.

import { NextResponse } from "next/server";
import { prisma } from "@/lib/db";
import { getCurrentUser } from "@/lib/session";

export const dynamic = "force-dynamic";

export async function GET() {
  const user = await getCurrentUser();
  if (!user) return NextResponse.json({ error: "unauth" }, { status: 401 });

  const [playlists, pushSubs, recentPollLogs] = await Promise.all([
    prisma.playlist.findMany({
      where: { userId: user.id },
      orderBy: { createdAt: "asc" },
      include: { _count: { select: { tracks: true } } },
    }),
    prisma.pushSubscription.findMany({
      where: { userId: user.id },
      select: {
        id: true,
        endpoint: true,
        createdAt: true,
      },
    }),
    prisma.pollLog.findMany({
      where: {
        playlist: { userId: user.id },
      },
      orderBy: { startedAt: "desc" },
      take: 30,
      select: {
        playlistId: true,
        startedAt: true,
        durationMs: true,
        newTracks: true,
        error: true,
        playlist: { select: { name: true, spotifyId: true } },
      },
    }),
  ]);

  const report = {
    user: {
      id: user.id,
      spotifyId: user.spotifyId,
      displayName: user.displayName,
    },
    pushSubscriptions: {
      count: pushSubs.length,
      devices: pushSubs.map((s) => ({
        id: s.id,
        endpoint: s.endpoint.slice(0, 80) + "...",
        createdAt: s.createdAt.toISOString(),
      })),
      verdict: pushSubs.length === 0
        ? "NO_SUBSCRIPTIONS — notifications cannot be delivered. Go to Settings and click 'Enable on this device' on each device."
        : `${pushSubs.length} subscription(s) active.`,
    },
    playlists: playlists.map((p) => ({
      name: p.name,
      spotifyId: p.spotifyId,
      status: p.status,
      notifyEnabled: p.notifyEnabled,
      snapshotId: p.snapshotId ? `${p.snapshotId.slice(0, 20)}...` : null,
      isFirstSeed: !p.snapshotId,
      lastCheckedAt: p.lastCheckedAt?.toISOString() ?? null,
      trackCount: p._count.tracks,
      imageBackfillAt: p.imageBackfillAt?.toISOString() ?? null,
      issues: [
        !p.notifyEnabled && "NOTIFY_DISABLED — toggle on in Settings",
        !p.snapshotId && "FIRST_SEED — no snapshotId yet, first poll will suppress notifications",
        p.status !== "active" && `STATUS_${p.status.toUpperCase()} — playlist not being polled`,
      ].filter(Boolean),
    })),
    recentPolls: recentPollLogs.map((l) => ({
      playlist: l.playlist?.name ?? "(deleted)",
      spotifyId: l.playlist?.spotifyId ?? null,
      at: l.startedAt.toISOString(),
      durationMs: l.durationMs,
      newTracks: l.newTracks,
      error: l.error ?? null,
    })),
    diagnosis: [] as string[],
  };

  // Auto-diagnose
  if (pushSubs.length === 0) {
    report.diagnosis.push(
      "CRITICAL: No push subscriptions found. The server has nowhere to send notifications. " +
      "Visit /settings and click 'Enable on this device' on each browser/device you want notifications on."
    );
  }

  for (const p of report.playlists) {
    if (p.issues.length > 0) {
      report.diagnosis.push(`Playlist "${p.name}": ${p.issues.join(", ")}`);
    }
  }

  const pollsWithNewTracks = report.recentPolls.filter((l) => l.newTracks > 0);
  if (pollsWithNewTracks.length === 0) {
    report.diagnosis.push(
      "No recent polls detected new tracks. Possible causes: " +
      "snapshot short-circuit (tracks already seen), or tracks were added before the playlist was first polled (first-seed silence)."
    );
  }

  const pollErrors = report.recentPolls.filter((l) => l.error);
  if (pollErrors.length > 0) {
    report.diagnosis.push(
      `${pollErrors.length} recent poll(s) had errors. Check recentPolls for details.`
    );
  }

  if (report.diagnosis.length === 0) {
    report.diagnosis.push("No obvious issues found. Check Vercel function logs for detailed poll output.");
  }

  return NextResponse.json(report, {
    headers: { "Cache-Control": "no-store" },
  });
}
