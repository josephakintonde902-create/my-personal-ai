import { createServerClient } from "@supabase/ssr";
import { NextResponse, type NextRequest } from "next/server";
import { AUTH_ROUTES, isUnderRoute, PROTECTED_ROUTES } from "@/lib/auth/routes";
import { getSupabaseConfig, isSupabaseConfigured, SESSION_ONLY_COOKIE, withSessionLifetime } from "./config";

export async function updateSession(request: NextRequest) {
  const { pathname } = request.nextUrl;
  const isProtected = isUnderRoute(pathname, PROTECTED_ROUTES);

  // Fail closed: without Supabase there is no way to establish identity.
  if (!isSupabaseConfigured()) {
    return isProtected ? redirectTo(request, "/login") : NextResponse.next({ request });
  }

  let response = NextResponse.next({ request });
  const { url, key } = getSupabaseConfig();
  const sessionOnly = request.cookies.has(SESSION_ONLY_COOKIE);

  const supabase = createServerClient(url, key, {
    cookies: {
      getAll() {
        return request.cookies.getAll();
      },
      setAll(cookiesToSet, headers) {
        cookiesToSet.forEach(({ name, value }) => request.cookies.set(name, value));
        response = NextResponse.next({ request });
        cookiesToSet.forEach(({ name, value, options }) =>
          response.cookies.set(name, value, withSessionLifetime(options, sessionOnly)),
        );
        Object.entries(headers ?? {}).forEach(([name, value]) => response.headers.set(name, value));
      },
    },
  });

  // Verifies the JWT (and refreshes an expired session). Do not run code
  // between creating the client and this call.
  const { data } = await supabase.auth.getClaims();
  const isAuthenticated = Boolean(data?.claims?.sub);

  if (!isAuthenticated && isProtected) {
    const next = pathname + request.nextUrl.search;
    return redirectTo(request, "/login", response, next === "/dashboard" ? undefined : next);
  }

  if (isAuthenticated && isUnderRoute(pathname, AUTH_ROUTES)) {
    return redirectTo(request, "/dashboard", response);
  }

  return response;
}

function redirectTo(request: NextRequest, pathname: string, from?: NextResponse, next?: string) {
  const url = request.nextUrl.clone();
  url.pathname = pathname;
  url.search = "";
  if (next) url.searchParams.set("next", next);

  const redirect = NextResponse.redirect(url);
  // Carry over any refreshed session cookies so they are not lost.
  from?.cookies.getAll().forEach((cookie) => redirect.cookies.set(cookie));
  return redirect;
}
