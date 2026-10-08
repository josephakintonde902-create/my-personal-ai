"use client";

import { useEffect, useState } from "react";

type InstallPromptEvent = Event & {
  prompt: () => Promise<void>;
  userChoice: Promise<{ outcome: "accepted" | "dismissed"; platform: string }>;
};

const DISMISSED_KEY = "ari-install-dismissed";

export function InstallPrompt() {
  const [installEvent, setInstallEvent] = useState<InstallPromptEvent | null>(null);
  const [showIosHelp, setShowIosHelp] = useState(false);
  const [isDismissed, setIsDismissed] = useState(true);
  const [isIos, setIsIos] = useState(false);

  useEffect(() => {
    queueMicrotask(() => {
      setIsDismissed(window.localStorage.getItem(DISMISSED_KEY) === "true");

      const ios =
        /iphone|ipad|ipod/i.test(window.navigator.userAgent) &&
        !("standalone" in window.navigator && window.navigator.standalone);
      const ipad =
        window.navigator.platform === "MacIntel" && window.navigator.maxTouchPoints > 1;
      setIsIos(ios || (ipad && !("standalone" in window.navigator && window.navigator.standalone)));
    });

    const handleBeforeInstallPrompt = (event: Event) => {
      event.preventDefault();
      setInstallEvent(event as InstallPromptEvent);
    };
    const handleInstalled = () => {
      setInstallEvent(null);
      setShowIosHelp(false);
      setIsDismissed(true);
    };

    window.addEventListener("beforeinstallprompt", handleBeforeInstallPrompt);
    window.addEventListener("appinstalled", handleInstalled);
    return () => {
      window.removeEventListener("beforeinstallprompt", handleBeforeInstallPrompt);
      window.removeEventListener("appinstalled", handleInstalled);
    };
  }, []);

  const dismiss = () => {
    window.localStorage.setItem(DISMISSED_KEY, "true");
    setIsDismissed(true);
    setShowIosHelp(false);
  };

  const install = async () => {
    if (isIos) {
      setShowIosHelp(true);
      return;
    }
    if (!installEvent) return;

    await installEvent.prompt();
    const choice = await installEvent.userChoice;
    if (choice.outcome === "accepted" || choice.outcome === "dismissed") {
      setIsDismissed(true);
      window.localStorage.setItem(DISMISSED_KEY, "true");
    }
    setInstallEvent(null);
  };

  if (isDismissed || (!installEvent && !isIos)) return null;

  return (
    <aside className="install-banner" aria-label="Install Ari">
      <div className="install-banner-mark" aria-hidden="true">a</div>
      <div className="install-banner-copy">
        <strong>{showIosHelp ? "Add Ari to your Home Screen" : "Install Ari"}</strong>
        <span>
          {showIosHelp
            ? "Tap Share, then choose “Add to Home Screen”."
            : "Get quick access to your AI study tutor from your device."}
        </span>
      </div>
      <div className="install-banner-actions">
        <button className="install-button" onClick={install} type="button">
          {isIos ? "How to install" : "Install"}
        </button>
        <button className="dismiss-button" onClick={dismiss} type="button">
          Not now
        </button>
      </div>
    </aside>
  );
}
