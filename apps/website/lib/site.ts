/**
 * The site's canonical origin, in one place: the custom domain deployed by
 * `website.yml` (the wrangler route spells it as JSON and cannot import
 * this). Everything absolute that names the site flows through it —
 * `metadataBase` in `app/layout.tsx`, the sitemap URL `app/robots.ts`
 * prints, `app/sitemap.ts`'s single entry, and the install column's
 * one-liners in `lib/install.ts`.
 *
 * The one-liners fetch the install scripts from HERE: the build ships this
 * site's own copies of the root `install-server.sh` / `install-client.sh`
 * (`scripts/prepare-data.ts`), so the command a visitor copies reads as the
 * product, not the git host. The discipline this buys — an edited root
 * script means redeploying the site before the published one-liner is
 * trustworthy — is recorded in `docs/release-and-ci.md`; the post-cut
 * tripwire is the byte-compare step in `scripts/cli-e2e/published-release.sh`.
 */
export const SITE_ORIGIN = "https://subshell.sh";
