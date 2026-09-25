import type { Metadata } from "next";
import "./globals.css";

export const metadata: Metadata = {
  title: "Subshell: manage multiple agents away from your desk",
  description:
    "Your agents keep working after you walk away. View progress, get notified, and give feedback from any device with Subshell.",
};

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en">
      <head>
        <link
          href="https://fonts.googleapis.com/css2?family=Inter:wght@400;500;600;700&family=JetBrains+Mono:wght@400;500;600&display=swap"
          rel="stylesheet"
        />
      </head>
      <body>{children}</body>
    </html>
  );
}
