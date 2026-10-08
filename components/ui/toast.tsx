"use client";

import { createContext, useCallback, useContext, useEffect, useState, type ReactNode } from "react";

type Toast = { id: number; tone: "success" | "error"; text: string };

const ToastContext = createContext<((text: string, tone?: Toast["tone"]) => void) | null>(null);

const VISIBLE_MS = 4500;

export function ToastProvider({ children }: { children: ReactNode }) {
  const [toast, setToast] = useState<Toast | null>(null);

  const show = useCallback((text: string, tone: Toast["tone"] = "success") => {
    setToast({ id: Date.now(), tone, text });
  }, []);

  useEffect(() => {
    if (!toast) return;
    const timer = window.setTimeout(() => setToast(null), VISIBLE_MS);
    return () => window.clearTimeout(timer);
  }, [toast]);

  return (
    <ToastContext.Provider value={show}>
      {children}
      {/* Always rendered so screen readers announce changes to its contents. */}
      <div aria-live="polite" className="toast-region" role="status">
        {toast && (
          <div className={`toast ${toast.tone}`} key={toast.id}>
            <span aria-hidden="true">{toast.tone === "success" ? "✓" : "!"}</span>
            {toast.text}
          </div>
        )}
      </div>
    </ToastContext.Provider>
  );
}

export function useToast() {
  const show = useContext(ToastContext);
  if (!show) throw new Error("useToast must be used inside ToastProvider.");
  return show;
}
