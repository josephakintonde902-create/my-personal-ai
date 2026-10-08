import Link from "next/link";

export default function AuthLayout({ children }: Readonly<{ children: React.ReactNode }>) {
  return (
    <main className="auth-shell">
      <aside className="auth-aside">
        <div className="card-orbit orbit-one" />
        <div className="card-orbit orbit-two" />
        <Link aria-label="Ari home" className="brand auth-brand" href="/">
          <span aria-hidden="true" className="ari-mark">a</span>
          <span>ari<span className="brand-period">.</span></span>
        </Link>
        <div className="auth-aside-copy">
          <div className="tutor-kicker"><span className="sparkle">✳</span> YOUR AI STUDY TUTOR</div>
          <h2>Big questions?<br /><span>Let&apos;s figure them out.</span></h2>
          <p>Your materials, your pace, and a tutor that remembers where you left off.</p>
        </div>
        <div aria-hidden="true" className="auth-aside-art">
          <div className="art-halo" />
          <div className="art-spark spark-a">✳</div>
          <div className="art-spark spark-b">✦</div>
          <div className="art-orb"><span>a</span></div>
        </div>
        <div className="auth-aside-footer">Small steps. Big understanding. <span>·</span> Built by Paladin</div>
      </aside>

      <section className="auth-main">
        <Link aria-label="Ari home" className="brand auth-brand-mobile" href="/">
          <span aria-hidden="true" className="ari-mark">a</span>
          <span>ari<span className="brand-period">.</span></span>
        </Link>
        <div className="auth-card">{children}</div>
        <p className="auth-footer">ARI <i>·</i> YOUR AI STUDY TUTOR <i>·</i> BUILT BY PALADIN</p>
      </section>
    </main>
  );
}
