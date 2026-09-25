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
        // The marketing wordmark (the header image on subshell.sh), so the
        // two sites read as one product; the title stays in alt for AT and
        // for the img-less fallback.
        title: (
          // biome-ignore lint/performance/noImgElement: static export, same raw-img call the marketing header made
          <img src="/wordmark-docs-96.png" alt="Subshell Docs" width={445} height={96} className="h-[22px] w-auto" />
        ),
      }}
    >
      {children}
    </DocsLayout>
  );
}
