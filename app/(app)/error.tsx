"use client";

// Shown inside the app shell, so navigation stays available when a page fails to load.
export default function AppError({ reset }: { error: Error & { digest?: string }; reset: () => void }) {
  return (
    <div className="dashboard library-page">
      <div className="library-empty">
        <div aria-hidden="true" className="empty-illustration"><span>!</span></div>
        <strong>We couldn&apos;t load this page.</strong>
        <p>Something went wrong on our side. Your subjects and materials are safe.</p>
        <button className="action-button" onClick={reset} type="button">Try again</button>
      </div>
    </div>
  );
}
