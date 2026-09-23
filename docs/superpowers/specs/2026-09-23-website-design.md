# Marketing Website: apps/website, Release Manifest, install-client.sh

Date: 2026-09-23 · Status: approved design, awaiting written-spec review
Design source: `~/Downloads/concepts/27-live/index.html` (approved by Theo 2026-09-23)

## 1. Problem and goal

The homepage exists only as a concept file. Productionize it as a real app in the
monorepo, deployed at **subshell.sh**, built with React/Tailwind/shadcn, and make its
install section **always show the latest releases** without ever calling the GitHub API.

Decisions already made by the operator:

- App lives at `apps/website`, package `@internal/website` — a site, like `docs`, sitting
  directly under `apps/` because it names none of server/node/client. Apache-2.0.
- Deploy target: **subshell.sh apex**, Cloudflare custom-domain assets Worker, mirroring
  `docs.subshell.sh` exactly.
- The freshness mechanism is a generated `releases.json` committed to `main` by the
  release workflow (option "B" of the brainstorm). **Nothing in this design calls
  `api.github.com`** — plain git and raw file URLs only.
- `install-client.sh` is IN scope (§6). Google Analytics is IN scope (§7). The header
  carries the official GitHub mark (Octicons, MIT) beside the GitHub link (§8).

Non-goals: pages beyond the landing page; a client *CLI binary* (install-client.sh
installs the Subshell Client desktop app — the vocabulary stays clean); i18n; light mode;
www→apex redirects (Cloudflare-level, later); analytics beyond GA4 pageviews.

## 2. App shape (`apps/website`)

Mirrors `apps/docs` conventions everywhere the concerns match:

- Next 16 static export (`output: export`), React 19, Tailwind 4 via
  `@tailwindcss/postcss`, pinned versions matching the monorepo. shadcn/ui vendored into
  `components/ui/` (Button; Card only if needed).
- Scripts mirror docs: `start` (port **3401**), `build`, `preview`, `lint`, `lint:check`,
  `lint:staged`, `test`, `verify-types`, `clean`. No `dev` task, so `bun run start`
  never surprises anyone — `bun run dev:website` is the root entry, like `dev:docs`.
- `build` participates in `bun run build` (lint.yml builds it; broken site fails PR CI).
- Content is the 27-live concept ported to components: `SiteHeader`, `HeroSpread`
  (copy | phone | install), `DeskShot`, `FeatureList`, `SiteFooter`. Fonts Inter +
  JetBrains Mono via the same Google Fonts link as the concepts.
- The orchid-on-void palette is the **marketing** token set (`globals.css` `:root` vars).
  It is deliberately not the SPA design system; `lint:design` stays scoped to product
  surfaces and does not scan `apps/website` (the marketing palette predates the product
  tokens and answers to different decisions).
- Captures become real files: `public/shots/phone-approval-390.png` and
  `public/shots/control-plane-zoom.png` copied from `~/Downloads/concepts/assets/shots/`.
  No data URIs; the file:// constraint was a concept-page artifact.
- Versioning: changesets package like `@internal/docs` — bumping it drives the
  `website-v*` deploy tag, not a GitHub Release component. AGENTS.md gains the one line
  making `apps/website` the taxonomy's second exception next to `apps/docs`.

## 3. The release manifest (`releases.json`)

One file at the repo root, ~1KB, generated, never hand-edited:

```json
{
  "schemaVersion": 1,
  "generatedAt": "2026-09-23T00:00:00Z",
  "components": {
    "cli-server":     { "version": "0.16.0", "tag": "cli-server-v0.16.0",     "url": "https://github.com/subshell-ai/subshell/releases/tag/cli-server-v0.16.0", "installScript": "install-server.sh" },
    "cli-node":       { "version": "0.16.0", "tag": "cli-node-v0.16.0",       "url": "https://github.com/subshell-ai/subshell/releases/tag/cli-node-v0.16.0" },
    "desktop-server": { "version": "0.16.0", "tag": "desktop-server-v0.16.0", "url": "https://github.com/subshell-ai/subshell/releases/tag/desktop-server-v0.16.0" },
    "desktop-client": { "version": "0.6.0",  "tag": "desktop-client-v0.6.0",  "url": "https://github.com/subshell-ai/subshell/releases/tag/desktop-client-v0.6.0", "installScript": "install-client.sh" }
  }
}
```

- `installScript` is present exactly when the script exists at the repo root. It is the
  only input the site uses to decide whether a curl row renders.
- Versions may differ per component; the site never assumes they move together.
- A JSON Schema (`schemaVersion: 1`) is enforced by tests on both ends (generator, site
  parser); unknown extra fields are tolerated, a wrong `schemaVersion` is a parse failure.

## 4. The site reads it

- `lib/releases.ts` fetches
  `https://raw.githubusercontent.com/subshell-ai/subshell/main/releases.json`
  (CORS-enabled, five-minute CDN cache, no auth, no rate-limit exposure).
- At **build time** the app's own `prebuild`/`prestart` script copies the current root
  `releases.json` into `apps/website/data/releases.json` (gitignored; the same one-line
  copy locally and in CI), imported as the **baked first-paint copy**. The
  runtime fetch refreshes it when newer. Fetch failure keeps the baked copy. The page
  never renders a spinner, an error, or a guess.
- Install tabs render only from manifest data:
  - Server tab: button label from platform detection, artifact filename computed from
    `desktop-server.version` via `desktopArtifactFileName` (imported from
    `@internal/subshell-protocol` — Apache, value import, no licence crossing), curl row
    shown because `cli-server.installScript` exists, fine print as today.
  - Client tab: same shape; the curl row renders only if `desktop-client.installScript`
    is present. With §6 shipping, it is.

## 5. Release wiring (generation)

- `scripts/site-releases.ts` (repo-root script, tested): input = `git ls-remote --tags
  origin` (the workflow has a checkout; no API), resolver = `pickLatestRelease` from
  `@internal/subshell-protocol/releases` (the same pure semver code every product
  component runs), output = the manifest above. `--check` mode prints the diff instead of
  writing, for CI.
- `release.yml` publish job gains a final step (per-cut, after releases are live):
  generate → commit `releases.json` to `main` → **verify by fetching the raw URL back**
  and refusing unless it parses with the just-cut versions. Concurrent cuts retry with
  `git pull --rebase` (bounded, 3 attempts). Requires only the `contents: write` the
  workflow already has for tags.
- `release.yml` gains a `refresh_site_manifest` dispatch input: regenerates and commits
  without cutting anything (the repair path).
- A `lint.yml` job runs `scripts/site-releases.ts --check` against the GitHub state —
  drift between the committed file and the tags fails CI, so even a hand-broken commit
  is caught on the next push rather than by a visitor.

## 6. `install-client.sh` (new, repo root)

Installs the Subshell Client desktop app; mirrors `install-server.sh`'s shape (curl|bash,
platform detection, SHA-256 verification, `--version` pin, `--yes`):

- Resolves the tag from `releases.json` (`desktop-client` entry), so it needs no API
  either; downloads
  `https://github.com/subshell-ai/subshell/releases/download/<tag>/<asset>` (a redirect
  to the CDN, not the API) plus its `.sha256` sidecar and verifies before touching
  anything.
- macOS (arm64): `hdiutil attach -nobrowse -mountpoint`, `cp -R "Subshell Client.app"
  /Applications` (replacing an existing copy only with `--yes`, naming the path
  otherwise), `hdiutil detach`. The bundle ships signed, notarized and stapled, so
  Gatekeeper passes without a quarantine workaround.
- Linux (x86_64): `sudo apt-get install -y ./<deb>` when not root — a terminal run CAN
  answer the password prompt, which is the whole difference from the server's sudo rules;
  prints the command and exits 1 if neither root nor sudo exists.
- Post-cut manual check: `scripts/cli-e2e/published-release.sh` gains a client pass
  alongside the server one (needs the public internet, same as today). Pure parts
  (digest verify, version resolution from a fixture manifest, asset-name math) get
  `bun test` coverage via a shell harness.

## 7. Google Analytics

- `components/analytics.tsx`: when `NEXT_PUBLIC_GA_MEASUREMENT_ID` (build-time inlined)
  is non-empty, injects `gtag.js` + a `page_view` send; unset means **no script tag at
  all** in the bundle (empty-is-off, the standing ladder).
- `website.yml` passes the repo **variable** `GA_MEASUREMENT_ID` into the build.
- Pageviews only; no custom dimensions, no PII, no logged-in data. Traffic sources come
  from GA4's standard session source/medium report, which is the actual ask.
- Operator step (§10): create the GA4 property for subshell.sh, set the repo variable.

## 8. GitHub mark

- `components/icons/github.tsx`: the official Octicons `mark-github-16` path with the
  MIT attribution comment, `fill: currentColor`, 15–16px, inline before the label
  (already validated visually in 27-live).

## 9. Deploy (`website.yml`) and wrangler

Verbatim mirroring of `docs.yml` semantics:

- `plan` refuses a dispatch not on `main`, refuses a `-f version=` disagreeing with
  `apps/website/package.json`, and the tag has docs' three cases (absent → create;
  present at this commit → redeploy; present elsewhere → refuse).
- `ci-gate` waits for this commit's Test + Lint runs; `skip_ci_gate` emergency input.
- Build: `bunx turbo build --filter=@internal/website` (the app's prebuild copies
  `releases.json` into `data/`), then `wrangler deploy` from `apps/website`.
- `apps/website/wrangler.jsonc`: assets-only Worker `subshell-website`, `./out`,
  `not_found_handling: "404-page"`, custom domain route `subshell.sh`.
- Changesets: `@internal/website` bumps ride `bunx changeset`; merging the version PR
  sets up the tag; deploy stays an explicit dispatch, exactly like docs.

## 10. Operator tasks (human, not code)

1. Cloudflare: ensure the `subshell.sh` zone lives in the account (docs' secrets
   `CLOUDFLARE_API_TOKEN`/`CLOUDFLARE_ACCOUNT_ID` are still unconfirmed — this wave needs
   them once, shared with docs).
2. GA4 property + repo variable `GA_MEASUREMENT_ID`.

## 11. Testing summary

- `scripts/__tests__/site-releases.test.ts`: fixture tag list → expected manifest;
  latest-per-component selection; prerelease handling; missing-component failure;
  `--check` diff semantics.
- `apps/website`: parser tests (schemaVersion mismatch refuses; unknown fields tolerated),
  install-tab render tests (client without script → no curl row; fetch failure → baked
  copy), version/filename computation tests.
- `install-client.sh`: bun-test shell harness over pure helpers with file:// fixture
  downloads; post-cut manual pass in `published-release.sh`.
- Workflows: `docs.yml`-pattern structure review + a dry dispatch on the merge commit.

## 12. Follow-ups, explicitly deferred

- More pages (features deep-dive, pricing if licensing ever forks).
- `www` subdomain + redirects.
- Self-hosted analytics alternative (only if GA4 proves insufficient).
- Replacing the `.sha256`-sidecar trust in install scripts with the signed release
  manifest (needs the pubkey story on fresh machines; tracked by the updates design).
