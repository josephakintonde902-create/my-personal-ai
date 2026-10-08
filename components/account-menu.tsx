"use client";

import Link from "next/link";
import { useEffect, useRef, useState } from "react";
import { useFormStatus } from "react-dom";
import { signOut } from "@/app/(auth)/actions";
import { getDisplayName, getInitials } from "@/lib/auth/display";
import { useAuth } from "./auth/auth-provider";

export function UserAvatar({ size = "md" }: { size?: "md" | "lg" }) {
  const { user, profile } = useAuth();

  return (
    <span className={`avatar${size === "lg" ? " avatar-lg" : ""}`}>
      {profile?.avatar_url ? (
        // eslint-disable-next-line @next/next/no-img-element -- small user-uploaded image served from Supabase Storage
        <img alt="" src={profile.avatar_url} />
      ) : (
        getInitials(profile?.full_name, user.email)
      )}
    </span>
  );
}

export function AccountMenu({ variant }: { variant: "sidebar" | "topbar" }) {
  const { user, profile } = useAuth();
  const [open, setOpen] = useState(false);
  const container = useRef<HTMLDivElement>(null);
  const name = getDisplayName(profile?.full_name, user.email);

  useEffect(() => {
    if (!open) return;

    const handlePointer = (event: PointerEvent) => {
      if (!container.current?.contains(event.target as Node)) setOpen(false);
    };
    const handleKey = (event: KeyboardEvent) => {
      if (event.key === "Escape") setOpen(false);
    };

    document.addEventListener("pointerdown", handlePointer);
    document.addEventListener("keydown", handleKey);
    return () => {
      document.removeEventListener("pointerdown", handlePointer);
      document.removeEventListener("keydown", handleKey);
    };
  }, [open]);

  return (
    <div className={`account-menu ${variant}`} ref={container}>
      <button
        aria-expanded={open}
        aria-haspopup="menu"
        aria-label={variant === "topbar" ? `Account menu for ${name}` : undefined}
        className={variant === "sidebar" ? "profile" : "topbar-account"}
        onClick={() => setOpen((current) => !current)}
        type="button"
      >
        <UserAvatar />
        {variant === "sidebar" && (
          <>
            <span className="profile-copy"><strong>{name}</strong><span>{user.email}</span></span>
            <span aria-hidden="true" className="profile-more">···</span>
          </>
        )}
      </button>

      {open && (
        <div className="account-dropdown" role="menu">
          <div className="account-dropdown-user">
            <strong>{name}</strong>
            <span>{user.email}</span>
          </div>
          <Link href="/settings#profile" onClick={() => setOpen(false)} role="menuitem">Profile</Link>
          <Link href="/settings" onClick={() => setOpen(false)} role="menuitem">Settings</Link>
          <form action={signOut}>
            <LogoutButton />
          </form>
        </div>
      )}
    </div>
  );
}

function LogoutButton() {
  const { pending } = useFormStatus();

  return (
    <button aria-busy={pending} className="logout-item" disabled={pending} role="menuitem" type="submit">
      {pending && <span aria-hidden="true" className="spinner dark" />}
      {pending ? "Logging out…" : "Log out"}
    </button>
  );
}
