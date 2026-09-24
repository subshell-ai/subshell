#!/usr/bin/env bun
/**
 * Fail CI when a NEW dependency advisory appears, and rot-check the allowlist.
 *
 * `bun audit` alone has never been a gate: nothing in CI runs it, so every
 * advisory it can print has sat beside green checks. This gate turns that
 * list into a decision: the
 * set of advisories `bun audit` reports must be a SUBSET of
 * `scripts/dep-audit.ignore.json`, and every entry there must still match
 * something live. A new advisory fails with its GHSA id and title; an
 * allowlisted entry whose package has been fixed (or dropped) warns, so the
 * file records what is true rather than what was once true.
 *
 * The allowlist is the whole design: an in-range `bun audit fix` runs are
 * always applied, and what remains is blocked by a dependent's pin
 * (query-string→decode-uri-component, metro→image-size, xcode→uuid,
 * hash-runner→glob). Each entry carries the reason it is tolerated, so
 * "ignore this" is never the reason.
 *
 *   bun scripts/dep-audit.ts          # what CI runs (root: `bun run audit:deps`)
 */
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

const REPO_ROOT = resolve(new URL("..", import.meta.url).pathname);
const IGNORE_FILE = "scripts/dep-audit.ignore.json";

/** One advisory as `bun audit --json` reports it (subset of fields). */
interface RawAdvisory {
  url?: string;
  title?: string;
  severity?: string;
}

/** An advisory reduced to what matching and reporting need. */
export interface Advisory {
  /** GHSA id from the advisory URL, "" when the URL carried none. */
  ghsa: string;
  title: string;
  severity: string;
}

/** One tolerated package in the ignore file. */
export interface IgnoreEntry {
  package: string;
  /** GHSA ids and/or advisory titles; an advisory matches if either appears here. */
  advisories: string[];
  reason: string;
}

export interface Verdict {
  /** Live advisories not covered by the allowlist. */
  violations: { pkg: string; advisory: Advisory }[];
  /** Allowlisted entries whose package no longer reports any advisory. */
  stalePackages: string[];
  /** Allowlisted advisory strings that matched nothing live. */
  staleAdvisories: { pkg: string; entry: string }[];
}

/** Extract the GHSA id from an advisory URL; "" when absent. */
export function ghsaFromUrl(url?: string): string {
  return url?.match(/GHSA-[a-zA-Z0-9]{4}-[a-zA-Z0-9]{4}-[a-zA-Z0-9]{4}/)?.[0] ?? "";
}

/** Normalise `bun audit --json` output to package → advisories. */
export function advisoriesFrom(raw: Record<string, RawAdvisory[]>): Map<string, Advisory[]> {
  const out = new Map<string, Advisory[]>();
  for (const [pkg, list] of Object.entries(raw)) {
    out.set(
      pkg,
      (list ?? []).map((a) => ({
        ghsa: ghsaFromUrl(a.url),
        title: a.title ?? "",
        severity: a.severity ?? "unknown",
      })),
    );
  }
  return out;
}

/**
 * Compare the live advisory set against the allowlist. Live ⊆ allowlist is the
 * pass condition; allowlist entries are also checked in the other direction so
 * the file cannot rot into claiming vulnerabilities that are long fixed.
 */
export function evaluate(live: Map<string, Advisory[]>, ignore: IgnoreEntry[]): Verdict {
  const violations: Verdict["violations"] = [];
  const staleAdvisories: Verdict["staleAdvisories"] = [];
  const byPackage = new Map(ignore.map((e) => [e.package, e]));
  const liveOnly = new Set(live.keys());

  for (const [pkg, advisories] of live) {
    const entry = byPackage.get(pkg);
    for (const advisory of advisories) {
      const hit = entry?.advisories.includes(advisory.ghsa) || entry?.advisories.includes(advisory.title);
      if (!hit) violations.push({ pkg, advisory });
    }
    if (entry) {
      for (const listed of entry.advisories) {
        if (!advisories.some((a) => a.ghsa === listed || a.title === listed)) {
          staleAdvisories.push({ pkg, entry: listed });
        }
      }
    }
  }
  const stalePackages = ignore.map((e) => e.package).filter((pkg) => !liveOnly.has(pkg));
  return { violations, stalePackages, staleAdvisories };
}

function main(): void {
  // process.execPath, not a PATH lookup: the runtime answering `audit --json`
  // is this script's own, so CI's pinned setup-bun and a developer's newer bun
  // cannot disagree about the output shape mid-flight. (Measured: 1.4.0 and
  // 1.4.2 report the same advisories; 1.4.0 exits 1 when any exist, which the
  // guard below reads as normal by the stdout it produced, not the code.)
  const proc = Bun.spawnSync([process.execPath, "audit", "--json"], { cwd: REPO_ROOT });
  if (proc.exitCode !== 0 && !proc.stdout.toString().trim().startsWith("{")) {
    console.error("bun audit failed:", proc.stderr.toString().trim());
    process.exit(1);
  }
  const live = advisoriesFrom(JSON.parse(proc.stdout.toString() || "{}"));
  const ignore = JSON.parse(readFileSync(resolve(REPO_ROOT, IGNORE_FILE), "utf8")) as IgnoreEntry[];
  const { violations, stalePackages, staleAdvisories } = evaluate(live, ignore);

  for (const pkg of stalePackages) console.warn(`stale allowlist entry: ${pkg} reports no advisories now`);
  for (const s of staleAdvisories) console.warn(`stale allowlist entry: ${s.pkg} no longer reports ${s.entry}`);

  let count = 0;
  for (const [, advisories] of live) count += advisories.length;
  if (violations.length > 0) {
    for (const v of violations) {
      console.error(
        `UNIGNORED ${v.advisory.severity}: ${v.pkg} ${v.advisory.ghsa || v.advisory.title} - ${v.advisory.title}`,
      );
    }
    console.error(
      `\n${violations.length} new advisory/ies above the ${ignore.length}-entry allowlist in ${IGNORE_FILE}.`,
    );
    console.error("Fix with `bun audit fix` (in-range) or add a REASONED entry there.");
    process.exit(1);
  }
  console.log(
    `dep-audit: ${count} advisories across ${live.size} packages, all allowlisted (${ignore.length} entries).`,
  );
  process.exit(0);
}

if (import.meta.main) main();
