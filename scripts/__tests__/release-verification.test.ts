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
  for (const name of ["plan", "npm-publish"]) expect(release.jobs[name]?.needs).toContain("verify");
  expect(verification.on.workflow_call.inputs.full.type).toBe("boolean");
  // Only pushes (empty cut) and a manifest refresh may bypass a skipped gate.
  expect(release.jobs.plan?.if).toContain("needs.verify.result == 'success'");
  expect(release.jobs.plan?.if).toContain("github.event_name == 'push' || inputs.app == 'refresh'");
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

test("site releases also verify before creating tags", () => {
  for (const site of ["docs", "website"]) {
    const workflow = Bun.YAML.parse(
      readFileSync(new URL(`../../.github/workflows/${site}.yml`, import.meta.url), "utf8"),
    ) as typeof release;
    expect(workflow.jobs.verify?.uses).toBe("./.github/workflows/test.yml");
    expect(workflow.jobs.verify?.with?.full).toBe(true);
    expect(workflow.jobs.plan?.needs).toBe("verify");
  }
});
