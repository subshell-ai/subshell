# apps/docs: authoring contract

This is the public Fumadocs / Next.js documentation site at docs.subshell.sh.
It builds to a static export. Pages are MDX under `content/docs/`, with explicit
`meta.json` navigation in every folder. The contributor guide is
`content/docs/developers/documentation.mdx`.

## Coverage and structure

The root sidebar order is `index`, `get-started`, `install`, `guides`, `agents`,
`nodes`, `administration`, `networking`, `mcp`, `automation`, `concepts`,
`reference`, `troubleshooting`, and `developers`. `lib/navigation.ts` defines
this order and the AI index's section names. Every section has an index page.
Update that contract and the root metadata together when changing navigation.

Document shipped behavior, including browser/PWA access from phones and
tablets. Do not document the native mobile app, its setup, availability,
development workflow, or roadmap. The product documentation excludes it.

MCP has its own section. Keep tool reference at `/mcp/tools`; link there from
Reference instead of maintaining a second tool list. Cover identity, ownership,
helper cleanup, encrypted channels, and the distinction between nudges and posts.

## Voice and factual accuracy

`STYLE.md` governs prose. Use plain second-person language and a one-sentence
factual opener. How-tos state prerequisites, numbered actions, expected results,
and next steps. Reference pages use lookup tables and command sections.

- Server means the control plane; node means an execution machine; client
  means a person's interface. Never give these words a second meaning.
- Use device-neutral positioning. Browser guidance can name phones and tablets.
- No em dashes in prose, headings, frontmatter, or callouts. Literal code is exempt.
- Verify flags, defaults, versions, permissions, UI labels, and error strings
  against the owning app documentation and current implementation.
- `docs/security.md` is the security authority. Resolve disagreement before
  publishing a claim. Historical specs are coverage hints, not proof a change shipped.
- Preserve data-loss and trust warnings at equal strength. In this checkout,
  the UI's Close action deletes; MCP terminate retains the row. Recheck the
  implementation before changing that documentation.
- Publish substantive pages. Do not ship draft notices, intent-only stubs, or
  repository source inventories in ordinary user guides.

## MDX and links

Both `title` and `description` frontmatter are required. Quote YAML values
containing `: `. Curly braces and angle brackets are JSX: put paths,
placeholders, flags, and JSON in code spans or fenced code blocks.

Internal links are root-relative and must resolve to an existing page. Every
MDX page must appear in its folder's `meta.json`. Prefer the destination's title
as link text. Update repository-owned links when changing a route.

Use default Fumadocs components only: code blocks, tables, and GitHub alert
callouts. No screenshots, Tabs, Cards, Steps, or custom MDX components.

## SEO and AI exports

Use unique descriptive titles and summaries, one rendered H1, logical headings,
and crawlable links. Keep essential content in statically rendered HTML.
Canonical and social metadata must identify the actual page. Visible breadcrumbs
and breadcrumb structured data come from the same list.

The sitemap, `/llms.txt`, `/llms-full.txt`, and static search use the published
content source. The AI index is grouped by section. Full text preserves headings,
commands, warnings, and canonical attribution. Never fabricate modification dates.

## Verification

From the repository root:

```bash
env -u SHELLOPTS -u BASHOPTS bun run --cwd apps/docs test
bunx turbo build --filter=@internal/docs
bun run --cwd apps/docs lint:check
bun run --cwd apps/docs verify-types
bun run --cwd apps/docs verify:export
bun run dev:docs
```

The build is the real MDX compile check. Export verification must run against a
fresh build; content or sitemap absence is a failure, not a skipped success.
Review wide and narrow layouts and confirm a no-JavaScript document is readable.

## Shipping

Add a changeset naming only `@internal/docs`. Do not hand-edit generated
changelogs or cut tags. The docs workflow owns deployment and `docs-v*` tags.
The source repository is public; npm-private workspace flags only prevent npm publication.

<!-- BEGIN:nextjs-agent-rules -->

# This is NOT the Next.js you know

This version has breaking changes — APIs, conventions, and file structure may all differ from your training data. Read the relevant guide in `node_modules/next/dist/docs/` (resolved from this file's directory; in monorepos the `next` package may not be visible from the repo root) before writing any code. Heed deprecation notices.

This block is written and re-added by `next dev` — verify at `node_modules/next/dist/server/lib/generate-agent-files.js`. Removing it from a diff only re-creates the uncommitted change; committing it with your work keeps the tree clean.

<!-- END:nextjs-agent-rules -->
