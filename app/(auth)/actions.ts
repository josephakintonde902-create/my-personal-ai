"use server";

import { revalidatePath } from "next/cache";
import { cookies, headers } from "next/headers";
import { redirect } from "next/navigation";
import { friendlyAuthError } from "@/lib/auth/errors";
import { safeNextPath } from "@/lib/auth/routes";
import {
  formPassword,
  formText,
  validateConfirmPassword,
  validateEmail,
  validateFullName,
  validatePassword,
} from "@/lib/auth/validation";
import { SESSION_ONLY_COOKIE } from "@/lib/supabase/config";
import { createClient } from "@/lib/supabase/server";

export type AuthFormState = {
  status: "idle" | "error" | "success";
  message?: string;
  fieldErrors?: Record<string, string | undefined>;
  // Echoed back so fields keep their contents after a failed submit. Never includes passwords.
  values?: Record<string, string>;
  // Set when the account exists but its email is still unverified.
  unverifiedEmail?: string;
};

function hasErrors(fieldErrors: Record<string, string | undefined>) {
  return Object.values(fieldErrors).some(Boolean);
}

async function getSiteUrl() {
  if (process.env.NEXT_PUBLIC_SITE_URL) return process.env.NEXT_PUBLIC_SITE_URL.replace(/\/$/, "");

  const headerList = await headers();
  const origin = headerList.get("origin");
  if (origin) return origin;

  const host = headerList.get("x-forwarded-host") ?? headerList.get("host");
  const protocol = headerList.get("x-forwarded-proto") ?? "https";
  return `${protocol}://${host}`;
}

async function callbackUrl(next: string) {
  return `${await getSiteUrl()}/auth/callback?next=${encodeURIComponent(next)}`;
}

export async function signIn(_previous: AuthFormState, formData: FormData): Promise<AuthFormState> {
  const email = formText(formData, "email").toLowerCase();
  const password = formPassword(formData, "password");
  const remember = formData.get("remember") === "on";
  const values = { email };

  const fieldErrors = {
    email: validateEmail(email),
    password: password ? undefined : "Enter your password.",
  };
  if (hasErrors(fieldErrors)) return { status: "error", fieldErrors, values };

  const cookieStore = await cookies();
  if (remember) {
    cookieStore.delete(SESSION_ONLY_COOKIE);
  } else {
    cookieStore.set(SESSION_ONLY_COOKIE, "1", { path: "/", httpOnly: true, sameSite: "lax", secure: process.env.NODE_ENV === "production" });
  }

  let error: unknown;
  try {
    const supabase = await createClient();
    ({ error } = await supabase.auth.signInWithPassword({ email, password }));
  } catch (caught) {
    error = caught ?? new Error("sign-in failed");
  }

  if (error) {
    const code = (error as { code?: string }).code;
    return {
      status: "error",
      message: friendlyAuthError(error, "sign-in"),
      values,
      unverifiedEmail: code === "email_not_confirmed" ? email : undefined,
    };
  }

  revalidatePath("/", "layout");
  redirect(safeNextPath(formData.get("next")));
}

export async function signUp(_previous: AuthFormState, formData: FormData): Promise<AuthFormState> {
  const fullName = formText(formData, "fullName");
  const email = formText(formData, "email").toLowerCase();
  const password = formPassword(formData, "password");
  const confirmPassword = formPassword(formData, "confirmPassword");
  const values = { fullName, email };

  const fieldErrors = {
    fullName: validateFullName(fullName),
    email: validateEmail(email),
    password: validatePassword(password),
    confirmPassword: validateConfirmPassword(password, confirmPassword),
  };
  if (hasErrors(fieldErrors)) return { status: "error", fieldErrors, values };

  let hasSession = false;
  try {
    const supabase = await createClient();
    const { data, error } = await supabase.auth.signUp({
      email,
      password,
      options: {
        // Read by the database trigger that creates the profile row.
        data: { full_name: fullName },
        emailRedirectTo: await callbackUrl("/dashboard"),
      },
    });

    if (error) return { status: "error", message: friendlyAuthError(error, "sign-up"), values };

    // With email confirmation on, Supabase answers a duplicate sign-up with a
    // placeholder user that has no identities instead of an error.
    if (data.user && data.user.identities?.length === 0) {
      return {
        status: "error",
        fieldErrors: { email: "An account with this email already exists. Try signing in instead." },
        values,
      };
    }

    hasSession = Boolean(data.session);
  } catch (caught) {
    return { status: "error", message: friendlyAuthError(caught, "sign-up"), values };
  }

  // Email confirmation is disabled for the project: the user is already signed in.
  if (hasSession) {
    revalidatePath("/", "layout");
    redirect("/dashboard");
  }

  return { status: "success", values: { email } };
}

export async function resendVerification(_previous: AuthFormState, formData: FormData): Promise<AuthFormState> {
  const email = formText(formData, "email").toLowerCase();
  if (validateEmail(email)) return { status: "error", message: "We couldn't resend the email. Please sign up again." };

  try {
    const supabase = await createClient();
    const { error } = await supabase.auth.resend({
      type: "signup",
      email,
      options: { emailRedirectTo: await callbackUrl("/dashboard") },
    });
    if (error) return { status: "error", message: friendlyAuthError(error, "resend verification") };
  } catch (caught) {
    return { status: "error", message: friendlyAuthError(caught, "resend verification") };
  }

  return { status: "success", message: "Verification email sent. It can take a minute to arrive." };
}

export async function requestPasswordReset(_previous: AuthFormState, formData: FormData): Promise<AuthFormState> {
  const email = formText(formData, "email").toLowerCase();
  const values = { email };

  const fieldErrors = { email: validateEmail(email) };
  if (hasErrors(fieldErrors)) return { status: "error", fieldErrors, values };

  try {
    const supabase = await createClient();
    const { error } = await supabase.auth.resetPasswordForEmail(email, {
      redirectTo: await callbackUrl("/reset-password"),
    });
    if (error) return { status: "error", message: friendlyAuthError(error, "password reset request"), values };
  } catch (caught) {
    return { status: "error", message: friendlyAuthError(caught, "password reset request"), values };
  }

  // The same response whether or not the address has an account.
  return { status: "success", values };
}

export async function updatePassword(_previous: AuthFormState, formData: FormData): Promise<AuthFormState> {
  const password = formPassword(formData, "password");
  const confirmPassword = formPassword(formData, "confirmPassword");

  const fieldErrors = {
    password: validatePassword(password),
    confirmPassword: validateConfirmPassword(password, confirmPassword),
  };
  if (hasErrors(fieldErrors)) return { status: "error", fieldErrors };

  try {
    const supabase = await createClient();
    const { data } = await supabase.auth.getUser();
    if (!data.user) {
      return { status: "error", message: "This reset link has expired. Request a new one to continue." };
    }

    const { error } = await supabase.auth.updateUser({ password });
    if (error) return { status: "error", message: friendlyAuthError(error, "password update") };

    // End the recovery session so the new password is what signs the user in.
    await supabase.auth.signOut();
  } catch (caught) {
    return { status: "error", message: friendlyAuthError(caught, "password update") };
  }

  revalidatePath("/", "layout");
  redirect("/login?notice=password_updated");
}

export async function signInWithGoogle(formData: FormData) {
  let url: string | null = null;
  try {
    const supabase = await createClient();
    const { data, error } = await supabase.auth.signInWithOAuth({
      provider: "google",
      options: { redirectTo: await callbackUrl(safeNextPath(formData.get("next"))) },
    });
    if (error) friendlyAuthError(error, "google sign-in");
    url = data?.url ?? null;
  } catch (caught) {
    friendlyAuthError(caught, "google sign-in");
  }

  redirect(url ?? "/login?notice=oauth_failed");
}

export async function signOut() {
  try {
    const supabase = await createClient();
    const { error } = await supabase.auth.signOut();
    if (error) friendlyAuthError(error, "sign-out");
  } catch (caught) {
    friendlyAuthError(caught, "sign-out");
  }

  (await cookies()).delete(SESSION_ONLY_COOKIE);
  revalidatePath("/", "layout");
  redirect("/login");
}
