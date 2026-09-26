import type { MetadataRoute } from "next";
import { SITE_ORIGIN } from "../lib/site";

export const dynamic = "force-static";

/**
 * `sitemap.xml` for a one-page site: the landing page is the site (the
 * install block refetches the release manifest client-side, so there are no
 * other URLs worth declaring). Deliberately explicit rather than generated
 * from routes; if the site grows a second page, the entry below and the
 * canonical in layout.tsx are the two places that must learn it.
 */
export default function sitemap(): MetadataRoute.Sitemap {
  return [{ url: `${SITE_ORIGIN}/` }];
}
