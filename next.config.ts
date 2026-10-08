import type { NextConfig } from "next";

// Sent with every response. None of these change how the app behaves for a
// student; they close off ways another site could misuse it.
const securityHeaders = [
  // Browsers must not guess a file's type from its contents.
  { key: "X-Content-Type-Options", value: "nosniff" },
  // Ari is never shown inside another site's frame (clickjacking).
  { key: "X-Frame-Options", value: "DENY" },
  // Other sites learn only that a visitor came from Ari, not which page.
  { key: "Referrer-Policy", value: "strict-origin-when-cross-origin" },
  // The app uses none of these device features, so no script may ask for them.
  { key: "Permissions-Policy", value: "camera=(), microphone=(), geolocation=(), payment=()" },
  // HTTPS only, once deployed. Not sent in development, where the app is
  // served over plain http://localhost.
  ...(process.env.NODE_ENV === "production" ? [{ key: "Strict-Transport-Security", value: "max-age=63072000; includeSubDomains" }] : []),
];

const nextConfig: NextConfig = {
  poweredByHeader: false,
  // Document parsers run on the server only. Loading them straight from
  // node_modules (instead of bundling them) keeps their internal file and
  // worker loading working exactly as it does in the tests.
  serverExternalPackages: ["unpdf", "mammoth", "cfb"],
  async headers() {
    return [
      { source: "/(.*)", headers: securityHeaders },
      {
        // The service worker is always fetched fresh, so an update reaches
        // installed copies of the app, and it may only run its own code.
        source: "/sw.js",
        headers: [
          { key: "Content-Type", value: "application/javascript; charset=utf-8" },
          { key: "Cache-Control", value: "no-cache, no-store, must-revalidate" },
          { key: "Content-Security-Policy", value: "default-src 'self'; script-src 'self'" },
        ],
      },
    ];
  },
};

export default nextConfig;
