import { createFromSource } from "fumadocs-core/search/server";
import { source } from "@/lib/source";

/**
 * Static search: the site is a static export (`output: 'export'`), so the
 * search index is built at prerender time and served as a static file.
 * `staticGET` exports the whole index; the client dialog
 * (`type: 'static'` in `app/layout.tsx`) downloads it once and searches
 * entirely in the browser — no server, ever.
 */
export const dynamic = "force-static";

export const { staticGET: GET } = createFromSource(source);
