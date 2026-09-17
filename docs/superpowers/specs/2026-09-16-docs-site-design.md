# Docs site: `apps/docs` → docs.subshell.sh

Date: 2026-09-16 · Status: implementing · Decisions were made live with the operator; this is the record.

## Why

Subshell's user-facing story today is a 600-line README plus internal engineering docs
(`docs/overview.md`, `docs/security.md`, `docs/architecture.md`, `docs/node-protocol.md`)
and package READMEs. Good material, no home, no structure aimed at the person who just
installed a control plane and wants their agents reachable from any device. The audience is
developers doing agentic work, so the site must take MDX, be trivially contributable from
the outside, and deploy through the same kind of tagged, workflow-owned process as every
other component here.

## Decisions

| decision | choice | rejected alternatives, and why |
|---|---|---|
| repo home | `apps/docs` workspace in this monorepo | A separate `subshell-ai/docs` repo (NetBird's shape) keeps the contribution clone small but guarantees drift: CLI verbs, plugin ids and env vars live here, and one repo means one PR can move code and docs together. The CLA already gates every contribution; a docs-only repo would need a second policy conversation. |
| framework | **Fumadocs** (fumadocs-ui/core 16.15.x, fumadocs-mdx 15.4.x, Next.js 16.3.x, static export) | Starlight was the orchestrator's recommendation (smallest contributor surface, Pagefind search built in); the operator chose Fumadocs — Next.js-native, one library family from the Ask-AI/llms.txt/MCP features an agentic audience is the reason the site exists. Docusaurus: heavier, search wants Algolia. VitePress: no real MDX. Mintlify: hosted platform, costs per seat, gives away the content location. |
| hosting | **Cloudflare Workers static assets**, custom domain `docs.subshell.sh` | GitHub Pages was chosen earlier in the session, then superseded together with the framework choice: Cloudflare's own guidance is "start new projects with Workers", and the eventual server-features step (below) deploys a Worker — Pages can't take it. Workers custom domains require the zone on Cloudflare, so `subshell.sh` nameservers move from Porkbun (no MX records exist; the move can't break mail). |
| build tool | **plain `next build` with `output: 'export'`** | The operator asked about **vinext** (Cloudflare's Vite reimplementation of the Next API surface — a Fumadocs template exists upstream). Rejected for day one: still `1.0.0-beta.x`, largely AI-authored in a week, with a public critical-vulnerability history (Vercel disclosed 2 critical/2 high; independent reporting found more). The class of friction it carries today — `'use client'` wrappers for Fumadocs components, OG-image native-module swaps, worker routing fixes — is exactly what a docs repo should not own. **At a stable vinext 1.0, swap the build step only**: the Worker, custom domain and deploy workflow stay. |
| tagging | `docs-vX.Y.Z`, pushed by `.github/workflows/docs.yml` (dispatch-only), `@internal/docs` versioned by changesets (deliberately NOT in the `ignore` list) | Matches "tagging and releasing is owned by the workflow — never cut tags by hand." A docs-only version PR wakes no publish job (npm-publish probes only `@subshell-ai/*`). Contributor cost, accepted: a content PR that should ship needs a `bunx changeset` naming `@internal/docs`; a drive-by typo PR merges freely and simply waits for the next version PR. |
| structure | the ten-group sidebar below, NetBird-shaped (About → Get Started → concept groups → Develop → Reference → Help) | Approved as-is by the operator. |
| first scope | scaffold + full tree of **stub pages** + tagged deploy + a real Contributing page | Content migration is a per-group follow-up PR; the site launches with a complete, navigable skeleton whose stubs name their repo sources, so every future page has an owner list. |

## The site

`apps/docs` — Fumadocs on Next.js 16, Tailwind v4, static export to `out/`. Search is the
static index (`staticGET` route + client `type: 'static'`); at this corpus size the
browser-side index download is the right trade and keeps the deploy assets-only. `llms.txt`
and `llms-full.txt` are emitted at build (the audience runs agents; make the docs
machine-readable). Every page carries an Edit-on-GitHub link and a git-derived
last-updated stamp. Dev server is `bun run dev:docs` (:3400) and, like the desktop apps,
the package has **no `dev` script** so `turbo watch dev` never starts it.

A `content-tree.test.ts` (`bun test` in apps/docs) pins the contract: every `meta.json`
entry resolves, every page has title+description frontmatter, no orphans. That test is
what lets a stranger contribute a file without reviewing a framework.

### Sections (sidebar order)

1. **About** — What is Subshell · How it works · Security model · Subshell vs alternatives · Supported platforms
2. **Get Started** — Quickstart · Install Subshell Server (desktop / headless / Docker) · Your first subshell · Mobile and Tablet
3. **Use Subshell** — Subshells · Workspaces and panes · Sharing · Notifications · Presets · Channels and cross-subshell coordination · Devices
4. **Agents** — Overview · Claude Code · Codex · Hermes · OpenCode · Pi · Terminal · Installing agent CLIs · Plugins from the registry
5. **Nodes** — What a node is · Add a node · Subshell Client as a node · Sharing a node · Directory allowlist · Maintenance mode · Managing the agent · Updating a node
6. **Server** — Overview · Headless install · Configuration · Running as a service · Docker · Networking · Network plugins (Tailscale, Headscale, NetBird, Cloudflare Tunnel) · Users and roles · Registration and enrollment · API keys · Backups · Updating · Logs and debug logging · Audit log · Reset
7. **Automation and MCP** — The subshell MCP server · MCP tool reference · REST API · System API keys
8. **Develop** — Build a harness plugin · Build a network plugin · Plugin API · Publish a plugin · Contribute to Subshell · Contribute to these docs
9. **Reference** — subshell-server CLI · subshell CLI · Environment variables · Files and paths · Ports and firewalls · Version compatibility · Node protocol · Glossary
10. **Help** — Troubleshooting · FAQ · Release notes · Support

Vocabulary follows `AGENTS.md`: server = control plane, node = a machine running agents,
client = a human interface. The docs are where users will *learn* that vocabulary, so the
About group teaches it explicitly rather than assuming the README did.

## Deploy (`.github/workflows/docs.yml`)

Dispatch-only, gated by a self-contained `ci-gate` job: it polls the push-triggered Test
and Lint runs for the exact commit and refuses to deploy anything else, because a
publishing action must not outrun a red suite. (The same gate design was prototyped for
release cuts and since reverted from main; docs keeps its own copy independently of that
decision. `skip_ci_gate` is handled inside the job body — a job-level `if:` would cascade
its skip into `needs:` and the waiver would skip the deploy itself.) `plan`
refuses non-main, reads the version from `apps/docs/package.json` (a `version` input must
agree with it), and owns the `docs-vX.Y.Z` tag with the three-case idiom: absent → cut;
present at this commit → redeploy (re-dispatch completes a half-deploy, per the release
rule); present elsewhere → refuse (published; delete the tag to redeploy). `build` runs
`turbo build --filter=@internal/docs --force` (no `outputs` on the task, same as every
release build) and uploads `out/`. `deploy` runs `wrangler deploy` via
cloudflare/wrangler-action against `apps/docs/wrangler.jsonc` — an assets-only Worker with
the `docs.subshell.sh` custom-domain route, TLS automatic. PR-time checking is free:
`bun run build` and `verify-types` already exercise every workspace package in CI.

Repo wiring: `scripts/license-fields.ts` gained `apps/*/package.json` (top-level app
manifests were invisible to `lint:licenses` until a docs package made that matter), the
changesets README lists `@internal/docs` as releasable, and the two stale "the repo is
private" sentences (AGENTS.md, test.yml) were fixed when the visibility claim they argue
from turned out to be wrong.

## Operator steps (Cloudflare — one-time, not automatable from the repo)

1. Add zone `subshell.sh` (Free plan); import scan; then at Porkbun swap the four
   `*.ns.porkbun.com` nameservers for Cloudflare's two and wait for activation.
2. Clean the zone: delete Porkbun parking records (`*`, `www`, `docs` CNAMEs to
   `pixie.porkbun.com`, apex A to 207.207.210.107/.229). Leave **no** `docs` record — the
   custom-domain creation fails on a pre-existing CNAME.
3. API token: Account · Workers Scripts · Edit; Zone · Workers Routes · Edit; Zone · DNS ·
   Edit; scoped to this zone. Secrets: `CLOUDFLARE_API_TOKEN`, `CLOUDFLARE_ACCOUNT_ID`.
4. First deploy: merge the scaffold PR → merge the version PR → `gh workflow run docs.yml`.
   Wrangler creates the Worker and custom domain; cert issuance takes a few minutes.

## Follow-ups

- Content migration, one group per PR (README slimming lands with Get Started + Server).
  Open questions the stubs parked in their intent paragraphs, needing a maintainer call:
  which alternatives `about/vs-alternatives` compares against (none enumerated in-repo);
  which harness hooks report which attention states (`use/notifications`); which settings
  fields the Headscale plugin exposes for the login-server URL; the exact boundary between
  `status`, the log file, and the service manager's log (`server/logs-debug`); the
  definitive outbound-destination list (`reference/ports-and-firewalls`); and whether a
  support channel exists yet (`help/support` names one only once it does).
- Generate the two CLI reference pages from the `cli.ts` usage blocks at build time — the
  monorepo makes drift detectable; do it before the manual pages get long.
- OpenAPI rendering for the REST API page (fumadocs-openapi) once a spec file is exported.
- **vinext at stable 1.0**: swap the build, drop `output: 'export'`, turn on server routes
  (search API, Ask AI, docs MCP endpoint). The Worker and domain stay as they are.
- PR preview deploys (`wrangler versions upload`).
