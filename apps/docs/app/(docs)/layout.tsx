import { DocsLayout } from "fumadocs-ui/layouts/docs";
import type { ReactNode } from "react";
import { source } from "@/lib/source";

export default function Layout({ children }: { children: ReactNode }) {
  return (
    <DocsLayout
      tree={source.getPageTree()}
      // Dark-only site (see app/layout.tsx): no light theme to switch to.
      themeSwitch={{ enabled: false }}
      nav={{
        // Brand-pipeline wordmark, with a high-DPI source and rem-based size
        // that follows the documentation typography.
        title: (
          // biome-ignore lint/performance/noImgElement: static export, same raw-img call the marketing header made
          <img
            src="/wordmark-docs-96.png"
            srcSet="/wordmark-docs-96.png 1x, /wordmark-docs-192.png 2x"
            alt="Subshell Docs"
            width={646}
            height={96}
            className="h-[1.5rem] w-auto max-w-full"
          />
        ),
      }}
    >
      {children}
    </DocsLayout>
  );
}
