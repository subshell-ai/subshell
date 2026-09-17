import { llms } from "fumadocs-core/source";
import { SITE_ORIGIN } from "@/lib/site";
import { source } from "@/lib/source";

/**
 * `llms-full.txt` — every page's markdown concatenated into one document,
 * for consumers that read the whole corpus at once. Prerendered at build
 * time from the raw `.mdx` files; static export writes it to
 * `out/llms-full.txt`.
 */
export const dynamic = "force-static";

export async function GET(): Promise<Response> {
  const text = await llms(source, {
    // the collection entry (page.data) carries the raw-content reader
    renderPage: (page) => page.data.getText("raw"),
  }).full();

  return new Response(`# Subshell Docs\n\n<${SITE_ORIGIN}>\n\n${text}\n`, {
    headers: { "content-type": "text/plain; charset=utf-8" },
  });
}
