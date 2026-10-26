/**
 * The PATH question `init` asks in place of the installer script's old
 * `~/.local/bin is not on your PATH` echo (spec 2026-09-26). The line is
 * appended to zsh startup files the way the note told a human to do it by
 * hand, idempotently, and ONLY where an append cannot surprise anyone:
 *
 * - `~/.zprofile` is the CREATE-SAFE file. macOS terminal sessions are login
 *   shells, and a login shell sources `.zprofile` if it exists — so creating
 *   it from nothing is exactly the act the old note described, and nothing
 *   else changes on the machine. `.zshrc` is NOT create-safe: it governs
 *   interactive-shell behavior beyond PATH (prompts, completions, aliases
 *   people expect from their own file), so it is touched only when the user
 *   already has one, and even then only with the same single line.
 * - Both writes check the file's own text first: anything that already
 *   carries an `export PATH=` naming `.local/bin` is left byte-identical, so
 *   re-running `init --yes` in a script can never stack duplicates.
 */

import { appendFileSync, existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";

/** The exact line the old installer note told humans to add, verbatim. */
export const LOCAL_BIN_EXPORT = 'export PATH="$HOME/.local/bin:$PATH"';

/** Where the binary lands: `BIN_DIR="$HOME/.local/bin"` in install-server.sh. */
export function localBinDir(home: string): string {
  return join(home, ".local", "bin");
}

/**
 * Is `~/.local/bin` on PATH? `undefined` means UNDECIDABLE (this process was
 * handed no PATH to inspect) — the caller skips the whole offer rather than
 * promising a fix for a file it cannot see.
 */
export function localBinOnPath(pathValue: string | undefined, home: string): boolean | undefined {
  if (pathValue === undefined) return undefined;
  const bin = localBinDir(home);
  return pathValue.split(":").some((entry) => entry === bin || entry === `${bin}/`);
}

/** True when the text already carries an `export PATH=` naming `.local/bin`. */
function listsLocalBin(content: string): boolean {
  return /export\s+PATH=[^\n]*\.local\/bin/.test(content);
}

/** What one profile file got. `absent` means "we do not create that file". */
export type ProfileOutcome = "created" | "appended" | "already-present" | "absent";

/**
 * Append {@link LOCAL_BIN_EXPORT} to `~/.zprofile` (created 0644 when absent,
 * the login-shell file the export belongs in) and to `~/.zshrc` ONLY when one
 * already exists. A file whose text already lists `.local/bin` in an
 * `export PATH=` is left byte-identical.
 */
export function addLocalBinToProfiles(home: string): { zprofile: ProfileOutcome; zshrc: ProfileOutcome } {
  return {
    zprofile: appendUnlessListed(join(home, ".zprofile"), true),
    zshrc: appendUnlessListed(join(home, ".zshrc"), false),
  };
}

/**
 * One file's write, in its three shapes: create it (only where creation is
 * safe), append to it, or leave it exactly as found because it already
 * carries an equivalent export.
 */
function appendUnlessListed(path: string, createIfAbsent: boolean): ProfileOutcome {
  const existed = existsSync(path);
  if (!existed && !createIfAbsent) return "absent";
  const content = existed ? readFileSync(path, "utf8") : "";
  if (listsLocalBin(content)) return "already-present";
  const body = content === "" || content.endsWith("\n") ? `${LOCAL_BIN_EXPORT}\n` : `\n${LOCAL_BIN_EXPORT}\n`;
  if (!existed) {
    // The mode is creation-only (an existing file keeps its own); 0644 so a
    // login shell can read it back whatever the umask said.
    writeFileSync(path, body, { mode: 0o644 });
    return "created";
  }
  appendFileSync(path, body);
  return "appended";
}
