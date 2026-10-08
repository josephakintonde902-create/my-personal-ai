"use client";

export default function Error({ reset }: { error: Error & { digest?: string }; reset: () => void }) {
  return (
    <main className="error-screen">
      <span aria-hidden="true" className="ari-mark">a</span>
      <h1>Something went wrong</h1>
      <p>Ari hit an unexpected problem. Your work is safe. Please try again.</p>
      <button className="auth-submit" onClick={reset} type="button">Try again</button>
    </main>
  );
}
