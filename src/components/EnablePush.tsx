"use client";

import { useEffect, useState } from "react";
import { useRouter } from "next/navigation";

function urlBase64ToUint8Array(base64String: string): Uint8Array {
  const padding = "=".repeat((4 - (base64String.length % 4)) % 4);
  const base64 = (base64String + padding).replace(/-/g, "+").replace(/_/g, "/");
  const raw = atob(base64);
  const output = new Uint8Array(raw.length);
  for (let i = 0; i < raw.length; i++) output[i] = raw.charCodeAt(i);
  return output;
}

export function EnablePush() {
  const router = useRouter();
  const [status, setStatus] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  // Client-side view of whether THIS device currently has an active
  // push subscription. The server-rendered "N device(s) subscribed"
  // counts across all devices, which is useful but doesn't tell the
  // user whether *this* browser is one of them.
  const [subscribedHere, setSubscribedHere] = useState<boolean | null>(null);

  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        if (!("serviceWorker" in navigator) || !("PushManager" in window)) {
          if (!cancelled) setSubscribedHere(false);
          return;
        }
        const reg = await navigator.serviceWorker.getRegistration();
        const sub = await reg?.pushManager.getSubscription();
        if (!cancelled) setSubscribedHere(!!sub);
      } catch {
        if (!cancelled) setSubscribedHere(false);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, []);

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
      setSubscribedHere(true);
      setStatus("Subscribed. Tap “Send test” to verify.");
      // Re-fetch the RSC so the "N device(s) subscribed" count
      // updates without a hard reload.
      router.refresh();
    } catch (err) {
      setStatus(err instanceof Error ? err.message : String(err));
      setSubscribedHere(false);
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
      // Pruned means dead subscriptions were deleted — refresh the
      // count so the UI reflects reality.
      if (body.pruned > 0) router.refresh();
    } catch (err) {
      setStatus(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="space-y-2">
      {subscribedHere === null && (
        <p className="text-xs text-neutral-500 dark:text-neutral-600">Checking subscription...</p>
      )}
      {subscribedHere === true && (
        <p className="text-xs text-spotify">
          ✓ This device is subscribed.
        </p>
      )}
      {subscribedHere === false && (
        <p className="text-xs text-neutral-500">
          This device is not subscribed yet.
        </p>
      )}
      <div className="flex gap-2">
        <button
          onClick={enable}
          disabled={busy}
          className="rounded bg-spotify px-3 py-1 text-sm font-semibold text-black disabled:opacity-50"
        >
          {subscribedHere ? "Re-enable" : "Enable on this device"}
        </button>
        <button
          onClick={test}
          disabled={busy || subscribedHere !== true}
          className="rounded border border-neutral-300 px-3 py-1 text-sm disabled:opacity-50 dark:border-neutral-700"
        >
          Send test
        </button>
      </div>
      {status && <p className="text-xs text-neutral-500 dark:text-neutral-400">{status}</p>}
    </div>
  );
}
