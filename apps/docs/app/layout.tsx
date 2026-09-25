import { RootProvider } from "fumadocs-ui/provider/next";
import type { Metadata, Viewport } from "next";
import type { ReactNode } from "react";
import "./global.css";

export const metadata: Metadata = {
  metadataBase: new URL("https://docs.subshell.sh"),
  title: {
    template: "%s | Subshell Docs",
    default: "Subshell Docs",
  },
  description:
    "Documentation for Subshell — launch, attach to, and orchestrate interactive CLI coding agents from any device.",
  // The same generated brand icons the SPA ships (apps/server/web/public/
  // icons, copied into ./public/icons), so docs, the marketing site and the
  // installed product all show one mark.
  icons: {
    icon: [
      { url: "/icons/favicon-16.png", sizes: "16x16", type: "image/png" },
      { url: "/icons/favicon-32.png", sizes: "32x32", type: "image/png" },
      { url: "/icons/favicon-48.png", sizes: "48x48", type: "image/png" },
      { url: "/icons/favicon.ico", type: "image/x-icon" },
    ],
    apple: "/icons/apple-touch-icon.png",
  },
};

export const viewport: Viewport = {
  // The marketing void, so the browser chrome matches the dark-only page.
  themeColor: "#1d182a",
};

export default function Layout({ children }: { children: ReactNode }) {
  return (
    <html lang="en" className="dark" suppressHydrationWarning>
      <head>
        {/* The marketing site's two faces (apps/website/app/layout.tsx loads
            the same pair); global.css points --font-sans/--font-mono at them. */}
        <link
          href="https://fonts.googleapis.com/css2?family=Inter:wght@400;500;600;700&family=JetBrains+Mono:wght@400;500;600&display=swap"
          rel="stylesheet"
        />
      </head>
      <body className="flex flex-col min-h-screen">
        {/* `type: 'static'` — the search dialog runs entirely client-side
            against the prerendered `/api/search` index (static export,
            no server). `forcedTheme` pins dark (with html.className="dark"
            as the no-JS truth): the docs wear the marketing palette, which
            only exists in the dark world, so the site ships one theme. The
            sidebar's switch is removed by DocsLayout's `themeSwitch={false}`
            in the (docs) layout — a toggle that changes nothing is worse
            than no toggle. */}
        <RootProvider theme={{ forcedTheme: "dark" }} search={{ options: { type: "static" } }}>
          {children}
        </RootProvider>
      </body>
    </html>
  );
}
