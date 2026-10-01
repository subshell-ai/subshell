import { markdownBody } from "@/lib/discovery";
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
  const pages = source.getPages().sort((a, b) => a.url.localeCompare(b.url));
  const text = (
    await Promise.all(
      pages.map(async (page) => {
        const raw = await page.data.getText("raw");
        return `# ${page.data.title}\n\nCanonical URL: ${SITE_ORIGIN}${page.url}\n\n${page.data.description}\n\n${markdownBody(raw)}`;
      }),
    )
  ).join("\n\n---\n\n");

  return new Response(`# Subshell Docs\n\n<${SITE_ORIGIN}>\n\n${text}\n`, {
    headers: { "content-type": "text/plain; charset=utf-8" },
  });
}
