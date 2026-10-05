import { closeSync, constants, lstatSync, openSync, readdirSync, readSync, realpathSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, isAbsolute, join, resolve } from "node:path";
import { SSH_MAX_DISCOVERED_ALIASES, SSH_NAME_MAX_CHARS } from "@internal/subshell-protocol";

/**
 * Bounded discovery of SSH alias NAMES (SSH-SUPPORT.md §2: "Discover aliases
 * by bounded parsing of the account's config and includes; omit wildcard-only
 * entries, detect include cycles").
 *
 * This parser answers NAMES, never config contents, and it is deliberately a
 * NAME-HUNT and not an implementation of ssh_config semantics: the authoritative
 * resolution of what an alias means is `ssh -G` (`ssh-resolve.ts`), which is
 * OpenSSH's own evaluator. What must not be outsourced is the BOUNDS: reading
 * the account's config is the one step an alias-rich `Include` chain can turn
 * into arbitrary filesystem traversal and unbounded work, so the walk carries
 * hard budgets (file count, total bytes, include-expansion width) and a cycle
 * detector over its own ancestor chain. A cycle is a FACT the human reviewing
 * the list needs (`includeCycle`), never a silent stop.
 *
 * A few ssh_config facts this parser must still get right, because they decide
 * which names are reported: `Host` takes a whitespace-separated pattern list
 * (wildcard patterns and `!`-negations are not aliases), `Include` takes
 * whitespace-separated globs with `~` expansion, `Match` blocks carry no names,
 * and `#` comments run from unquoted whitespace-preceded hashes. Anything
 * subtler than that is `ssh -G`'s problem by design.
 */

/** The alias list the command answers; mirrors the frozen `NodeSshAliasListResult` shape. */
export interface SshAliasDiscovery {
  /** Alias names, deduplicated, sorted; wildcard-only and negated patterns excluded. */
  aliases: string[];
  /** One config file appeared in another's include ANCESTRY chain; the list is what parsed before the repeat. */
  includeCycle: boolean;
  /** A budget was exhausted or the name cap was reached; more may exist than were returned. */
  truncated: boolean;
}

/** One parsed `Host` block: its pattern tokens and the directives set under it. */
export interface SshHostBlock {
  /** The pattern tokens after `Host` (verbatim, including wildcards/negations). */
  tokens: string[];
  /** Directives under this block, in file order; keyword lowercased, value raw. */
  directives: { keyword: string; value: string }[];
}

/** What one bounded walk produced, for discovery AND resolution to share. */
export interface SshConfigWalk {
  /** Every `Host` block in include order, plus the pre-first-Host global directives. */
  hostBlocks: SshHostBlock[];
  /** Directives seen before any `Host` line (the implicit-global context). */
  globalDirectives: { keyword: string; value: string }[];
  /** A `Match exec` line was seen anywhere in the walk (a local-execution signal §2 refuses on). */
  matchExecSeen: boolean;
  /** The config files that were actually read, walk order (cycle detection is done by the walk itself). */
  files: string[];
  includeCycle: boolean;
  truncated: boolean;
}

/** Budgets for one walk; defaults are the shipped numbers, tests pass smaller. */
export interface SshWalkBudget {
  /** Max config files read in one walk (includes count). */
  maxFiles?: number;
  /** Max bytes read across all files. */
  maxTotalBytes?: number;
  /** Max globs expanded per `Include` directive. */
  maxIncludeMatches?: number;
  /** Longest single line kept (openbsd caps config lines too; longer lines are dropped). */
  maxLineBytes?: number;
}

const DEFAULT_BUDGET = {
  maxFiles: 64,
  maxTotalBytes: 2 * 1024 * 1024,
  maxIncludeMatches: 256,
  maxLineBytes: 4096,
};

/** Default location of the connecting account's SSH client config. */
export function defaultSshConfigPath(homeDir: string): string {
  return join(homeDir, ".ssh", "config");
}

/**
 * An alias name worth reporting: pattern syntax (`*`, `?`), negation (`!`),
 * option-like leading `-`, whitespace, and control characters are all excluded,
 * matching the hygiene the wire grammar applies to aliases
 * (`parseSshNodeCommandBody`'s `isAliasName`) so a name discovery reports is a
 * name resolution can be asked for.
 */
export function isDiscoverableAlias(token: string): boolean {
  return (
    token.length > 0 &&
    token.length <= SSH_NAME_MAX_CHARS &&
    !token.includes("*") &&
    !token.includes("?") &&
    !token.startsWith("!") &&
    !token.startsWith("-") &&
    !/\s|[\p{Cc}]/u.test(token)
  );
}

/** Keyword/value split: `keyword value`, `keyword=value`, case-insensitive keyword. */
function splitKeywordArg(line: string): { keyword: string; arg: string } | null {
  const trimmed = line.trim();
  if (trimmed === "" || trimmed.startsWith("#")) return null;
  // Strip comments: an unquoted `#` preceded by whitespace ends the meaningful
  // text. Quoted values (rare, and only meaningful for Match/exec arguments
  // this parser never evaluates) are left alone rather than half-parsed.
  const comment = findCommentStart(trimmed);
  const body = comment === -1 ? trimmed : trimmed.slice(0, comment).trimEnd();
  if (body === "") return null;
  const eq = body.indexOf("=");
  const ws = body.search(/\s/);
  const cut = eq === -1 ? ws : ws === -1 ? eq : Math.min(eq, ws);
  if (cut === -1) return { keyword: body.toLowerCase(), arg: "" };
  const keyword = body.slice(0, cut).toLowerCase();
  let arg = body.slice(cut);
  if (arg.startsWith("=")) arg = arg.slice(1);
  return { keyword, arg: arg.trim() };
}

/** Index of the comment start: a `#` at position 0 or preceded by whitespace (and not inside quotes). */
function findCommentStart(line: string): number {
  let inSingle = false;
  let inDouble = false;
  for (let i = 0; i < line.length; i++) {
    const ch = line[i];
    if (ch === "'" && !inDouble) inSingle = !inSingle;
    else if (ch === '"' && !inSingle) inDouble = !inDouble;
    else if (ch === "#" && !inSingle && !inDouble && (i === 0 || /\s/.test(line[i - 1]))) return i;
  }
  return -1;
}

/** Expand a leading `~` / `~/` against the home dir; anything else passes through. Exported for {@link resolveSshAliasConfig}: `ssh -G` prints default identity paths in tilde form, and the snapshot grammar takes only absolutes. */
export function expandTilde(raw: string, homeDir: string): string {
  if (raw === "~") return homeDir;
  if (raw.startsWith("~/")) return join(homeDir, raw.slice(2));
  return raw;
}

/**
 * Expand one Include glob to concrete file paths. The pattern is anchored at
 * the longest non-globbing directory prefix; the remainder is matched
 * segment-by-segment against `readdirSync`, capped by `maxMatches`. This is a
 * deliberately small glob engine (`*` and `?` within a segment, no `**`, no
 * bracket classes): ssh_config Include globs that this cannot expand yield
 * fewer aliases, never an unbounded walk.
 */
function expandIncludeGlob(pattern: string, includingFile: string, homeDir: string, maxMatches: number): string[] {
  let expanded = expandTilde(pattern, homeDir);
  if (!isAbsolute(expanded)) expanded = resolve(dirname(includingFile), expanded);
  const segments = expanded.split("/").filter((s) => s !== "");
  const out: string[] = ["/"];
  let atRoot = true;
  for (const segment of segments) {
    atRoot = false;
    const next: string[] = [];
    const globbing = segment.includes("*") || segment.includes("?");
    if (!globbing) {
      for (const base of out) next.push(join(base, segment));
    } else {
      const re = globToRe(segment);
      for (const base of out) {
        let names: string[];
        try {
          names = readdirSync(base);
        } catch {
          continue; // unreadable directory: OpenSSH would skip it too
        }
        for (const name of names) {
          if (re.test(name)) next.push(join(base, name));
          if (next.length >= maxMatches) return atRoot ? [] : next;
        }
      }
    }
    out.length = 0;
    out.push(...next);
  }
  const files: string[] = [];
  for (const p of out) {
    try {
      if (lstatSync(p).isFile()) files.push(p);
    } catch {
      // missing/unreachable: not an error, an empty match
    }
    if (files.length >= maxMatches) break;
  }
  return files;
}

function globToRe(segment: string): RegExp {
  const escaped = segment
    .replace(/[.+^${}()|[\]\\]/g, "\\$&")
    .replaceAll("*", ".*")
    .replaceAll("?", ".");
  return new RegExp(`^${escaped}$`);
}

/** Read one config file within the budgets; returns its lines and mutates the byte total. */
function readCapped(file: string, bytesLeft: number, maxLineBytes: number): { lines: string[]; used: number } {
  let fd: number;
  try {
    // O_NOFOLLOW: a planted symlink at an Include target is refused, not
    // chased — the walk reads the account's config, not whatever a symlink
    // on its path was pointed at.
    fd = openSync(file, constants.O_RDONLY | constants.O_NOFOLLOW);
  } catch {
    return { lines: [], used: 0 };
  }
  try {
    const cap = Math.max(0, Math.min(bytesLeft, DEFAULT_BUDGET.maxTotalBytes));
    if (cap === 0) return { lines: [], used: 0 };
    const buf = Buffer.allocUnsafe(cap + 1);
    const n = readSync(fd, buf, 0, cap + 1, null);
    const used = Math.min(n, cap);
    const text = buf.subarray(0, used).toString("utf8");
    const lines = text.split("\n");
    if (n > cap) lines.pop(); // a cut tail line is a partial line, not data
    return {
      lines: lines.map((l) => (l.length > maxLineBytes ? l.slice(0, maxLineBytes) : l)),
      used: n, // over-budget reads still count what was attempted
    };
  } finally {
    closeSync(fd);
  }
}

/**
 * A quoted Include token: OpenSSH accepts `"…"` around a pattern containing
 * spaces; peel them so the space-split token list stays correct.
 */
function peelQuotes(token: string): string {
  if (token.length >= 2 && token.startsWith('"') && token.endsWith('"')) return token.slice(1, -1);
  return token;
}

/**
 * Walk one account's ssh_config: read the root file, follow `Include` globs
 * with budgets, and collect `Host` block structure + `Match exec` presence.
 * Cycle detection is over the walk's own ACTIVE ancestor chain (a file under
 * itself), so a diamond (two includes of one shared file) dedupes silently
 * while a true cycle raises `includeCycle`. NEVER throws: every fs surprise
 * ends the walk of THAT file, not the discovery.
 *
 * @param rootFile - absolute path of the account's config (may not exist)
 * @param homeDir - the connecting account's home, for `~` expansion
 * @param budget - walk budgets (see {@link SshWalkBudget})
 */
export function walkSshConfig(rootFile: string, homeDir: string, budget: SshWalkBudget = {}): SshConfigWalk {
  const caps = { ...DEFAULT_BUDGET, ...budget };
  const walk: SshConfigWalk = {
    hostBlocks: [],
    globalDirectives: [],
    matchExecSeen: false,
    files: [],
    includeCycle: false,
    truncated: false,
  };
  let filesRead = 0;
  let bytesUsed = 0;
  let currentBlock: SshHostBlock | null = null;
  const seen = new Set<string>(); // every file already parsed (dedupe)
  const active = new Set<string>(); // the ancestor chain (cycle detector)

  const openBlock = (): SshHostBlock => {
    const block: SshHostBlock = { tokens: [], directives: [] };
    walk.hostBlocks.push(block);
    currentBlock = block;
    return block;
  };

  const visit = (file: string): void => {
    let real: string;
    try {
      real = realpathSync(file);
    } catch {
      return;
    }
    if (active.has(real)) {
      walk.includeCycle = true; // a file under its own includer: the §2 fact
      return;
    }
    if (seen.has(real)) return; // a second ordinary include: dedupe, not a cycle
    if (filesRead >= caps.maxFiles || bytesUsed >= caps.maxTotalBytes) {
      walk.truncated = true;
      return;
    }
    active.add(real);
    seen.add(real);
    filesRead += 1;
    walk.files.push(real);
    const budgetLeft = caps.maxTotalBytes - bytesUsed;
    const { lines, used } = readCapped(real, budgetLeft, caps.maxLineBytes);
    bytesUsed += used;
    if (used > budgetLeft) walk.truncated = true; // the file was cut by the byte budget
    for (const rawLine of lines) {
      const line = rawLine.replace(/\r$/, "");
      const parsed = splitKeywordArg(line);
      if (!parsed) continue;
      const { keyword, arg } = parsed;
      if (keyword === "host") {
        const block = openBlock();
        block.tokens = arg
          .split(/\s+/)
          .filter((t) => t !== "")
          .map(peelQuotes);
      } else if (keyword === "include") {
        const tokens = arg
          .split(/\s+/)
          .filter((t) => t !== "")
          .map(peelQuotes);
        for (const token of tokens) {
          for (const included of expandIncludeGlob(token, real, homeDir, caps.maxIncludeMatches)) {
            visit(included);
          }
        }
      } else if (keyword === "match") {
        // `Match exec …` runs a command locally (the §2 execution fact); the
        // criteria keyword pair is what matters, not the command.
        const criteria = arg.toLowerCase();
        if (/(^|\s)exec(\s|$)/.test(criteria)) walk.matchExecSeen = true;
      } else if (keyword !== "") {
        (currentBlock ? currentBlock.directives : walk.globalDirectives).push({ keyword, value: arg });
      }
    }
    active.delete(real);
  };

  visit(rootFile);
  return walk;
}

/**
 * The `ssh_discover_aliases` engine: walk the account's config and answer the
 * deduplicated, sorted alias names under the wire cap. Returns NAMES only —
 * the frozen result envelope carries no config content, and neither does this.
 *
 * @param opts.homeDir - the connecting account's home (default: this process's)
 * @param opts.configPath - the account's config file (default: `<home>/.ssh/config`)
 * @param opts.budget - walk budgets
 */
export function discoverSshAliases(
  opts: { homeDir?: string; configPath?: string; budget?: SshWalkBudget } = {},
): SshAliasDiscovery {
  const homeDir = opts.homeDir ?? homedir();
  const walk = walkSshConfig(opts.configPath ?? defaultSshConfigPath(homeDir), homeDir, opts.budget);
  const names = new Set<string>();
  for (const block of walk.hostBlocks) {
    for (const token of block.tokens) {
      if (isDiscoverableAlias(token)) names.add(token);
    }
  }
  let truncated = walk.truncated;
  let aliases = [...names].sort();
  if (aliases.length > SSH_MAX_DISCOVERED_ALIASES) {
    aliases = aliases.slice(0, SSH_MAX_DISCOVERED_ALIASES);
    truncated = true;
  }
  return { aliases, includeCycle: walk.includeCycle, truncated };
}
