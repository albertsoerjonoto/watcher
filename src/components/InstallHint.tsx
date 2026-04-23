"use client";

import { useEffect, useState } from "react";

export function InstallHint() {
  const [show, setShow] = useState(false);

  useEffect(() => {
    const ua = navigator.userAgent;
    const isIOS = /iPad|iPhone|iPod/.test(ua);
    // @ts-expect-error standalone is iOS-only and not typed on Navigator.
    const standalone = window.navigator.standalone || window.matchMedia("(display-mode: standalone)").matches;
    setShow(isIOS && !standalone);
  }, []);

  if (!show) return null;
  return (
    <div className="rounded-lg border border-amber-300 bg-amber-50 p-3 text-sm text-amber-900 dark:border-amber-700/60 dark:bg-amber-900/20 dark:text-amber-200">
      <strong>iPhone users:</strong> tap the Share icon in Safari then{" "}
      <em>Add to Home Screen</em> and open the app from there. Apple requires
      this before web-push notifications will work (iOS 16.4+).
    </div>
  );
}
