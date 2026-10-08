import type { Metadata, Viewport } from "next";
import { InstallPrompt } from "@/components/install-prompt";
import { ServiceWorkerRegistration } from "@/components/service-worker-registration";
import "./globals.css";

export const metadata: Metadata = {
  applicationName: "Ari",
  title: "Ari — Your AI Study Tutor",
  description: "Learn smarter with Ari, your AI-powered study tutor.",
  manifest: "/manifest.webmanifest",
  appleWebApp: {
    capable: true,
    title: "Ari",
    statusBarStyle: "default",
  },
  openGraph: {
    title: "Ari — Your AI Study Tutor",
    description: "Learn smarter with Ari, your AI-powered study tutor.",
    siteName: "Ari",
    type: "website",
  },
  icons: {
    icon: [
      { url: "/icons/ari-192.png", sizes: "192x192", type: "image/png" },
      { url: "/icons/ari-512.png", sizes: "512x512", type: "image/png" },
    ],
    apple: [{ url: "/icons/ari-apple-touch.png", sizes: "180x180", type: "image/png" }],
  },
};

export const viewport: Viewport = {
  width: "device-width",
  initialScale: 1,
  viewportFit: "cover",
  themeColor: "#f7f8f5",
};

export default function RootLayout({ children }: Readonly<{ children: React.ReactNode }>) {
  return (
    <html lang="en">
      <body>
        {children}
        <InstallPrompt />
        <ServiceWorkerRegistration />
      </body>
    </html>
  );
}
