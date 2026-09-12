/**
 * Ownership and licensing, as the product states them to a user.
 *
 * These are strings a person reads — an About dialog, a Settings screen, a
 * `license` subcommand — not a machine-readable licence declaration. The SPDX
 * ids that tooling consumes live in each `package.json`/`Cargo.toml`, where
 * `bun run lint:licenses` derives them from the path.
 *
 * This file lives in `subshell-protocol` because it is the only Apache-2.0
 * package that server, node, web and mobile all already depend on. The Rust
 * half of the same facts is `crates/desktop-core/src/legal.rs` — two runtimes
 * cannot share one constant, so `scripts/license-fields.ts` asserts the two
 * files and the root `LICENSE` all agree rather than trusting them to.
 */

/** The entity that owns the copyright. The registered name, not the DBA. */
export const COPYRIGHT_HOLDER = "Disaresta, LLC";

/** Year of the copyright notice, matching the root LICENSE. */
export const COPYRIGHT_YEAR = "2026";

/** The notice as it is rendered, e.g. `Copyright 2026 Disaresta, LLC`. */
export const COPYRIGHT_LINE = `Copyright ${COPYRIGHT_YEAR} ${COPYRIGHT_HOLDER}`;

/**
 * One line naming both halves of the split. Deliberately says which is which:
 * "dual-licensed" alone leaves a reader unable to tell what applies to the
 * part they hold.
 */
export const LICENSE_SUMMARY = "AGPL-3.0-only (control plane), Apache-2.0 elsewhere";

/**
 * The AGPL section 7 additional permission, in the one sentence that answers
 * the question people actually have: may I build against this?
 */
export const LICENSE_EXCEPTION_SUMMARY =
  "The API Type Surface exception (AGPL section 7) lets API clients and SDKs use the control plane's type declarations under Apache-2.0, so building against Subshell is not copyleft.";

/** Where the full text lives. */
export const LICENSE_URL = "https://github.com/subshell-ai/subshell/blob/main/LICENSE";

/** The product's own site — what a person means by "Subshell's website". */
export const PRODUCT_URL = "https://subshell.sh";

/** The copyright holder's own site. */
export const COMPANY_URL = "https://disaresta.com";

/** The product name as it is presented to a user. */
export const PRODUCT_NAME = "Subshell";

/**
 * The notice a CLI prints for `license`, ending in a newline.
 *
 * Both licences oblige us to give a recipient the terms (Apache-2.0 §4(a)
 * spells it out), and the CLIs are shipped as BARE single-file binaries — a
 * download renamed into `~/.local/bin` with no LICENSE beside it and nowhere
 * to put one. For a single-file distributable this subcommand IS the
 * accompanying licence file.
 *
 * It is a separate subcommand rather than extra lines on `version` because
 * `version` is a machine contract: the release smoke compares the server's
 * output for exact equality, and scripts parse it.
 */
export function licenseNotice(binary: string, version: string): string {
  return [
    `${binary} ${version}`,
    COPYRIGHT_LINE,
    "",
    LICENSE_SUMMARY,
    `Full text: ${LICENSE_URL}`,
    "",
    // Wrapped here rather than stored wrapped: a GUI reflows the sentence to
    // its own width, and only the terminal needs a fixed column.
    ...wrap(LICENSE_EXCEPTION_SUMMARY, 76),
    "",
  ].join("\n");
}

/** Greedy word wrap. Words longer than `width` are left over-long, not broken. */
function wrap(text: string, width: number): string[] {
  const lines: string[] = [];
  let line = "";
  for (const word of text.split(" ")) {
    if (line === "") line = word;
    else if (line.length + 1 + word.length <= width) line += ` ${word}`;
    else {
      lines.push(line);
      line = word;
    }
  }
  if (line !== "") lines.push(line);
  return lines;
}
