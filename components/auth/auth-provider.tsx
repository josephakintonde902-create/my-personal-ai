"use client";

import { useRouter } from "next/navigation";
import { createContext, useContext, useEffect, useMemo, useState, type ReactNode } from "react";
import type { CurrentUser, Profile } from "@/lib/auth/dal";
import { createClient } from "@/lib/supabase/client";

type AuthContextValue = {
  status: "authenticated" | "unauthenticated";
  user: CurrentUser;
  profile: Profile | null;
};

const AuthContext = createContext<AuthContextValue | null>(null);

type Props = { user: CurrentUser; profile: Profile | null; children: ReactNode };

// The user and profile are resolved on the server before any protected HTML is
// sent, so there is no client-side loading phase and nothing to flash. This
// provider shares that result with client components and reacts if the session
// ends while the app is open (for example, the refresh token is revoked).
export function AuthProvider({ user, profile, children }: Props) {
  const router = useRouter();
  const [signedOut, setSignedOut] = useState(false);

  useEffect(() => {
    const supabase = createClient();
    const { data } = supabase.auth.onAuthStateChange((event) => {
      if (event === "SIGNED_OUT") {
        setSignedOut(true);
        router.replace("/login?notice=session_expired");
      }
    });
    return () => data.subscription.unsubscribe();
  }, [router]);

  const value = useMemo<AuthContextValue>(
    () => ({ status: signedOut ? "unauthenticated" : "authenticated", user, profile }),
    [signedOut, user, profile],
  );

  return (
    <AuthContext.Provider value={value}>
      {signedOut ? <div className="session-ended" role="status">Taking you to sign in…</div> : children}
    </AuthContext.Provider>
  );
}

export function useAuth() {
  const value = useContext(AuthContext);
  if (!value) throw new Error("useAuth must be used inside the authenticated app layout.");
  return value;
}
