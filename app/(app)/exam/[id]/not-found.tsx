import Link from "next/link";

export default function ExamNotFound() {
  return (
    <div className="dashboard library-page">
      <div className="library-empty">
        <div aria-hidden="true" className="empty-illustration"><span>?</span></div>
        <strong>We couldn&apos;t find that exam.</strong>
        <p>It may have been deleted, or the link may be wrong.</p>
        <Link className="action-button" href="/exam">Back to exam mode</Link>
      </div>
    </div>
  );
}
