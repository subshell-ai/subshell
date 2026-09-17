/** The canonical origin the site is deployed at (docs.subshell.sh). */
export const SITE_ORIGIN = "https://docs.subshell.sh";

/** The repository, and where the docs content lives inside it. */
const EDIT_BASE = "https://github.com/subshell-ai/subshell/edit/main/apps/docs/content/docs";

/**
 * The "Edit this page" URL for a content file.
 *
 * `virtualPath` is fumadocs' virtualized path for a page (`page.path`) —
 * relative to the content root, but the exact prefix the bundler gives it
 * ("" / `docs/` / `content/docs/`) is an internal detail, so any of the
 * plausible spellings are normalized away before joining onto the repo path.
 */
export function editPageUrl(virtualPath: string): string {
  const rel = virtualPath.replace(/^(\.\/)?(content\/)?docs\//, "").replace(/^\.?\//, "");
  return `${EDIT_BASE}/${rel}`;
}
