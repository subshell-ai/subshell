import { DOC_SECTIONS } from "@/lib/navigation";
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
    "> Subshell runs interactive CLI agents on machines you own, accessible from any device through a browser.",
    "",
    "Server means the control plane; node means a machine running agents; client means a person's interface to the server.",
    "",
    `- [Documentation home](${SITE_ORIGIN}/)`,
    `- [Complete documentation text](${SITE_ORIGIN}/llms-full.txt)`,
  ];
  for (const section of DOC_SECTIONS) {
    lines.push("", `## ${section.title}`, "");
    for (const page of pages.filter(
      (item) => item.url === `/${section.slug}` || item.url.startsWith(`/${section.slug}/`),
    )) {
      lines.push(`- [${page.data.title}](${SITE_ORIGIN}${page.url}): ${page.data.description}`);
    }
  }
  return `${lines.join("\n")}\n`;
}

export function GET(): Response {
  return new Response(buildIndex(), {
    headers: { "content-type": "text/plain; charset=utf-8" },
  });
}
