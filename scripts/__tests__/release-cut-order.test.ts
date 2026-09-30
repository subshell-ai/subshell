import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";

/**
 * The cut-order ruling (operator, 2026-09-30): a cut builds and publishes the
 * CLIs first, then the desktop apps — because each desktop bundle SHIPS the
 * CLI binary the release page offers, and stageSidecar now DOWNLOADS that
 * artifact (signature + digest verified) instead of rebuilding one. GitHub
 * cannot express needs per matrix leg, so the phases are separate jobs whose
 * bodies are deliberately duplicated. A duplicate nobody guards becomes two
 * sources of truth by the next urgent fix; this file is the guard.
 */

const WORKFLOW = readFileSync(join(import.meta.dir, "../../.github/workflows/release.yml"), "utf8");

/** The raw text of one job, from its key line to the next top-level key. */
function job(name: string): string {
  const start = new RegExp(`^  ${name}:$`, "m");
  const m = start.exec(WORKFLOW);
  if (m === null) throw new Error(`job '${name}' not found (renamed?)`);
  const rest = WORKFLOW.slice(m.index + m[0].length + 1);
  const next = /^ {2}[a-z][a-z0-9-]*:$/m.exec(rest);
  return rest.slice(0, next ? next.index : rest.length);
}

/** A job's header: everything before its steps, where its `if` gate lives. */
function header(name: string): string {
  const block = job(name);
  const i = block.indexOf("\n    steps:");
  return i === -1 ? block : block.slice(0, i);
}

/** A job's step definitions, where drift would hide. */
function steps(name: string): string {
  const block = job(name);
  const i = block.indexOf("\n    steps:");
  if (i === -1) throw new Error(`job '${name}' has no steps block`);
  return block.slice(i);
}

describe("cut phases: CLI first, desktop after", () => {
  test("the plan splits its matrix and app lists by phase", () => {
    const plan = job("plan");
    for (const out of ["cli_matrix", "desktop_matrix", "cli_apps", "desktop_apps"]) {
      expect(plan).toContain(`${out}: \${{ steps.compute.outputs.${out} }}`);
      expect(plan).toContain(`echo '${out}=[]' >> "$GITHUB_OUTPUT"`);
    }
    // The single-phase spellings are gone: no consumer may read a mixed
    // matrix and re-parallelize the phases by accident.
    expect(plan).not.toMatch(/outputs\.matrix\b/);
    expect(plan).not.toMatch(/outputs\.apps\b/);
  });

  test("the wiring is a chain, not a fan", () => {
    expect(job("build-cli")).toContain("needs: plan");
    expect(job("build-cli")).toContain("cli_matrix");
    expect(job("publish-cli")).toContain("needs: [plan, build-cli]");
    expect(job("build-desktop")).toContain("needs: [plan, publish-cli]");
    expect(job("build-desktop")).toContain("desktop_matrix");
    // A skipped CLI phase (a desktop-only dispatch, an earlier CLI cut) must
    // not strand the desktop half; a FAILED one must stop it.
    expect(header("build-desktop")).toContain("needs.publish-cli.result == 'skipped'");
    expect(job("publish-desktop")).toContain("needs: [plan, build-desktop]");
    expect(job("publish-desktop")).toContain("desktop_apps");
    // The failure half of the tolerance: a SKIPPED publish-cli (desktop-only
    // dispatch) may pass, a FAILED one must stop it. The tolerance is
    // deliberately ONLY here: a publish job tolerating a skipped build would
    // try to publish bytes that were never built, so both publish gates stay
    // plain app-list guards and GitHub's needs blocking stays load-bearing.
    expect(header("build-desktop")).toContain("needs.publish-cli.result == 'success'");
    expect(header("publish-cli")).not.toContain("result ==");
    expect(header("publish-desktop")).not.toContain("result ==");
    // GitHub's implicit-success trap: an `if` with NO status-check function
    // is wrapped in success() over all needs, and that gate runs before the
    // expression. A `result == 'skipped'` tolerance is therefore inert on
    // exactly the cut it exists for: the skipped need skips the job first.
    // Every header that reads needs.*.result must displace the implicit gate
    // with `!cancelled()` — the weakest function that does it, since a
    // cancelled run must still stop publishes and pushes.
    expect(header("build-desktop")).toContain("!cancelled()");
    expect(header("site-manifest")).toContain("!cancelled()");
    // And no header may use always(), which would displace the gate the other
    // way — papering over a FAILED or CANCELLED chain. (The one always() in
    // the build bodies is a STEP guard, un-rooting the container workspace,
    // not a gate, so the check stays scoped to headers.)
    for (const name of ["build-cli", "build-desktop", "publish-cli", "publish-desktop", "site-manifest"]) {
      expect(header(name)).not.toContain("always()");
    }
    // The website's manifest refresh waits for every phase that ran.
    expect(job("site-manifest")).toContain("needs: [plan, publish-cli, publish-desktop]");
  });

  test("the desktop shard gets a job token to download the release with", () => {
    expect(steps("build-desktop")).toContain("GH_TOKEN: ${{ secrets.GITHUB_TOKEN }}");
    // And the fetch is what stages the sidecar: the step never sets the
    // source escape (CI builds shipped bytes, never local ones).
    expect(steps("build-desktop")).not.toContain("SUBSHELL_SIDECAR_FROM_SOURCE");
    // The fetch is Bun's fetch against the API, not the gh CLI: the linux
    // desktop shard's container has no gh, and a cut may not care.
    expect(steps("build-desktop")).not.toMatch(/\bgh release\b/);
  });

  test("the plan's phase splitter divides by prefix, actually", () => {
    // The wiring pins above prove the strings exist; running the plan's own
    // node script proves it SPLITS. A regex that matched the old mixed-matrix
    // shape while the filter mis-sorted an app would ship a CLI leg into the
    // desktop phase, exactly the mixup the plan's prefix-guard loop catches.
    const m = WORKFLOW.match(/node -e '\n([\s\S]*?)'\s*"\[\$entries\]" "\[\$appsjson\]"/);
    if (m === null) throw new Error("the plan's splitter script is gone or reshaped");
    // The newline after `node -e '` is the splitter's shape: the plan's
    // other node -e (the draft check on the skip path) is a one-liner.
    const entries = JSON.stringify([
      { app: "cli-server", triple: "linux-x64" },
      { app: "cli-node", triple: "darwin-arm64" },
      { app: "desktop-server", triple: "linux-x64" },
      { app: "desktop-client", triple: "darwin-arm64" },
    ]);
    // The plan's apps list is objects (the publish matrix consumes them), so
    // the splitter filters on x.app in BOTH lists.
    const appNames = ["cli-server", "cli-node", "desktop-server", "desktop-client"];
    const apps = JSON.stringify(appNames.map((app) => ({ app, dir: "x", version: "1.0.0", tag: `${app}-v1.0.0` })));
    const proc = Bun.spawnSync(["node", "-e", m[1], entries, apps], { stdout: "pipe", stderr: "pipe" });
    expect(proc.exitCode).toBe(0);
    const out: Record<string, string> = {};
    for (const line of proc.stdout.toString().trim().split("\n")) {
      const i = line.indexOf("=");
      out[line.slice(0, i)] = line.slice(i + 1);
    }
    expect(JSON.parse(out["cli_matrix"]).map((x: { app: string }) => x.app)).toEqual(["cli-server", "cli-node"]);
    expect(JSON.parse(out["desktop_matrix"]).map((x: { app: string }) => x.app)).toEqual([
      "desktop-server",
      "desktop-client",
    ]);
    expect(JSON.parse(out["cli_apps"]).map((x: { app: string }) => x.app)).toEqual(["cli-server", "cli-node"]);
    expect(JSON.parse(out["desktop_apps"]).map((x: { app: string }) => x.app)).toEqual([
      "desktop-server",
      "desktop-client",
    ]);
  });

  test("the duplicated job bodies have not drifted apart", () => {
    // The whole point of the split is that the two build jobs and the two
    // publish jobs run IDENTICAL steps for their half of the matrix. If a
    // fix lands in one copy and not the other, this fails and the author
    // copies it across.
    expect(steps("build-cli")).toBe(steps("build-desktop"));
    expect(steps("publish-cli")).toBe(steps("publish-desktop"));
  });
});
