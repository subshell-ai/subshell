import { SITE_ORIGIN } from "@/lib/site";
import { source } from "@/lib/source";

/**
 * `llms.txt` — the machine-readable page index
 * (https://llmstxt.org). Prerendered at build time; static export writes
 * the response to `out/llms.txt`.
 */
export const dynamic = "force-static";

function buildIndex(): string {
  const pages = source.getPages().sort((a, b) => a.url.localeCompare(b.url));
  const lines = [
    "# Subshell Docs",
    "",
    "> Documentation for Subshell — launch, attach to, and orchestrate interactive CLI coding agents from any device.",
    "",
  ];
  for (const page of pages) {
    const url = `${SITE_ORIGIN}${page.url === "/" ? "/" : page.url}`;
    lines.push(`- [${page.data.title}](${url}): ${page.data.description}`);
  }
  return `${lines.join("\n")}\n`;
}

export function GET(): Response {
  return new Response(buildIndex(), {
    headers: { "content-type": "text/plain; charset=utf-8" },
  });
}
