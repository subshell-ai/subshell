import { randomBytes } from "node:crypto";
import { chmodSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { beginBackupStateWrite } from "@/modules/backups/backup-capture-lock.js";
import { parseEnvFile } from "@/modules/server/config/env.js";
import {
  baseUrlPort,
  type ConfigKey,
  FLAG_FOR_KEY,
  isLoopbackUrl,
  normalizeTrustedOrigins,
  OPTIONAL_KEYS,
  OWNED_KEYS,
  validateValue,
} from "@/modules/server/config/values.js";
/** Create the config home if absent, and keep it 0700 (it holds the auth secret). */
export function ensureConfigDir(dir: string): void {
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  // mkdir's mode is umask-clamped and only applies to created segments; the
  // home is re-asserted unconditionally so an old 0755 one gets tightened.
  chmodSync(dir, 0o700);
}
/**
 * Parsed contents of the existing `config.env` ({} when absent). ANY other
 * read failure rethrows — the callers refuse to clobber a file they could
 * not read.
 */
export function readExistingConfig(dir: string): Record<string, string> {
  try {
    return parseEnvFile(readFileSync(join(dir, "config.env"), "utf8"));
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") return {};
    throw err;
  }
}
/**
 * Atomic `config.env` write: temp file in the same directory (0600 — the
 * mode is creation-only, so chmod it explicitly past the umask) + rename.
 * Ensures the config home first. The mtime-keyed readers none; the rename
 * swap is what makes a concurrent systemd EnvironmentFile read see either
 * the old file or the new one, never a half-written one.
 *
 * @returns the absolute path written
 */
export function writeConfigEnv(dir: string, values: Record<string, string>): string {
  const release = beginBackupStateWrite();
  try {
    ensureConfigDir(dir);
    const target = join(dir, "config.env");
    const tmp = join(dir, `.config.env.${process.pid}.${randomBytes(4).toString("hex")}.tmp`);
    const body = [
      "# subshell-server configuration, systemd EnvironmentFile syntax (bare KEY=value lines, no quotes).",
      "# Written by `subshell-server init`/`configure`: comments here do NOT survive a rewrite, but keys",
      "# this tool does not own (e.g. BETTER_AUTH_SECRET) are carried forward verbatim.",
      ...Object.entries(values).map(([key, value]) => `${key}=${value}`),
      "",
    ].join("\n");
    writeFileSync(tmp, body, { mode: 0o600 });
    chmodSync(tmp, 0o600);
    renameSync(tmp, target);
    return target;
  } finally {
    release();
  }
}
/** What a caller wants changed; an absent field means "keep the stored value, or the built-in default". */
export interface ApplyConfigInput {
  /** `SERVER_PORT` as text (the CLI passes flag text; the route stringifies its number). */
  port?: string;
  /** `HOST`. */
  host?: string;
  /** `APP_BASE_URL`. */
  baseUrl?: string;
  /** `TRUSTED_ORIGINS`, comma-joined; the empty string CLEARS the key. */
  trustedOrigins?: string;
  /** `DATABASE_PATH` (CLI only; the route never sends it). */
  dbPath?: string;
}
/** One key the caller asked to change whose stored value the write actually changed. */
export interface ConfigChange {
  /** The config.env key. */
  key: ConfigKey;
  /** What the file held before, or undefined when the key was absent. */
  from: string | undefined;
  /** What the file holds now, or undefined when the key was removed. */
  to: string | undefined;
}
/**
 * Outcome of {@link applyConfig}. The two failures are DISTINGUISHED rather
 * than sharing a `key`, because a caller renders them in different places: an
 * `invalid` belongs under the field that carries the offending value, and an
 * `unreadable` belongs to the file, not to any field. Naming a key for a read
 * failure would put "cannot read config.env" under the Port input.
 */
export type ApplyConfigResult =
  | {
      ok: true;
      /** Absolute path written. */
      path: string;
      /** Every key in the file after the write (foreign keys included). */
      values: Record<string, string>;
      /** Advisory sentences the caller renders; never a refusal. */
      warnings: string[];
      /** The changes an audit log should record. */
      changed: ConfigChange[];
    }
  | {
      ok: false;
      /** A value failed `validateValue`. */
      kind: "invalid";
      /** The key that failed — the field a form should mark. */
      key: ConfigKey;
      /** `validateValue`'s sentence, verbatim — the same one the CLI prints. */
      reason: string;
    }
  | {
      ok: false;
      /** config.env exists but could not be read, so it must not be clobbered. */
      kind: "unreadable";
      /** The file that could not be read. */
      path: string;
      /** The underlying reason, already naming the path. */
      reason: string;
    };
/** One planning pass of {@link applyConfig}: the merged file content, or the refusal. */
type ConfigPlan =
  | { ok: true; values: Record<string, string>; warnings: string[]; changed: ConfigChange[] }
  | { ok: false; kind: "invalid"; key: ConfigKey; reason: string };
/**
 * Resolve, validate and merge against ONE read of the file. Extracted from
 * {@link applyConfig} because the write re-plans against a FRESH read (see
 * there); the two plans must be the same rules, not two implementations.
 */
function planConfigWrite(existing: Record<string, string>, input: ApplyConfigInput, configDir: string): ConfigPlan {
  const warnings: string[] = [];
  /** Resolve + validate one key: given value, else the stored one, else the built-in. */
  const pick = (
    key: ConfigKey,
    given: string | undefined,
    builtin: string,
  ): { ok: true; value: string } | { ok: false; reason: string } => {
    const value = given === undefined ? (existing[key] ?? builtin) : given.trim();
    const invalid = validateValue(key, value);
    if (invalid === null) return { ok: true, value };
    // Preserving what the boot already reads grants nothing new, and refusing
    // it wedged every other key (see `runConfigure`'s own note).
    if (existing[key] === value) {
      warnings.push(
        `${key} kept as found in ${join(configDir, "config.env")}: ${invalid}. ` +
          `This tool will not write that value; pass ${FLAG_FOR_KEY[key]} to replace it.`,
      );
      return { ok: true, value };
    }
    return { ok: false, reason: invalid };
  };

  const port = pick("SERVER_PORT", input.port, "3080");
  if (!port.ok) return { ok: false, kind: "invalid", key: "SERVER_PORT", reason: port.reason };
  const host = pick("HOST", input.host, "0.0.0.0");
  if (!host.ok) return { ok: false, kind: "invalid", key: "HOST", reason: host.reason };
  const baseUrl = pick("APP_BASE_URL", input.baseUrl, `http://localhost:${port.value}`);
  if (!baseUrl.ok) return { ok: false, kind: "invalid", key: "APP_BASE_URL", reason: baseUrl.reason };
  const origins = pick("TRUSTED_ORIGINS", input.trustedOrigins, "");
  if (!origins.ok) return { ok: false, kind: "invalid", key: "TRUSTED_ORIGINS", reason: origins.reason };
  const dbPath = pick("DATABASE_PATH", input.dbPath, join(configDir, "subshell.db"));
  if (!dbPath.ok) return { ok: false, kind: "invalid", key: "DATABASE_PATH", reason: dbPath.reason };

  // Canonicalized here rather than at the write below, because the third
  // warning asks whether the list is EMPTY and " , " is a list that is.
  const normalizedOrigins = normalizeTrustedOrigins(origins.value);

  // The enroll-time loopback trap (spec 2026-08-31), warned at write time: a
  // LAN bind with a loopback base URL makes every REMOTE node dial its own
  // box. Warned, then accepted — flags and scripted answers outrank taste.
  if (host.value === "0.0.0.0" && isLoopbackUrl(baseUrl.value)) {
    warnings.push(
      `HOST=0.0.0.0 (LAN bind) but APP_BASE_URL is loopback (${baseUrl.value}); remote nodes will dial ` +
        "their OWN machine, not this server. Set a reachable APP_BASE_URL (e.g. http://<lan-ip>:" +
        `${port.value}) unless every node is this box.`,
    );
  }
  // The other half of the same trap: a stored base URL naming a port the
  // server will not listen on is the exact 403 "Invalid origin" this key
  // exists to prevent. A default-port base URL is a proxy, not a mismatch.
  const dialPort = baseUrlPort(baseUrl.value);
  if (dialPort !== null && dialPort !== 80 && dialPort !== 443 && String(dialPort) !== port.value) {
    warnings.push(
      `APP_BASE_URL is ${baseUrl.value} but the server will listen on ${port.value}; unless a proxy or an ` +
        `SSH forward on this host maps port ${dialPort} to ${port.value}, a browser dialing ${dialPort} reaches ` +
        `nothing, and one dialing ${port.value} by NAME is refused (403 "Invalid origin"). ` +
        `The exception is this machine's own addresses, which are derived and trusted automatically. ` +
        `Set --base-url to the ` +
        `address you actually browse, or add it to --trusted-origins.`,
    );
  }
  // The third face of the same trap, and what is LEFT of it. The trap used to
  // be total: on a wildcard bind with a loopback base URL the derived set was
  // the two loopback spellings, so a phone or a laptop on the LAN died on the
  // 403 that names nothing. The LAN probe (`modules/network/lan-origins.ts`,
  // 2026-09-17) closed the ADDRESS half with no operator act at all — an
  // origin spelling one of this machine's own interface addresses is trusted
  // on sight — and the same probe cannot know, or spell, the NAMES this
  // machine answers to: `.local`, local DNS, anything else people type that
  // is not an interface address. That half still dies on the nameless 403,
  // which is still what this warning is for. Warned rather than refused, like
  // its two siblings: a box nobody browses by name is a legitimate
  // configuration.
  // EVERY configured origin loopback, not merely an EMPTY list. An explicit
  // `TRUSTED_ORIGINS=http://localhost:5174` names no extra spellings either,
  // so testing for "" alone stayed silent on the same configuration. The
  // dashboard's checklist item asks a different question now (does the
  // EFFECTIVE list hold anything non-loopback, kernel probe included), so the
  // two no longer fire together: a host with any interface address silences
  // the card while this warning still speaks about names, and both answers
  // are true of the machine being configured.
  const everyOriginLoopback = normalizedOrigins
    .split(",")
    .map((entry) => entry.trim())
    .filter(Boolean)
    .every((entry) => isLoopbackUrl(entry));
  if (host.value === "0.0.0.0" && isLoopbackUrl(baseUrl.value) && everyOriginLoopback) {
    warnings.push(
      `HOST=0.0.0.0 (LAN bind) with a loopback APP_BASE_URL (${baseUrl.value}) and nothing but loopback in ` +
        "TRUSTED_ORIGINS: browsers reaching this server by one of this machine's OWN addresses sign in " +
        "fine (those origins are derived and trusted automatically) " +
        'but no NAME is: browsing by a `.local` host or a DNS entry answers 403 "Invalid origin" without ' +
        `naming the key that fixes it. Add the name (${FLAG_FOR_KEY.TRUSTED_ORIGINS} http://<that-name>:${port.value}), ` +
        `or make it the base URL (${FLAG_FOR_KEY.APP_BASE_URL} http://<that-name>:${port.value}).`,
    );
  }

  const values: Record<string, string> = {
    ...existing,
    SERVER_PORT: port.value,
    HOST: host.value,
    APP_BASE_URL: baseUrl.value,
    DATABASE_PATH: dbPath.value,
  };
  // Present-or-absent, never present-and-empty (see OPTIONAL_KEYS): an empty
  // value beats `.env` in the precedence ladder and silently strips the
  // built-in dev origins, which is the footgun this key exists to avoid.
  if (normalizedOrigins === "") delete values.TRUSTED_ORIGINS;
  else values.TRUSTED_ORIGINS = normalizedOrigins;

  const changed: ConfigChange[] = [];
  for (const key of [...OWNED_KEYS, ...OPTIONAL_KEYS] as ConfigKey[]) {
    if (input[INPUT_FIELD_FOR_KEY[key]] === undefined) continue;
    if (existing[key] !== values[key]) changed.push({ key, from: existing[key], to: values[key] });
  }
  return { ok: true, values, warnings, changed };
}
/** Test seam for {@link applyConfig}'s read→rename window. @internal */
export interface ApplyConfigSeams {
  /**
   * Runs between the first read/plan and the pre-rename re-read — exactly
   * where a concurrent writer lands. Production passes nothing; the
   * concurrency tests do.
   */
  beforeReread?: () => void;
}
/** True when two reads of the file hold exactly the same keys and values. */
function sameContents(a: Record<string, string>, b: Record<string, string>): boolean {
  const ka = Object.keys(a);
  if (ka.length !== Object.keys(b).length) return false;
  return ka.every((k) => a[k] === b[k]);
}
/**
 * THE config.env writer: merge the input over the stored values (or the
 * built-in defaults), validate every key with `validateValue`, canonicalize
 * the origins, compute the advisory warnings, and write the file atomically,
 * carrying every key this tool does not own forward verbatim.
 *
 * Shared by `configure`/`init` and by `PATCH /api/admin/server/config`, so
 * the CLI and the SPA cannot disagree about what a valid file is. No prompt,
 * no exit, no output: the caller renders the result.
 *
 * A value BYTE-IDENTICAL to what is already stored is kept (with a warning)
 * rather than refused — the CLI's long-standing leniency, so a hand-written
 * wildcard in `TRUSTED_ORIGINS` does not wedge a port change. Only a CHANGED
 * value has to satisfy the validator.
 *
 * `changed` reports only keys the CALLER named. A key the input omits is
 * resolved from the file or the built-in default, so materializing it (an
 * absent `HOST` becoming the `HOST=0.0.0.0` line it already meant) is not a
 * change anyone made, and an audit log that claimed otherwise would describe
 * a decision nobody took.
 *
 * **Concurrent writers are merged, not clobbered.** The read above and the
 * atomic rename below are not one step, and two surfaces write this file (the
 * dashboard's PATCH and the CLI; two dashboard PATCHes). A writer that
 * renamed straight from its first read would silently revert everything the
 * other one changed — every foreign key included — while both audit rows
 * claimed success. So immediately before the write the file is re-read, and
 * the merge is planned AGAINST THE FRESH CONTENT: this writer's named keys
 * land as it intended (per-key last-writer-wins — only a key BOTH writers
 * named still clobbers, and the writer that renames last is the winner), and
 * every key it did not name takes the value actually on disk, foreign keys
 * included. A file that vanished between the reads is the original empty-merge
 * path; a file that became unreadable is a refusal, same as at the top. Two
 * narrow refusals can appear only because of what a concurrent write did: a
 * caller value that passed only by byte-identical leniency and no longer
 * matches the fresh content, or a key whose FRESH stored value fails
 * validation where the stale one passed. Both write NOTHING — the caller
 * re-sends against the file as it now is.
 */
/**
 * The ONE spelling of the unreadable-file refusal {@link applyConfig} answers
 * with. Its two reads (the opening one and the re-read before the rename) must
 * refuse identically or the second becomes a fact about a different bug; one
 * block is also the point of this function's own `planConfigWrite` extraction.
 */
function unreadableConfigRefusal(
  err: unknown,
  configDir: string,
): Extract<ApplyConfigResult, { ok: false; kind: "unreadable" }> {
  const path = join(configDir, "config.env");
  return {
    ok: false,
    kind: "unreadable",
    path,
    reason: `refusing to rewrite ${path}: ${(err as Error).message}`,
  };
}
export function applyConfig(input: ApplyConfigInput, configDir: string, seams?: ApplyConfigSeams): ApplyConfigResult {
  let existing: Record<string, string>;
  try {
    existing = readExistingConfig(configDir);
  } catch (err) {
    return unreadableConfigRefusal(err, configDir);
  }
  const first = planConfigWrite(existing, input, configDir);
  if (!first.ok) return first;
  seams?.beforeReread?.();
  // Re-read immediately before the write and re-plan on what is ACTUALLY on
  // disk. Unchanged content (the overwhelmingly common case) takes the first
  // plan verbatim; anything else replans, so the second writer's keys survive.
  // The residual window — this read through the rename a few fs calls later —
  // is the same class of millisecond gap the pane-log sweeps accept per file.
  let fresh: Record<string, string>;
  try {
    fresh = readExistingConfig(configDir);
  } catch (err) {
    return unreadableConfigRefusal(err, configDir);
  }
  const plan = sameContents(existing, fresh) ? first : planConfigWrite(fresh, input, configDir);
  if (!plan.ok) return plan;
  const path = writeConfigEnv(configDir, plan.values);
  return { ok: true, path, values: plan.values, warnings: plan.warnings, changed: plan.changed };
}

const INPUT_FIELD_FOR_KEY = {
  SERVER_PORT: "port",
  HOST: "host",
  APP_BASE_URL: "baseUrl",
  DATABASE_PATH: "dbPath",
  TRUSTED_ORIGINS: "trustedOrigins",
} as const satisfies Record<ConfigKey, keyof ApplyConfigInput>;
