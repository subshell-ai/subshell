import type { MetadataRoute } from "next";
import { SITE_ORIGIN } from "@/lib/site";

export const dynamic = "force-static";

/**
 * `robots.txt` for the static export (Next supports route modules under
 * `output: "export"`; the build writes the file). Everything is allowed —
 * the docs are meant to be found — and the sitemap is named so crawlers
 * that read this at all learn the full page set without link-following.
 */
export default function robots(): MetadataRoute.Robots {
  return {
    rules: [{ userAgent: "*", allow: "/" }],
    sitemap: `${SITE_ORIGIN}/sitemap.xml`,
  };
}
