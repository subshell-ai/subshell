import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { markdownBody } from "../lib/discovery";
import { SITE_ORIGIN } from "../lib/site";

/** Validate the deployable bytes, without importing the build-only MDX macro. */
const root = path.resolve(import.meta.dir, "..");
const contentDir = path.join(root, "content/docs");
const outDir = path.join(root, "out");

function files(dir: string): string[] {
  return fs.readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const file = path.join(dir, entry.name);
    return entry.isDirectory() ? files(file) : [file];
  });
}

function decode(text: string): string {
  return text.replace(/&(?:amp|quot|apos|lt|gt|#39|#x27|#x([\da-f]+)|#(\d+));/gi, (entity, hex, decimal) => {
    if (hex) return String.fromCodePoint(Number.parseInt(hex, 16));
    if (decimal) return String.fromCodePoint(Number(decimal));
    return (
      (
        { "&amp;": "&", "&quot;": '"', "&apos;": "'", "&lt;": "<", "&gt;": ">", "&#39;": "'", "&#x27;": "'" } as Record<
          string,
          string
        >
      )[entity] ?? entity
    );
  });
}

assert(fs.existsSync(outDir), "Build the docs before running verify:export");
const pages = files(contentDir)
  .filter((file) => file.endsWith(".mdx"))
  .map((file) => {
    const raw = fs.readFileSync(file, "utf8");
    const match = /^---\r?\n([\s\S]*?)\r?\n---/.exec(raw);
    assert(match, `Missing frontmatter: ${file}`);
    const frontmatter = Bun.YAML.parse(match[1]) as { title: string; description: string };
    const slug = path
      .relative(contentDir, file)
      .replace(/\.mdx$/, "")
      .replace(/(^|\/)index$/, "");
    const url = `/${slug.replace(/\/$/, "")}`;
    return { file, raw, url, ...frontmatter };
  });
assert(pages.length > 0, "The export must contain documentation");
const sitemap = fs.readFileSync(path.join(outDir, "sitemap.xml"), "utf8");
const sitemapUrls = [...sitemap.matchAll(/<loc>([^<]+)<\/loc>/g)].map((match) => decode(match[1])).sort();
assert.deepEqual(
  sitemapUrls,
  pages.map((page) => `${SITE_ORIGIN}${page.url}`).sort(),
  "Sitemap coverage must exactly match published pages",
);
const index = fs.readFileSync(path.join(outDir, "llms.txt"), "utf8");
const full = fs.readFileSync(path.join(outDir, "llms-full.txt"), "utf8");
const robots = fs.readFileSync(path.join(outDir, "robots.txt"), "utf8");
assert(robots.includes(`Sitemap: ${SITE_ORIGIN}/sitemap.xml`), "robots.txt must advertise the sitemap");
assert(robots.includes("Allow: /"), "Published docs must be crawlable");
const searchFile = ["api/search", "api/search.json", "api/search.txt", "api/search/index.html"]
  .map((file) => path.join(outDir, file))
  .find((file) => fs.existsSync(file) && fs.statSync(file).isFile());
assert(searchFile, "The static search index must be exported");
const search = fs.readFileSync(searchFile, "utf8");

for (const page of pages) {
  const htmlPath = path.join(outDir, page.url === "/" ? "index.html" : `${page.url.slice(1)}.html`);
  assert(fs.existsSync(htmlPath), `Missing HTML: ${page.url}`);
  const html = fs.readFileSync(htmlPath, "utf8");
  const metaTags = [...html.matchAll(/<(?:meta|link)\b[^>]*>/g)].map((match) => decode(match[0]));
  const canonical = `${SITE_ORIGIN}${page.url}`;
  assert(
    metaTags.some(
      (tag) =>
        tag.includes('rel="canonical"') &&
        (tag.includes(`href="${canonical}"`) || (page.url === "/" && tag.includes(`href="${SITE_ORIGIN}"`))),
    ),
    `Missing canonical: ${page.url}`,
  );
  for (const [attribute, key, value] of [
    ["name", "description", page.description],
    ["property", "og:title", page.title],
    ["property", "og:description", page.description],
    ["property", "og:url", canonical],
    ["name", "twitter:title", page.title],
    ["name", "twitter:description", page.description],
  ]) {
    assert(
      metaTags.some(
        (tag) =>
          tag.includes(`${attribute}="${key}"`) &&
          (tag.includes(`content="${value}"`) ||
            (key === "og:url" && page.url === "/" && tag.includes(`content="${SITE_ORIGIN}"`))),
      ),
      `Incorrect ${key}: ${page.url}`,
    );
  }
  const staticHtml = html.replace(/<script\b[\s\S]*?<\/script>/g, "");
  assert.equal([...staticHtml.matchAll(/<h1\b/g)].length, 1, `Expected one H1: ${page.url}`);
  const visible = decode(staticHtml.replace(/<[^>]+>/g, "")).replace(/\s+/g, " ");
  const opener = markdownBody(page.raw)
    .split("\n\n")[0]
    .replace(/\[([^\]]+)\]\([^)]+\)/g, "$1")
    .replace(/[`*]/g, "")
    .replace(/\s+/g, " ");
  assert(visible.includes(opener), `Content must be readable without scripts: ${page.url}`);
  const jsonLd = /<script type="application\/ld\+json">([\s\S]*?)<\/script>/.exec(html);
  assert(jsonLd, `Missing breadcrumb structured data: ${page.url}`);
  const breadcrumb = JSON.parse(jsonLd[1]) as { itemListElement: { name: string; item: string }[] };
  assert.equal(breadcrumb.itemListElement.at(-1)?.item, canonical, `Breadcrumb destination: ${page.url}`);
  for (const item of breadcrumb.itemListElement)
    assert(visible.includes(item.name), `Breadcrumb must be visible: ${page.url}`);
  assert(index.includes(`](${canonical})`), `AI index missing page: ${page.url}`);
  assert(full.includes(`Canonical URL: ${canonical}\n`), `AI full text missing attribution: ${page.url}`);
  assert(full.includes(markdownBody(page.raw)), `AI full text must preserve complete body: ${page.url}`);
  assert(search.includes(page.title), `Search index missing page: ${page.url}`);
}

assert(
  !/native mobile|react native|\bexpo\b|eas build|testflight|play store|app store/gi.test(index + full),
  "Native mobile app content must not appear in discovery outputs",
);
console.log(`Verified ${pages.length} pages: static HTML, metadata, breadcrumbs, sitemap, search, and AI exports.`);
