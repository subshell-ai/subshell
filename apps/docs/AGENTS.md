# apps/docs — authoring contract

This is the public documentation site: a Fumadocs 16 / Next.js app that builds
to a **static export** and ships at docs.subshell.sh. Pages are MDX files under
`content/docs/`, and the sidebar is the file tree (`meta.json` per folder).
The human-facing twin — the contributor walkthrough — is
`content/docs/develop/contribute-to-these-docs.mdx`; this file is the agent-
facing contract. Where they disagree, this one is more current.

## Finishing a stub page

Many pages are honest stubs: a future-tense intent paragraph, a
`> [!warning] Draft` callout, and a `## Sources` list naming the repository
files the content migrates from. Finishing one means all four steps:

1. **Read every listed source.** They are real paths. Where two disagree, the
   app's own `AGENTS.md` wins, and for security claims `docs/security.md` is
   the authority.
2. **Replace the intent paragraph with real prose** covering everything the
   intent promised — honour it without narrowing it.
3. **Delete the Draft callout.** That is the lifecycle event that makes the
   page real.
4. **Convert `## Sources` into a short reader-facing "See also"** — site links,
   plus the GitHub URL for `docs/security.md` when security claims need their
   authority. Repo-internal source paths (`apps/...`, `docs/...`) come OUT of
   the page.

Keep the `title` and `description` frontmatter (both required; a description
containing ": " must be quoted — it is YAML).

## Vocabulary and voice

- **Three words, one meaning each**: **server** = the control plane (API,
  database, the SPA it serves) — not a machine that runs agents; **node** = a
  machine that runs agents (the `subshell` daemon) — not an app; **client** =
  a person's interface to a control plane (web, mobile, desktop) — not the
  node daemon. Reusing a word for two things is the one style violation that bounces
  a PR.
- **Device-neutral positioning.** Lead with "from anywhere / any device";
  phone-specific copy belongs on the mobile page only. The maintainer rejected
  phone-first framing — the product is not "a phone app for agents".
- Second person, plain, user-facing. "You grant view access…", not "the system
  permits…".

## MDX traps (each has broken a build)

- **Curly braces and angle brackets are JSX.** Keep flags, placeholders and
  paths in code font: `` `--from <file>` `` renders; a bare `<file>` is a JSX
  parse error.
- **Frontmatter is YAML** — quote values containing ": ".
- **Internal links are root-relative** (`[Nodes](/nodes)`) and must point at
  **existing pages**. Groups `use`, `automation`, `develop`, `reference` and
  `help` have NO index page — `/use` 404s while `/nodes` resolves. A link to
  an existing stub page is fine (every stub IS a page); a link to a
  nonexistent path is not. The content test now enforces this.

## Structure rules (the test enforces all of these)

- A `.mdx` file not listed in its folder's `meta.json` `pages` array fails the
  suite as an orphan. The root `meta.json` is additionally pinned by
  `ROOT_PAGES` in `src/__tests__/content-tree.test.ts` — changing the root
  sidebar order means editing that test.
- **No new MDX components.** Bare fumadocs-ui defaults only: callouts (GitHub
  alerts `> [!note]` / `tip` / `important` / `warning` / `caution`), code
  blocks, tables. No Tabs, no Cards, no Steps.
- **No screenshots.** None exist; describe screens in words until the
  screenshot pass lands.

## Never invent

Never invent a flag, a default, a version floor, or a permission. Verify
against the code or the app's `AGENTS.md`; when a source is silent, ask the
maintainer rather than guessing product behavior. Old repo docs DO contain
stale counts — verify numbers against current source before writing them.

## Shipping a change

- `bunx changeset` naming **only `@internal/docs`**. Never write a changeset
  for an ignored package — it is inert and wedges the version PR.
- The `docs-v*` tag is cut by the docs workflow, never by hand.

## Verification

```bash
cd apps/docs && bun test                      # content tree + link check
bunx turbo build --filter=@internal/docs      # the real MDX compile check
bun run lint && bun run lint:check            # biome over content + src
bun run verify-types
bun run dev:docs                              # serve at :3400
```

`bun test` and `lint:check` pass on prose the compiler will still reject —
the turbo build is the MDX truth.
