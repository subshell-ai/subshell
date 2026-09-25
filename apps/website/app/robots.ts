import type { MetadataRoute } from "next";

export const dynamic = "force-static";

/**
 * `robots.txt` (Next route module; the static-export build writes the file).
 * Everything is allowed — the site is meant to be found — and the sitemap
 * is named.
 */
export default function robots(): MetadataRoute.Robots {
  return {
    rules: [{ userAgent: "*", allow: "/" }],
    sitemap: "https://subshell.sh/sitemap.xml",
  };
}
