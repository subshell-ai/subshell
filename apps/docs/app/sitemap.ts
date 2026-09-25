import type { MetadataRoute } from "next";
import { SITE_ORIGIN } from "@/lib/site";
import { source } from "@/lib/source";

export const dynamic = "force-static";

/**
 * `sitemap.xml` for the static export. The URL set is derived from the same
 * `source` page tree the sidebar and `llms.txt` read, so the sitemap cannot
 * drift from the site: a page the crawler is told about is a page that
 * exists, and a new page appears here the moment it appears anywhere.
 */
export default function sitemap(): MetadataRoute.Sitemap {
  return source.getPages().map((page) => ({
    url: `${SITE_ORIGIN}${page.url === "/" ? "/" : page.url}`,
  }));
}
