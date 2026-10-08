"use client";

import { useEffect } from "react";

export function ServiceWorkerRegistration() {
  useEffect(() => {
    if (!("serviceWorker" in navigator)) return;

    // Production only. In development a cache-first worker keeps serving old
    // JavaScript while the code changes underneath it, so the browser runs a
    // different app from the one the server rendered. A worker installed by
    // an earlier visit does not go away on its own: remove it and its cache.
    if (process.env.NODE_ENV !== "production") {
      void navigator.serviceWorker.getRegistrations().then(async (registrations) => {
        if (registrations.length === 0) return;
        await Promise.all(registrations.map((registration) => registration.unregister()));
        const names = await caches.keys();
        await Promise.all(names.filter((name) => name.startsWith("ari-static-")).map((name) => caches.delete(name)));
        // The page that is open was built from the stale copy: load the real one.
        window.location.reload();
      });
      return;
    }

    navigator.serviceWorker.register("/sw.js", { scope: "/" }).catch((error: unknown) => {
      console.error("Ari service worker registration failed.", error);
    });
  }, []);

  return null;
}
