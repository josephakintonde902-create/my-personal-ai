"use client";

import Link from "next/link";
import { useState } from "react";
import { useAuth } from "@/components/auth/auth-provider";
import { materialTypeLabel } from "@/components/materials/material-list";
import { MaterialUpload } from "@/components/materials/material-upload";
import { SubjectBadge } from "@/components/subjects/subject-badge";
import type { PerformanceReport } from "@/lib/performance/queries";
import { getFirstName } from "@/lib/auth/display";
import { SUPPORTED_TYPES_LABEL } from "@/lib/library/config";
import { formatFileSize, MAX_FILE_SIZE_LABEL } from "@/lib/library/files";
import { formatDate, materialCountLabel } from "@/lib/library/format";
import type { StudyMaterial, SubjectWithCount } from "@/lib/library/types";

const RECENT_SUBJECTS = 4;

function UploadIcon() {
  return (
    <svg viewBox="0 0 24 24" fill="none" aria-hidden="true">
      <path d="M12 16V4m0 0L7.5 8.5M12 4l4.5 4.5M5 14.5v4A1.5 1.5 0 0 0 6.5 20h11a1.5 1.5 0 0 0 1.5-1.5v-4" />
    </svg>
  );
}

const LEVEL_WORDS = { strong: "Strong", developing: "Developing", needs_review: "Needs review" };

function ExamPrepSection({ performance }: { performance: PerformanceReport }) {
  const { readiness } = performance;
  const best = performance.subjects.filter((subject) => subject.subjectId && subject.level !== null).sort((a, b) => b.tally.accuracy! - a.tally.accuracy!)[0];
  const weakest = performance.weakAreas[0];
  const cards = [
    readiness.score !== null && { href: "/performance", value: `${readiness.score}%`, label: "Exam readiness", note: LEVEL_WORDS[readiness.status!] },
    readiness.pastQuestions.answered > 0 && { href: "/past-questions", value: String(readiness.pastQuestions.answered), label: readiness.pastQuestions.answered === 1 ? "Past question practised" : "Past questions practised", note: `${Math.round(readiness.pastQuestions.accuracy! * 100)}% correct` },
    readiness.exams.latestPercent !== null && { href: "/exam", value: `${readiness.exams.latestPercent}%`, label: "Last exam score", note: `${readiness.exams.completed} ${readiness.exams.completed === 1 ? "exam" : "exams"} taken` },
    best && { href: "/performance", value: `${Math.round(best.tally.accuracy! * 100)}%`, label: "Best subject", note: best.name },
    weakest && { href: "/performance", value: `${Math.round(weakest.tally.accuracy! * 100)}%`, label: "Weakest topic", note: weakest.topic },
  ].filter((card): card is { href: string; value: string; label: string; note: string } => Boolean(card));

  return (
    <section className="lower-section">
      <div className="section-heading lower-heading">
        <div><span aria-hidden="true" className="section-icon plan-icon">◴</span><h2>Exam preparation</h2></div>
        <Link className="text-button" href="/past-questions">Past questions <span aria-hidden="true">→</span></Link>
      </div>
      {cards.length === 0 ? (
        <div className="empty-state">
          <div className="empty-illustration" aria-hidden="true"><span>❖</span></div>
          <div>
            <strong>Practise with real exam questions.</strong>
            <p>Upload a past paper, then practise it or sit it as a timed exam. Your readiness will show here.</p>
          </div>
          <Link className="secondary-button" href="/past-questions">Add past questions <span aria-hidden="true">↗</span></Link>
        </div>
      ) : (
        <div className="stat-row exam-prep">
          {cards.map((card) => (
            <Link className="stat-tile" href={card.href} key={card.label}>
              <strong>{card.value}</strong>
              <span>{card.label}</span>
              <em>{card.note}</em>
            </Link>
          ))}
        </div>
      )}
    </section>
  );
}

type Props = {
  subjects: SubjectWithCount[];
  recentMaterials: StudyMaterial[];
  materialCount: number;
  // True when the library could not be loaded; the page still renders.
  loadFailed: boolean;
  // Null when performance could not be loaded; the section is hidden.
  performance: PerformanceReport | null;
};

export function DashboardView({ subjects, recentMaterials, materialCount, loadFailed, performance }: Props) {
  const { profile } = useAuth();
  const firstName = getFirstName(profile?.full_name);
  const [uploading, setUploading] = useState(false);

  const subjectNames = new Map(subjects.map((subject) => [subject.id, subject.name]));
  const recentSubjects = [...subjects]
    .sort((a, b) => b.updated_at.localeCompare(a.updated_at))
    .slice(0, RECENT_SUBJECTS);

  return (
    <div className="dashboard">
      <div className="welcome-row">
        <div>
          <p className="eyebrow"><span className="sun-dot" /> A FRESH START</p>
          <h1>Good to see you{firstName && `, ${firstName}`}<span className="heading-comma">.</span></h1>
          <p className="welcome-subtitle">A little progress each day adds up. What are we learning?</p>
        </div>
        <div className="date-chip"><span aria-hidden="true">◷</span> Your next great idea starts here</div>
      </div>

      {loadFailed && (
        <div className="form-message error" role="alert">
          We couldn&apos;t load your library just now. Refresh the page to try again.
        </div>
      )}

      <div className="content-grid">
        <section className="tutor-card">
          <div className="card-orbit orbit-one" />
          <div className="card-orbit orbit-two" />
          <div className="tutor-card-content">
            <div className="tutor-kicker"><span className="sparkle">✳</span> YOUR AI STUDY PARTNER</div>
            <h2>Big questions?<br /><span>Let&apos;s figure them out.</span></h2>
            <p>Explore a tricky topic, get a concept explained, or make a plan for what to study next.</p>
            <Link className="primary-button" href="/tutor">Meet your tutor <span aria-hidden="true">↗</span></Link>
          </div>
          <div className="tutor-art" aria-hidden="true">
            <div className="art-halo" />
            <div className="art-spark spark-a">✳</div>
            <div className="art-spark spark-b">✦</div>
            <div className="art-orb"><span>a</span></div>
            <div className="art-dot dot-a" /><div className="art-dot dot-b" />
          </div>
        </section>

        <section className="upload-card">
          <div className="section-heading">
            <div><span className="section-icon library-icon">▤</span><h2>Your library</h2></div>
            <Link className="text-button" href="/materials">View all <span aria-hidden="true">→</span></Link>
          </div>
          <div className="stat-row">
            <Link className="stat-tile" href="/subjects">
              <strong>{subjects.length}</strong>
              <span>{subjects.length === 1 ? "Subject" : "Subjects"}</span>
            </Link>
            <Link className="stat-tile" href="/materials">
              <strong>{materialCount}</strong>
              <span>{materialCount === 1 ? "Study material" : "Study materials"}</span>
            </Link>
          </div>
          <button className="upload-dropzone compact" type="button" onClick={() => setUploading(true)}>
            <span className="upload-icon"><UploadIcon /></span>
            <strong>Bring your study materials</strong>
            <span className="file-types">{SUPPORTED_TYPES_LABEL} up to {MAX_FILE_SIZE_LABEL}</span>
          </button>
          <p className="privacy-note"><span aria-hidden="true">⌑</span> Your materials stay private to you.</p>
        </section>
      </div>

      {performance && (
        <section className="lower-section">
          <div className="section-heading lower-heading">
            <div><span aria-hidden="true" className="section-icon plan-icon">✓</span><h2>Your progress</h2></div>
            <Link className="text-button" href="/performance">See performance <span aria-hidden="true">→</span></Link>
          </div>
          <div className="stat-row four">
            <Link className="stat-tile" href="/performance">
              <strong>{performance.overall.accuracy === null ? "—" : `${Math.round(performance.overall.accuracy * 100)}%`}</strong>
              <span>Overall accuracy</span>
              {performance.overall.accuracy === null && <em>Take a quiz to see this</em>}
            </Link>
            <Link className="stat-tile" href="/quizzes">
              <strong>{performance.quizzesCompleted}</strong>
              <span>{performance.quizzesCompleted === 1 ? "Quiz completed" : "Quizzes completed"}</span>
            </Link>
            <Link className="stat-tile" href="/performance">
              <strong>{performance.overall.attempted}</strong>
              <span>{performance.overall.attempted === 1 ? "Question practised" : "Questions practised"}</span>
            </Link>
            <Link className="stat-tile" href="/performance">
              <strong>{performance.hasQuizData ? performance.weakAreas.length : "—"}</strong>
              <span>{performance.weakAreas.length === 1 ? "Topic needs review" : "Topics need review"}</span>
              {performance.weakAreas[0] && <em>{performance.weakAreas[0].topic}</em>}
            </Link>
          </div>
        </section>
      )}

      {/* Exam preparation: each card appears only once there is something
          real to put in it. A new student sees one line pointing the way. */}
      {performance && <ExamPrepSection performance={performance} />}

      <section className="lower-section" id="ask-ari">
        <div className="section-heading lower-heading">
          <div><span className="section-icon plan-icon">✧</span><h2>Recently uploaded</h2></div>
          <span className="quiet-label">YOUR STUDY SPACE</span>
        </div>
        {recentMaterials.length === 0 ? (
          <div className="empty-state">
            <div className="empty-illustration" aria-hidden="true"><span>✳</span><i>·</i></div>
            <div>
              <strong>Your library is a blank page.</strong>
              <p>{subjects.length === 0 ? "Create a subject, then add your first study material." : "Add your first study material to get started."}</p>
            </div>
            {subjects.length === 0 ? (
              <Link className="secondary-button" href="/subjects">Create a subject <span aria-hidden="true">↗</span></Link>
            ) : (
              <button className="secondary-button" onClick={() => setUploading(true)} type="button">Upload material <span aria-hidden="true">↗</span></button>
            )}
          </div>
        ) : (
          <ul className="recent-list">
            {recentMaterials.map((material) => (
              <li key={material.id}>
                <Link className="recent-item" href={`/subjects/${material.subject_id}`}>
                  <span aria-hidden="true" className="file-chip">{materialTypeLabel(material)}</span>
                  <span className="recent-copy">
                    <strong>{material.title}</strong>
                    <span>
                      {subjectNames.get(material.subject_id) ?? "Subject"} <i>·</i> {formatFileSize(material.file_size)} <i>·</i> {formatDate(material.created_at)}
                    </span>
                  </span>
                </Link>
              </li>
            ))}
          </ul>
        )}
      </section>

      {recentSubjects.length > 0 && (
        <section className="lower-section">
          <div className="section-heading lower-heading">
            <div><span className="section-icon library-icon">▤</span><h2>Recent subjects</h2></div>
            <Link className="text-button" href="/subjects">All subjects <span aria-hidden="true">→</span></Link>
          </div>
          <ul className="recent-list columns">
            {recentSubjects.map((subject) => (
              <li key={subject.id}>
                <Link className="recent-item" href={`/subjects/${subject.id}`}>
                  <SubjectBadge color={subject.color} icon={subject.icon} name={subject.name} size="sm" />
                  <span className="recent-copy">
                    <strong>{subject.name}</strong>
                    <span>{materialCountLabel(subject.material_count)}</span>
                  </span>
                </Link>
              </li>
            ))}
          </ul>
        </section>
      )}

      <footer className="dashboard-footer">
        <span>Small steps. Big understanding.</span>
        <span>ARI <i>·</i> BUILT BY PALADIN</span>
      </footer>

      {uploading && <MaterialUpload onClose={() => setUploading(false)} subjects={subjects} />}
    </div>
  );
}
