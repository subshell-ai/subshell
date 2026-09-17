import { describe, expect, test } from "bun:test";
import fs from "node:fs";
import path from "node:path";

/**
 * Validates the documentation content tree against the pinned conventions
 * (`apps/docs/AGENTS.md`): the canonical root sidebar order, resolvable
 * `meta.json` page entries, frontmatter on every page, no orphaned `.mdx`
 * files, and internal links that resolve to existing pages.
 *
 * The content tree is authored by a separate workstream, so a missing
 * `content/docs` directory SKIPs rather than fails — the suite goes green
 * the moment the tree lands.
 */

const DOCS_DIR = path.join(import.meta.dir, "..", "..", "content", "docs");

/** The canonical root `meta.json` pages list — 11 entries, in sidebar order. */
const ROOT_PAGES = [
  "index",
  "about",
  "get-started",
  "use",
  "agents",
  "nodes",
  "server",
  "automation",
  "develop",
  "reference",
  "help",
];

interface MetaFile {
  title?: string;
  pages?: unknown;
}

/** Every folder under content/docs, relative to it (top-down). */
function listDirs(rel: string): string[] {
  const out: string[] = [];
  for (const entry of fs.readdirSync(path.join(DOCS_DIR, rel), { withFileTypes: true })) {
    if (!entry.isDirectory()) continue;
    const child = rel ? path.join(rel, entry.name) : entry.name;
    out.push(child);
    out.push(...listDirs(child));
  }
  return out;
}

/** Every `.mdx` file under content/docs, relative to it. */
function listMdx(rel: string): string[] {
  const out: string[] = [];
  for (const entry of fs.readdirSync(path.join(DOCS_DIR, rel), { withFileTypes: true })) {
    const child = rel ? path.join(rel, entry.name) : entry.name;
    if (entry.isDirectory()) out.push(...listMdx(child));
    else if (entry.isFile() && entry.name.endsWith(".mdx")) out.push(child);
  }
  return out;
}

function readMeta(relDir: string): MetaFile | undefined {
  const file = path.join(DOCS_DIR, relDir, "meta.json");
  if (!fs.existsSync(file)) return undefined;
  return JSON.parse(fs.readFileSync(file, "utf8")) as MetaFile;
}

function pagesOf(relDir: string): string[] {
  const meta = readMeta(relDir);
  if (!meta || !Array.isArray(meta.pages)) return [];
  return meta.pages.filter((p): p is string => typeof p === "string");
}

/**
 * Parse the frontmatter block with Bun's YAML parser — the same document
 * grammar fumadocs-mdx compiles, so a frontmatter block that fails YAML
 * parsing HERE also fails `next build` (an unquoted colon inside a plain
 * scalar is exactly that class of bug). Returns undefined when the file has
 * no frontmatter fence at all.
 */
function parseFrontmatter(source: string): Record<string, unknown> | undefined {
  const match = /^---\r?\n([\s\S]*?)\r?\n---/.exec(source);
  if (!match) return undefined;
  return Bun.YAML.parse(match[1]) as Record<string, unknown>;
}

/**
 * Every root-relative internal link (`[text](/path)`) in a page's prose,
 * with hrefs pointing at nonexistent pages collected as `file: [text](href)`
 * strings. Frontmatter, fenced code blocks and inline code spans are stripped
 * first — an example link written as documentation (`` `[Nodes](/nodes)` ``)
 * is not a link. Resolution mirrors fumadocs' file routing: `/a/b` is
 * `content/docs/a/b.mdx` or `content/docs/a/b/index.mdx`, and `/` is the root
 * `index.mdx`. Fragments and query strings are stripped before resolving;
 * external (`http(s):`, `mailto:`, protocol-`//`) and pure-`#anchor` hrefs
 * never start with a surviving `/` path and are skipped by construction.
 */
function brokenInternalLinks(rel: string, source: string): string[] {
  const prose = source
    .replace(/^---\r?\n[\s\S]*?\r?\n---/, "")
    .replace(/```[\s\S]*?```/g, "")
    .replace(/`[^`\n]*`/g, "");
  const broken: string[] = [];
  for (const match of prose.matchAll(/\[[^\]]*\]\(([^)\s]+)(?:\s+"[^"]*")?\)/g)) {
    const href = match[1];
    if (!href?.startsWith("/")) continue;
    const pathname = href.split("#")[0]?.split("?")[0]?.replace(/\/+$/, "") ?? "";
    const candidates =
      pathname === ""
        ? [path.join(DOCS_DIR, "index.mdx")]
        : [path.join(DOCS_DIR, `${pathname.slice(1)}.mdx`), path.join(DOCS_DIR, pathname.slice(1), "index.mdx")];
    if (!candidates.some((c) => fs.existsSync(c))) {
      broken.push(`${rel}: [..](${href}) resolves to no page`);
    }
  }
  return broken;
}

if (!fs.existsSync(DOCS_DIR)) {
  test("content tree not present yet — validation skipped", () => {
    console.warn(
      `[content-tree] SKIP: ${path.relative(process.cwd(), DOCS_DIR) || "content/docs"} does not exist. ` +
        "The content tree is authored separately; this suite validates it once it lands.",
    );
  });
} else {
  describe("content/docs root meta.json", () => {
    test("lists exactly the 11 canonical root entries, in order", () => {
      expect(pagesOf("")).toEqual(ROOT_PAGES);
    });
  });

  describe("meta.json pages entries", () => {
    const dirs = [""].concat(listDirs(""));
    for (const rel of dirs) {
      const pages = pagesOf(rel);
      if (pages.length === 0) continue;
      test(`${path.join("content/docs", rel) || "content/docs"}/meta.json entries resolve`, () => {
        for (const entry of pages) {
          expect(entry, `empty page name in ${rel || "."}/meta.json`).not.toBe("");
          const asFile = path.join(DOCS_DIR, rel, `${entry}.mdx`);
          const asDir = path.join(DOCS_DIR, rel, entry);
          const resolves = fs.existsSync(asFile) || fs.existsSync(asDir);
          expect(
            resolves,
            `"${entry}" in ${path.join("content/docs", rel) || "content/docs"}/meta.json resolves to neither ${entry}.mdx nor a ${entry}/ folder`,
          ).toBe(true);
        }
      });
    }
  });

  describe("page frontmatter", () => {
    const files = listMdx("");
    test("content/docs contains at least one page", () => {
      expect(files.length).toBeGreaterThan(0);
    });
    for (const rel of files) {
      test(`${rel} has a non-empty title and description`, () => {
        const raw = fs.readFileSync(path.join(DOCS_DIR, rel), "utf8");
        let fm: Record<string, unknown> | undefined;
        try {
          fm = parseFrontmatter(raw);
        } catch (e) {
          throw new Error(
            `${rel}: frontmatter is not valid YAML (this also breaks next build) — quote values containing ": ": ${String(e)}`,
          );
        }
        expect(fm, `${rel} is missing a frontmatter block`).toBeDefined();
        const title = fm?.title;
        const description = fm?.description;
        expect(typeof title, `${rel} title must be a non-empty string`).toBe("string");
        expect((title as string).trim(), `${rel} has an empty title`).not.toBe("");
        expect(typeof description, `${rel} description must be a non-empty string`).toBe("string");
        expect((description as string).trim(), `${rel} has an empty description`).not.toBe("");
      });
    }
  });

  describe("internal links", () => {
    // One test, all failures listed — the point is to see every dead link in
    // one run, not to fix them one rebuild at a time.
    test("every root-relative link resolves to an existing page", () => {
      const broken = listMdx("").flatMap((rel) =>
        brokenInternalLinks(rel, fs.readFileSync(path.join(DOCS_DIR, rel), "utf8")),
      );
      expect(
        broken,
        `dead internal links (groups have no index page — /use 404s while /nodes resolves):\n${broken.join("\n")}`,
      ).toEqual([]);
    });
  });

  describe("no orphaned pages", () => {
    // Group every .mdx by its containing folder; each must be named in that
    // folder's meta.json pages list (the index page of a folder is listed
    // there as "index", same as any other file).
    const byDir = new Map<string, string[]>();
    for (const rel of listMdx("")) {
      const dir = path.dirname(rel);
      const key = dir === "." ? "" : dir;
      const bucket = byDir.get(key) ?? [];
      bucket.push(path.basename(rel, ".mdx"));
      byDir.set(key, bucket);
    }
    for (const [rel, names] of byDir) {
      test(`${path.join("content/docs", rel) || "content/docs"}: every page is in meta.json`, () => {
        const listed = new Set(pagesOf(rel));
        for (const name of names) {
          expect(
            listed.has(name),
            `${path.join("content/docs", rel, `${name}.mdx`)} is absent from ${path.join("content/docs", rel) || "content/docs"}/meta.json pages`,
          ).toBe(true);
        }
      });
    }
  });
}
