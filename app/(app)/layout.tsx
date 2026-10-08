import { AppShell } from "@/components/app-shell";
import { AuthProvider } from "@/components/auth/auth-provider";
import { getProfile, requireUser } from "@/lib/auth/dal";

// Every route in this group requires a signed-in user. The proxy redirects
// visitors early; this check is the authoritative one, made against Supabase.
export default async function AppLayout({ children }: Readonly<{ children: React.ReactNode }>) {
  const user = await requireUser();
  const profile = await getProfile();

  return (
    <AuthProvider profile={profile} user={user}>
      <AppShell>{children}</AppShell>
    </AuthProvider>
  );
}
