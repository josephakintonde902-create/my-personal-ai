// Shown inside the app shell while a page's data is loading, so moving
// between sections always gives immediate feedback instead of a page that
// appears not to have responded.
export default function Loading() {
  return (
    <div className="dashboard library-page">
      <div className="page-loading" role="status">
        <span aria-hidden="true" className="spinner dark" />
        <span>Loading…</span>
      </div>
    </div>
  );
}
