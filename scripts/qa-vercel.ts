// Vercel deploy inspector. Used by the agent loop when a deploy
// fails or behaves unexpectedly — gh status checks tell you "FAILURE"
// but not "why". This script hits the Vercel API directly with the
// VERCEL_TOKEN env var.
//
//   npm run qa:vercel              # latest production deploy
//   npm run qa:vercel -- recent    # last 10 deploys with status
//   npm run qa:vercel -- logs      # build log from latest failed deploy
//
// Read-only. No deploy mutations. The token only needs read scope.

const TOKEN = process.env.VERCEL_TOKEN;
if (!TOKEN) {
  console.error(
    "[qa:vercel] VERCEL_TOKEN env var not set. Generate one at\n" +
      "  https://vercel.com/account/tokens",
  );
  process.exit(1);
}

const TEAM_ID = "team_9JfOoHBxipUOQJLJ31WSRwk2";
const PROJECT_ID = "prj_uVxNwtPpksHyEvwYiDNf1pmnwMy6";
const BASE = "https://api.vercel.com";

interface VercelDeployment {
  uid: string;
  url: string;
  state: string;
  readyState: string;
  type: string;
  created: number;
  target: string | null;
  inspectorUrl?: string;
  meta?: { githubCommitMessage?: string; githubCommitSha?: string };
}

async function api<T>(path: string): Promise<T> {
  const sep = path.includes("?") ? "&" : "?";
  const res = await fetch(`${BASE}${path}${sep}teamId=${TEAM_ID}`, {
    headers: { Authorization: `Bearer ${TOKEN}` },
  });
  if (!res.ok) {
    throw new Error(`${res.status} ${res.statusText} on ${path}`);
  }
  return (await res.json()) as T;
}

function ago(epochMs: number): string {
  const d = Date.now() - epochMs;
  const m = Math.round(d / 60000);
  if (m < 60) return `${m}m ago`;
  return `${Math.round(m / 60)}h ago`;
}

async function showLatest() {
  const data = await api<{ deployments: VercelDeployment[] }>(
    `/v6/deployments?projectId=${PROJECT_ID}&target=production&limit=1`,
  );
  const d = data.deployments?.[0];
  if (!d) {
    console.log("No production deployments found.");
    return;
  }
  const sha = d.meta?.githubCommitSha?.slice(0, 7) ?? "?";
  console.log(`latest production deploy:`);
  console.log(`  state:     ${d.state} (${d.readyState})`);
  console.log(`  age:       ${ago(d.created)}`);
  console.log(`  url:       https://${d.url}`);
  console.log(`  commit:    ${sha} ${d.meta?.githubCommitMessage ?? ""}`);
  console.log(`  inspector: ${d.inspectorUrl ?? `https://vercel.com/${TEAM_ID}/${PROJECT_ID}/${d.uid}`}`);
}

async function showRecent() {
  const data = await api<{ deployments: VercelDeployment[] }>(
    `/v6/deployments?projectId=${PROJECT_ID}&limit=10`,
  );
  console.log(`recent deployments:`);
  for (const d of data.deployments ?? []) {
    const sha = d.meta?.githubCommitSha?.slice(0, 7) ?? "?";
    const tgt = d.target ?? "preview";
    console.log(
      `  ${d.state.padEnd(8)} ${tgt.padEnd(10)} ${sha}  ${ago(d.created)}  ${(d.meta?.githubCommitMessage ?? "").slice(0, 60)}`,
    );
  }
}

async function showLogs() {
  // Find the latest failed or errored deployment.
  const data = await api<{ deployments: VercelDeployment[] }>(
    `/v6/deployments?projectId=${PROJECT_ID}&limit=20`,
  );
  const failed = data.deployments?.find(
    (d) => d.state === "ERROR" || d.readyState === "ERROR",
  );
  if (!failed) {
    console.log("No failed deployments in the last 20 — nothing to log.");
    return;
  }
  console.log(`build logs from ${failed.uid} (${ago(failed.created)}):`);
  // Vercel returns logs via /v3/deployments/{id}/events, line-streamed.
  const res = await fetch(
    `${BASE}/v3/deployments/${failed.uid}/events?teamId=${TEAM_ID}&direction=forward&limit=300`,
    { headers: { Authorization: `Bearer ${TOKEN}` } },
  );
  if (!res.ok) {
    console.error(`logs fetch ${res.status}: ${await res.text()}`);
    return;
  }
  const events = (await res.json()) as Array<{
    type: string;
    text?: string;
    payload?: { text?: string };
    created?: number;
  }>;
  for (const ev of events) {
    const t = ev.text ?? ev.payload?.text;
    if (!t) continue;
    process.stdout.write(t.endsWith("\n") ? t : t + "\n");
  }
}

const subcommand = process.argv[2] ?? "latest";
const dispatch: Record<string, () => Promise<void>> = {
  latest: showLatest,
  recent: showRecent,
  logs: showLogs,
};
const fn = dispatch[subcommand];
if (!fn) {
  console.error(`unknown subcommand: ${subcommand}. options: ${Object.keys(dispatch).join(", ")}`);
  process.exit(1);
}
fn().catch((e) => {
  console.error(e instanceof Error ? e.message : e);
  process.exit(1);
});
