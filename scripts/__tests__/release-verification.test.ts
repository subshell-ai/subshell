import { expect, test } from "bun:test";
import { readFileSync } from "node:fs";

// YAML is executable configuration here. Test the publication dependency graph,
// not incidental indentation or duplicated strings in comments.
const release = Bun.YAML.parse(
  readFileSync(new URL("../../.github/workflows/release.yml", import.meta.url), "utf8"),
) as { jobs: Record<string, { needs?: string | string[]; uses?: string; if?: string; with?: { full?: boolean } }> };
const verification = Bun.YAML.parse(
  readFileSync(new URL("../../.github/workflows/test.yml", import.meta.url), "utf8"),
) as {
  jobs: Record<string, { needs?: string[]; if?: string }>;
  on: { workflow_call: { inputs: { full: { type: string } } } };
};

test("tag creation and npm publishing require fresh, full verification", () => {
  expect(release.jobs.verify?.uses).toBe("./.github/workflows/test.yml");
  expect(release.jobs.verify?.with?.full).toBe(true);
  // Every WRITE is gated on verify: tags, then both publish phases (which
  // need the tag job), and npm.
  for (const name of ["tag", "npm-publish"]) expect(release.jobs[name]?.needs).toContain("verify");
  for (const name of ["publish-cli", "publish-desktop"]) expect(release.jobs[name]?.needs).toContain("tag");
  // Builds may run alongside verification; the plan job must not wait for it.
  expect(release.jobs.plan?.needs).not.toContain("verify");
  expect(verification.on.workflow_call.inputs.full.type).toBe("boolean");
  // Only pushes (empty cut) and a manifest refresh may bypass a skipped gate.
  expect(release.jobs.tag?.if).toContain("needs.verify.result == 'success'");
  expect(release.jobs.tag?.if).toContain("github.event_name == 'push' || inputs.app == 'refresh'");
});

test("the aggregate result waits for every test tier even after a failure", () => {
  expect(verification.jobs.result?.if).toBe("always()");
  expect(verification.jobs.result?.needs?.toSorted()).toEqual([
    "checks",
    "integration",
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
