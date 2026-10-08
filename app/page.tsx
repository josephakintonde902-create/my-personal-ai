import { redirect } from "next/navigation";
import { getCurrentUser } from "@/lib/auth/dal";

// The Phase 1 dashboard now lives at /dashboard, behind authentication.
export default async function Home() {
  const user = await getCurrentUser();
  redirect(user ? "/dashboard" : "/login");
}
