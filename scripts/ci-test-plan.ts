#!/usr/bin/env bun
/**
 * Decide which of `test.yml`'s test-slice jobs a run actually needs.
 *
 * The workflow split the suites so a red job names its own territory; this is
 * the other half — a green PR that touched one package should not pay for the
 * other seven. Routing uses TURBO's OWN change-impact, never hand-written
 * globs: `turbo run test --filter='...[BASE]'` answers "which packages changed
 * since BASE, plus every package that depends on a changed one" from the real
 * build graph. A `packages/subshell-protocol` edit therefore lands in the
 * mobile slice automatically — which is the defect class `verification.md`
 * records (a protocol change that broke ONLY the mobile build and nothing
 * else), and exactly what directory globs on job triggers would re-hide.
 *
 * The script emits one `flag=true|false` line per slice to $GITHUB_OUTPUT.
 *
 * It fails LOUD-AND-WIDE: every path that cannot answer with confidence — an
 * unreadable base ref (force-push, branch sync), a turbo error, a changed
 * package that maps to no slice (a workspace added without registering it) —
 * returns ALL flags true, with the reason printed. A router that silently
 * under-runs is worse than no router; the worst outcome here is today's CI.
 *
 *   bun scripts/ci-test-plan.ts <base-ref>      # writes $GITHUB_OUTPUT, echoes the plan
 */
import { appendFileSync } from "node:fs";

/** The eight slice flags `test.yml` gates on, in the order the workflow reads them. */
export interface SliceFlags {
  web: boolean;
  mobile: boolean;
  desktop: boolean;
  serverNode: boolean;
  packages: boolean;
  scripts: boolean;
  smoke: boolean;
  e2e: boolean;
}

/** One package the change-impact filter selected. */
export interface AffectedPackage {
  /** Package name as turbo reports it, e.g. `@internal/server-web`. */
  name: string;
  /** Repo-relative directory, e.g. `apps/server/web`. */
  dir: string;
}

const FLAG_KEYS: readonly (keyof SliceFlags)[] = [
  "web",
  "mobile",
  "desktop",
  "serverNode",
  "packages",
  "scripts",
  "smoke",
  "e2e",
];

/**
 * Workspace → slice, for the packages the impact filter reports by NAME.
 * Everything under `packages/**` folds into the `packages` slice by directory
 * (the plugins nest two deep to enumerate and gain new ones; the AGENTS.md
 * vocabulary says one edit site beats two that drift). `scripts` and `smoke`
 * are decided by the predicates below on top of this.
 */
const SLICE_BY_PACKAGE: Readonly<Record<string, keyof SliceFlags>> = {
  "@internal/server-web": "web",
  "@internal/mobile": "mobile",
  "@internal/desktop-server": "desktop",
  "@internal/desktop-client": "desktop",
  "@internal/server": "serverNode",
  "@internal/node": "serverNode",
  "@internal/e2e": "e2e",
};

/** The all-runs baseline every degraded path returns. */
export function allFlags(): SliceFlags {
  return {
    web: true,
    mobile: true,
    desktop: true,
    serverNode: true,
    packages: true,
    scripts: true,
    smoke: true,
    e2e: true,
  };
}

/** No flags at all — returned ONLY when the change is provably doc/config-only. */
function noFlags(): SliceFlags {
  return {
    web: false,
    mobile: false,
    desktop: false,
    serverNode: false,
    packages: false,
    scripts: false,
    smoke: false,
    e2e: false,
  };
}

/**
 * Which files could the `Test: scripts` suites NOTICE?
 *
 * Those tests are not self-contained the way a package suite is — they READ
 * the repo: `package-releases` enumerates every `package.json` under
 * `packages/` and the CHANGELOGs beside them (its staleness made main red for
 * three pushes when four plugins became publishable without the expectation
 * moving), `license-fields` walks
 * every package.json and Cargo.toml, `lockfile-workspace-versions` reads
 * bun.lock, the design-linter reads the token files under `apps/`. So the
 * trigger is "anything a script could have been asserting about", and a
 * change to ANY of those must run them even though the suites live nowhere
 * near the change.
 */
export function scriptsTouched(files: readonly string[]): boolean {
  for (const f of files) {
    if (f.startsWith("scripts/")) return true;
    if (f === "bun.lock" || f === "package.json" || f === "turbo.json" || f === "biome.jsonc") return true;
    if (f.startsWith(".changeset/")) return true;
    if (/(^|\/)package\.json$/.test(f) && (f.startsWith("packages/") || f.startsWith("apps/") || f.startsWith("e2e/")))
      return true;
    if (f.startsWith("apps/") || f.startsWith("packages/")) return true;
  }
  return false;
}

/**
 * Pure routing: the affected set + the changed-file list in, the flags out.
 * `reason` is what gets printed beside the flags — "why eight greys or six
 * greens", so a mis-routed PR is debuggable from the Plan log alone.
 */
export function computePlan(
  affected: readonly AffectedPackage[],
  changedFiles: readonly string[],
): { flags: SliceFlags; reason: string } {
  const names = new Set(affected.map((p) => p.name));

  // The root pseudo-package in the affected set means a GLOBAL input changed
  // (lockfile, root tsconfig/biome, turbo.json) — turbo invalidated everything
  // it hashes; no slice may claim exemption.
  if (names.has("//")) return { flags: allFlags(), reason: "global inputs changed (root package appears in affected set)" };

  // Unknown packages: a workspace added without registering here. Running all
  // slices is the loud-and-wide failure; skipping it would be the silent one.
  const unknown = affected.filter(
    (p) => !(p.name in SLICE_BY_PACKAGE) && !p.dir.startsWith("packages/"),
  );
  if (unknown.length > 0) {
    return {
      flags: allFlags(),
      reason: `unregistered affected packages (add them to SLICE_BY_PACKAGE): ${unknown.map((p) => p.name).join(", ")}`,
    };
  }

  const flags = noFlags();
  for (const p of affected) {
    const slice = SLICE_BY_PACKAGE[p.name];
    if (slice) flags[slice] = true;
    if (p.dir.startsWith("packages/")) flags.packages = true;
  }

  const serverAffected = names.has("@internal/server");
  flags.scripts = scriptsTouched(changedFiles);
  // The compiled-binary smoke bundles the server AND everything it imports;
  // `@internal/server` ∈ affected IS that closure (dependents-of-changed is
  // how the filter is built). `scripts/**` covers the smoke's own shell script.
  flags.smoke = serverAffected || changedFiles.some((f) => f.startsWith("scripts/"));

  const why: string[] = [];
  for (const k of FLAG_KEYS) if (flags[k]) why.push(k);
  return { flags, reason: why.length ? `slices with work: ${why.join(", ")}` : "nothing a test slice reads has changed" };
}

/** Run a command, returning stdout; null on any failure (the caller fails wide). */
function run(args: string[]): string | null {
  const proc = Bun.spawnSync({ cmd: args, cwd: new URL("..", import.meta.url).pathname });
  if (proc.exitCode !== 0) return null;
  return proc.stdout.toString();
}

function main(): void {
  const out: Record<string, string> = {};
  const failWide = (reason: string): never => {
    console.log(`PLAN: ${reason} — running every slice`);
    for (const k of FLAG_KEYS) out[k] = "true";
    emit(out);
    process.exit(0);
  };

  const base = process.argv[2];
  if (!base) failWide("no base ref given (not a PR/push we can diff)");

  // A ref the clone cannot see (force-push, shallow history, deleted head) is
  // exactly the case a router must not guess about.
  if (run(["git", "rev-parse", "--verify", "--quiet", `${base}^{commit}`]) === null) {
    failWide(`base ref ${base} is not resolvable in this checkout`);
  }

  const diff = run(["git", "diff", "--name-only", `${base}...HEAD`]);
  if (diff === null) failWide(`git diff against ${base} failed`);
  const changedFiles = diff.split("\n").filter((f) => f.length > 0);

  if (changedFiles.length === 0) {
    // Empty diff, legitimately: an empty push or a merge-base that IS HEAD.
    console.log("PLAN: no changed files — nothing to run");
    for (const k of FLAG_KEYS) out[k] = "false";
    emit(out);
    process.exit(0);
  }

  const dry = run(["bunx", "turbo", "run", "test", `--filter=...[${base}]`, "--dry=json"]);
  if (dry === null) failWide(`turbo --filter=...[${base}] failed`);

  let affected: AffectedPackage[];
  try {
    const parsed = JSON.parse(dry) as { tasks?: { task?: string; package?: string; directory?: string }[] };
    const seen = new Map<string, AffectedPackage>();
    for (const t of parsed.tasks ?? []) {
      if (t.task !== "test" || typeof t.package !== "string") continue;
      seen.set(t.package, { name: t.package, dir: t.directory ?? "" });
    }
    affected = [...seen.values()];
  } catch {
    failWide("turbo --dry output was not parseable JSON");
  }

  const { flags, reason } = computePlan(affected, changedFiles);
  console.log(`PLAN: ${reason}`);
  for (const k of FLAG_KEYS) {
    out[k] = flags[k] ? "true" : "false";
    console.log(`  ${k}=${out[k]}`);
  }
  emit(out);
  process.exit(0);
}

/**
 * Append the flags where Actions reads them. Synchronous on purpose — every
 * caller follows with `process.exit`, and a pending `Bun.write` would die on
 * the way out and leave the plan job emitting empty outputs.
 */
function emit(flags: Record<string, string>): void {
  const target = process.env.GITHUB_OUTPUT;
  if (!target) return;
  const body = Object.entries(flags)
    .map(([k, v]) => `${k}=${v}`)
    .join("\n");
  appendFileSync(target, `${body}\n`);
}

if (import.meta.main) main();
