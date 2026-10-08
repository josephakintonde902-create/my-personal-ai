import type { Metadata } from "next";
import { ProfileForm } from "@/components/settings/profile-form";

export const metadata: Metadata = { title: "Settings — Ari" };

export default function SettingsPage() {
  return (
    <div className="dashboard settings-page">
      <div className="welcome-row">
        <div>
          <p className="eyebrow"><span className="sun-dot" /> YOUR ACCOUNT</p>
          <h1>Settings<span className="heading-comma">.</span></h1>
          <p className="welcome-subtitle">Manage how you appear in Ari.</p>
        </div>
      </div>

      <section className="settings-card" id="profile">
        <div className="section-heading">
          <div><span className="section-icon library-icon">☺</span><h2>Profile</h2></div>
        </div>
        <ProfileForm />
      </section>

      <footer className="dashboard-footer">
        <span>Small steps. Big understanding.</span>
        <span>ARI <i>·</i> BUILT BY PALADIN</span>
      </footer>
    </div>
  );
}
