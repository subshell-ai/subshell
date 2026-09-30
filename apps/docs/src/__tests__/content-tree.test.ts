import { describe, expect, test } from "bun:test";
import fs from "node:fs";
import path from "node:path";
import { ROOT_PAGES } from "../../lib/navigation";

/**
 * Validates the documentation content tree against the pinned conventions
 * (`apps/docs/AGENTS.md`): the canonical root sidebar order, resolvable
 * `meta.json` page entries, frontmatter on every page, no orphaned `.mdx`
 * files, and internal links that resolve to existing pages.
 *
 * Missing content is a failure: the published site must contain the complete tree.
 */

const DOCS_DIR = path.join(import.meta.dir, "..", "..", "content", "docs");

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
 * `fs.existsSync` on macOS' case-insensitive APFS would bless `/Nodes` where
 * the deploy would 404 it — so walk the path segment by segment against
 * `readdirSync` and demand an exact-name hit each step. Anything that throws
 * mid-walk (a file where a directory was expected, a `..` escape) is "no page".
 */
function caseExactExists(abs: string): boolean {
  try {
    let dir = DOCS_DIR;
    for (const seg of path.relative(DOCS_DIR, abs).split(path.sep)) {
      const hit = fs.readdirSync(dir).find((entry) => entry === seg);
      if (!hit) return false;
      dir = path.join(dir, hit);
    }
    return true;
  } catch {
    return false;
  }
}

/**
 * Every root-relative internal link (`[text](/path)`) in a page's prose,
 * with hrefs pointing at nonexistent pages collected as `file: [text](href)`
 * strings. Frontmatter, fenced code blocks and inline code spans are
 * stripped first — an example link written as documentation (`` `[Nodes](/nodes)` ``)
 * is not a link — and images (`![alt](/x)`) are excluded, since a public asset
 * is not a page. Resolution mirrors fumadocs' file routing: `/a/b` is
 * `content/docs/a/b.mdx` or `content/docs/a/b/index.mdx`, and `/` is the root
 * `index.mdx`; segments are matched CASE-EXACTLY because macOS APFS is
 * case-insensitive while the production host is not. Fragments and query
 * strings are stripped before resolving. Hrefs that are not root-relative
 * (`http(s):`, `mailto:`, pure `#anchor`) are skipped, as are protocol-relative
 * `//host` URLs — those are external by definition. */
function brokenInternalLinks(rel: string, source: string): string[] {
  const prose = source
    .replace(/^---\r?\n[\s\S]*?\r?\n---/, "")
    .replace(/```[\s\S]*?```/g, "")
    .replace(/`[^`\n]*`/g, "");
  const broken: string[] = [];
  for (const match of prose.matchAll(/(?<!!)\[[^\]]*\]\(([^)\s]+)(?:\s+"[^"]*")?\)/g)) {
    const href = match[1];
    if (!href?.startsWith("/") || href.startsWith("//")) continue;
    const pathname = href.split("#")[0]?.split("?")[0]?.replace(/\/+$/, "") ?? "";
    const candidates =
      pathname === ""
        ? [path.join(DOCS_DIR, "index.mdx")]
        : [path.join(DOCS_DIR, `${pathname.slice(1)}.mdx`), path.join(DOCS_DIR, pathname.slice(1), "index.mdx")];
    if (!candidates.some((c) => fs.existsSync(c) && caseExactExists(c))) {
      broken.push(`${rel}: [..](${href}) resolves to no page`);
    }
  }
  return broken;
}

describe("published documentation", () => {
  test("legacy routes redirect permanently to published pages", () => {
    const redirects = fs.readFileSync(path.join(DOCS_DIR, "../../public/_redirects"), "utf8");
    const sources = new Set<string>();
    for (const line of redirects.split("\n").filter((line) => line && !line.startsWith("#"))) {
      const [from, to, status] = line.split(/\s+/);
      expect(sources.has(from), `duplicate redirect: ${from}`).toBe(false);
      sources.add(from);
      expect(status).toBe("301");
      expect(from).not.toBe(to);
      expect(brokenInternalLinks("_redirects", `[target](${to})`)).toEqual([]);
    }
  });

  test("all sections have nonempty content and ordered metadata", () => {
    expect(fs.existsSync(DOCS_DIR), "content/docs is required").toBe(true);
    for (const section of ROOT_PAGES.filter((entry) => entry !== "index")) {
      expect(fs.existsSync(path.join(DOCS_DIR, section, "index.mdx"))).toBe(true);
      expect(pagesOf(section).length).toBeGreaterThan(1);
    }
    for (const dir of ["", ...listDirs("")]) {
      expect(readMeta(dir), `${dir || "."} needs meta.json`).toBeDefined();
      expect(new Set(pagesOf(dir)).size).toBe(pagesOf(dir).length);
    }
  });

  test("published pages are substantive and exclude native mobile and draft stubs", () => {
    const titles = new Set<string>();
    const descriptions = new Set<string>();
    for (const rel of listMdx("")) {
      const raw = fs.readFileSync(path.join(DOCS_DIR, rel), "utf8");
      const fm = parseFrontmatter(raw);
      expect(titles.has(String(fm?.title)), `duplicate title: ${rel}`).toBe(false);
      expect(descriptions.has(String(fm?.description)), `duplicate summary: ${rel}`).toBe(false);
      titles.add(String(fm?.title));
      descriptions.add(String(fm?.description));
      const body = raw.replace(/^---\r?\n[\s\S]*?\r?\n---/, "").trim();
      expect(body.length, `empty or stub page: ${rel}`).toBeGreaterThan(350);
      expect(body, `draft placeholder: ${rel}`).not.toMatch(/> \[!warning\] Draft|^## Sources|TODO|coming soon/im);
      expect(body, `native mobile content: ${rel}`).not.toMatch(
        /native mobile|react native|\bexpo\b|testflight|eas build|play store|app store/i,
      );
      expect(body, `MDX component outside authoring contract: ${rel}`).not.toMatch(
        /^(import |export |<(Tabs|Cards|Steps)\b)/m,
      );
      expect(body, `the page renderer provides the H1: ${rel}`).not.toMatch(/^# /m);
    }
  });

  test("MCP reference covers every registered tool and no retired tools", () => {
    const server = fs.readFileSync(path.join(DOCS_DIR, "../../../../packages/mcp-core/src/server.ts"), "utf8");
    const names = [...server.matchAll(/server\.registerTool\(\s*"([^"]+)"/g)].map((match) => match[1]).sort();
    const reference = fs.readFileSync(path.join(DOCS_DIR, "mcp/tools.mdx"), "utf8");
    const headings = [...reference.matchAll(/^## ([a-z]+_[a-z_]+)$/gm)].map((match) => match[1]).sort();
    expect(headings).toEqual(names);
  });

  describe("content/docs root meta.json", () => {
    test("lists the canonical root entries, in order", () => {
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

  describe("em-dash ban", () => {
    // The voice rule (AGENTS.md, operator ruling 2026-09-25): no U+2014 in
    // page prose, headings, frontmatter or callouts — a comma, colon,
    // parentheses or a full stop carries the same breath. Fenced blocks and
    // inline code are exempt (they quote command output and literal strings);
    // en dashes and hyphens are untouched. One test, every offender listed:
    // the sweep wants the whole file list at once, not one rebuild per file.
    test("no .mdx page carries an em dash", () => {
      const offenders = listMdx("")
        .map((rel) => {
          const prose = fs
            .readFileSync(path.join(DOCS_DIR, rel), "utf8")
            .replace(/```[\s\S]*?```/g, "")
            .replace(/`[^`\n]*`/g, "");
          const hits = prose.match(/—/g);
          return hits === null ? null : `${rel}: ${hits.length} em dash(es)`;
        })
        .filter((line): line is string => line !== null);
      expect(
        offenders,
        `em dashes in page prose (replace with a comma, colon, parentheses, or a new sentence):\n${offenders.join("\n")}`,
      ).toEqual([]);
    });
  });

  describe("internal links", () => {
    // One test, all failures listed — the point is to see every dead link in
    // one run, not to fix them one rebuild at a time.
    test("every root-relative link resolves to an existing page", () => {
      const broken = listMdx("").flatMap((rel) =>
        brokenInternalLinks(rel, fs.readFileSync(path.join(DOCS_DIR, rel), "utf8")),
      );
      expect(broken, `dead internal links (each section must have an index page):\n${broken.join("\n")}`).toEqual([]);
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
});
