// Shared by server and client components.

// "45 s", "12 min 34 s", "1 h 05 min"
export function formatDuration(seconds: number) {
  const minutes = Math.floor(seconds / 60);
  if (minutes >= 60) return `${Math.floor(minutes / 60)} h ${String(minutes % 60).padStart(2, "0")} min`;
  return minutes > 0 ? `${minutes} min ${String(seconds % 60).padStart(2, "0")} s` : `${seconds} s`;
}
