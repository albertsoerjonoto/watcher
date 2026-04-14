"use client";

import { useState } from "react";

function urlBase64ToUint8Array(base64String: string): Uint8Array {
  const padding = "=".repeat((4 - (base64String.length % 4)) % 4);
  const base64 = (base64String + padding).replace(/-/g, "+").replace(/_/g, "/");
  const raw = atob(base64);
  const output = new Uint8Array(raw.length);
  for (let i = 0; i < raw.length; i++) output[i] = raw.charCodeAt(i);
  return output;
}

export function EnablePush() {
  const [status, setStatus] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  async function enable() {
    setBusy(true);
    setStatus(null);
    try {
      if (!("serviceWorker" in navigator) || !("PushManager" in window)) {
        throw new Error("Push not supported in this browser.");
      }
      const reg = await navigator.serviceWorker.register("/sw.js");
      await navigator.serviceWorker.ready;

      const permission = await Notification.requestPermission();
      if (permission !== "granted") {
        throw new Error("Notification permission denied.");
      }

      const vapidRes = await fetch("/api/push/vapid");
      const { publicKey } = await vapidRes.json();
      if (!publicKey) throw new Error("Server missing VAPID public key");

      const key = urlBase64ToUint8Array(publicKey);
      const sub = await reg.pushManager.subscribe({
        userVisibleOnly: true,
        applicationServerKey: key.buffer.slice(
          key.byteOffset,
          key.byteOffset + key.byteLength,
        ) as ArrayBuffer,
      });

      const res = await fetch("/api/push/subscribe", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(sub.toJSON()),
      });
      if (!res.ok) throw new Error("Failed to register subscription");
      setStatus("Subscribed. Tap “Send test” to verify.");
    } catch (err) {
      setStatus(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(false);
    }
  }

  async function test() {
    setBusy(true);
    setStatus(null);
    try {
      const res = await fetch("/api/push/subscribe", { method: "PUT" });
      const body = await res.json();
      setStatus(`Test: sent=${body.sent} pruned=${body.pruned}`);
    } catch (err) {
      setStatus(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="space-y-2">
      <div className="flex gap-2">
        <button
          onClick={enable}
          disabled={busy}
          className="rounded bg-spotify px-3 py-1 text-sm font-semibold text-black disabled:opacity-50"
        >
          Enable on this device
        </button>
        <button
          onClick={test}
          disabled={busy}
          className="rounded border border-neutral-700 px-3 py-1 text-sm disabled:opacity-50"
        >
          Send test
        </button>
      </div>
      {status && <p className="text-xs text-neutral-400">{status}</p>}
    </div>
  );
}
