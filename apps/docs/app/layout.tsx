import { RootProvider } from "fumadocs-ui/provider/next";
import type { Metadata } from "next";
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
};

export default function Layout({ children }: { children: ReactNode }) {
  return (
    <html lang="en" suppressHydrationWarning>
      <body className="flex flex-col min-h-screen">
        {/* `type: 'static'` — the search dialog runs entirely client-side
            against the prerendered `/api/search` index (static export,
            no server). */}
        <RootProvider search={{ options: { type: "static" } }}>{children}</RootProvider>
      </body>
    </html>
  );
}
