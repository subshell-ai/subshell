import { expect, test } from "bun:test";
import { readFileSync } from "node:fs";

// YAML is executable configuration here. Test the publication dependency graph,
// not incidental indentation or duplicated strings in comments.
type ReleaseJob = {
  needs?: string | string[];
  uses?: string;
  if?: string;
  "timeout-minutes"?: number;
  permissions?: Record<string, string>;
  steps?: { name?: string; run?: string }[];
};
const release = Bun.YAML.parse(
  readFileSync(new URL("../../.github/workflows/release.yml", import.meta.url), "utf8"),
) as { jobs: Record<string, ReleaseJob> };
const verification = Bun.YAML.parse(
  readFileSync(new URL("../../.github/workflows/test.yml", import.meta.url), "utf8"),
) as {
  jobs: Record<string, { needs?: string[]; if?: string }>;
  concurrency?: { group?: string; "cancel-in-progress"?: string };
  on: { workflow_dispatch?: unknown };
};

test("tag creation and npm publishing reuse the revision's full Test run", () => {
  const verify = release.jobs.verify;
  expect(verify?.uses).toBeUndefined();
  expect(verify?.needs).toContain("changesets");
  expect(verify?.["timeout-minutes"]).toBe(45);
  expect(verify?.permissions).toMatchObject({ actions: "read", contents: "read" });
  const gate = verify?.steps?.find((step) => step.name === "Require a green full Test run for this revision");
  expect(gate?.run).toContain("test.yml/runs?head_sha=$SHA");
  expect(gate?.run).toContain('head_branch == "main"');
  expect(gate?.run).toContain("finished as $conclusion");
  expect(gate?.run).toContain('"full": true');
  // Every WRITE is gated on verify: tags, then both publish phases (which
  // need the tag job), and npm.
  for (const name of ["tag", "npm-publish"]) expect(release.jobs[name]?.needs).toContain("verify");
  for (const name of ["publish-cli", "publish-desktop"]) expect(release.jobs[name]?.needs).toContain("tag");
  // Builds may run alongside the reused run; the plan job must not wait for it.
  expect(release.jobs.plan?.needs).not.toContain("verify");
  // A manual full run is the remedy when a revision has no full Test run, and
  // it must not cancel the push run a release gate is waiting on.
  expect(verification.on.workflow_dispatch).toBeDefined();
  expect(verification.concurrency?.group).toContain("github.event_name == 'workflow_dispatch'");
  expect(verification.concurrency?.["cancel-in-progress"]).toContain("github.event_name != 'workflow_dispatch'");
  // Only pushes (empty cut) and a manifest refresh may bypass a skipped gate.
  expect(release.jobs.tag?.if).toContain("needs.verify.result == 'success'");
  expect(release.jobs.tag?.if).toContain("github.event_name == 'push' || inputs.app == 'refresh'");
});

test("the aggregate result waits for every test tier even after a failure", () => {
  expect(verification.jobs.result?.if).toBe("always()");
  expect(verification.jobs.result?.needs?.toSorted()).toEqual([
    "checks",
    "cli",
    "e2e",
    "macos",
    "plan",
    "rust",
    "unit",
  ]);
});

test("site deploys verify the site locally before creating tags", () => {
  for (const site of ["docs", "website"]) {
    const workflow = Bun.YAML.parse(
      readFileSync(new URL(`../../.github/workflows/${site}.yml`, import.meta.url), "utf8"),
    ) as {
      jobs: Record<string, { needs?: string | string[]; uses?: string; steps?: { run?: string }[] }>;
    };
    // The site build and its own tests are the gate; the full repository
    // suite belongs to the four app cuts and npm, not to a content deploy.
    expect(workflow.jobs.verify?.uses).toBeUndefined();
    expect(workflow.jobs.verify?.steps?.some((step) => step.run?.includes(`--filter=@internal/${site}`))).toBe(true);
    expect(workflow.jobs.plan?.needs).toBe("verify");
  }
});
