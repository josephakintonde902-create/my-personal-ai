"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import type { ReactNode } from "react";
import { AccountMenu } from "./account-menu";
import { ToastProvider } from "./ui/toast";

// "#" destinations are placeholders until those sections are built.
// `mobile` marks the items shown in the bottom navigation bar, where `short`
// is used if the label would not fit.
const navItems: { icon: string; label: string; short?: string; href: string; mobile: boolean }[] = [
  { icon: "⌂", label: "Home", href: "/dashboard", mobile: true },
  { icon: "▦", label: "Subjects", href: "/subjects", mobile: true },
  { icon: "▤", label: "My library", href: "/materials", mobile: true },
  { icon: "✧", label: "AI Tutor", href: "/tutor", mobile: true },
  { icon: "✓", label: "Quizzes", href: "/quizzes", mobile: true },
  { icon: "❏", label: "Flashcards", href: "/flashcards", mobile: true },
  { icon: "❖", label: "Past questions", short: "Past Qs", href: "/past-questions", mobile: true },
  { icon: "◴", label: "Exam mode", href: "/exam", mobile: false },
  { icon: "◔", label: "Performance", href: "/performance", mobile: false },
  { icon: "◷", label: "Study history", href: "#", mobile: false },
];

const pageTitles: Record<string, string> = {
  "/dashboard": "Home",
  "/subjects": "Subjects",
  "/materials": "My library",
  "/tutor": "AI Tutor",
  "/quizzes": "Quizzes",
  "/flashcards": "Flashcards",
  "/past-questions": "Past questions",
  "/exam": "Exam mode",
  "/performance": "Performance",
  "/settings": "Settings",
};

function isActive(href: string, pathname: string) {
  return pathname === href || pathname.startsWith(`${href}/`);
}

function AriMark() {
  return <span className="ari-mark" aria-hidden="true">a</span>;
}

export function AppShell({ children }: { children: ReactNode }) {
  const pathname = usePathname();
  const pageTitle = Object.entries(pageTitles).find(([href]) => isActive(href, pathname))?.[1] ?? "Home";

  return (
    <main className="app-shell">
      <aside className="sidebar">
        <Link className="brand" href="/dashboard" aria-label="Ari home">
          <AriMark />
          <span>ari<span className="brand-period">.</span></span>
        </Link>

        <div className="workspace-label">WORKSPACE</div>
        <nav className="side-nav" aria-label="Main navigation">
          {navItems.map((item) => (
            <Link className={`nav-item${isActive(item.href, pathname) ? " active" : ""}`} href={item.href} key={item.label}>
              <span className="nav-icon" aria-hidden="true">{item.icon}</span>
              {item.label}
              {item.label === "AI Tutor" && <span className="nav-new">NEW</span>}
            </Link>
          ))}
        </nav>

        <div className="sidebar-spacer" />
        <div className="streak-card">
          <div className="streak-icon" aria-hidden="true">✦</div>
          <div><strong>Your streak</strong><span>Start learning today</span></div>
          <span className="streak-count">—</span>
        </div>
        <AccountMenu variant="sidebar" />
        <div className="built-by">Made for curious minds <span>·</span> Built by Paladin</div>
      </aside>

      <section className="main-panel">
        <header className="topbar">
          <div className="breadcrumb">Workspace <span>/</span> <strong>{pageTitle}</strong></div>
          <div className="topbar-right">
            <span className="today-label">Your learning space</span>
            <button className="help-button" type="button" aria-label="Help">?</button>
            <AccountMenu variant="topbar" />
          </div>
        </header>

        <ToastProvider>{children}</ToastProvider>
      </section>

      <nav className="mobile-nav" aria-label="Mobile navigation">
        {navItems.filter((item) => item.mobile).map((item) => (
          <Link className={`mobile-nav-item${isActive(item.href, pathname) ? " active" : ""}`} href={item.href} key={item.label}>
            <span aria-hidden="true">{item.icon}</span>{item.short ?? item.label}
          </Link>
        ))}
      </nav>
    </main>
  );
}
