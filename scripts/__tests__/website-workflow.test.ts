import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";

const yml = readFileSync(join(import.meta.dir, "../../.github/workflows/website.yml"), "utf8");

describe("website.yml structure", () => {
  test("deploy-off-main-only guard", () => {
    expect(yml).toContain("refs/heads/main");
    expect(yml).toContain("docs deploys off main only".replace("docs", "website"));
  });
  test("packages three jobs, website-scoped, and no gate", () => {
    // `ci-gate:` went out on the operator's ruling of 2026-09-25 (a flaky job
    // in an unrelated package blocked both site deploys), so the pin is now
    // that NO gate job comes back.
    expect(yml).not.toContain("ci-gate:");
    for (const job of ["plan:", "build:", "deploy:"]) expect(yml).toContain(job);
    expect(yml).toContain("--filter=@internal/website --force");
    expect(yml).toContain('tag="website-v$version"');
    expect(yml).toContain("apps/website/out/index.html");
  });
  test("GA id is build-time env, empty default means no tag in the bundle", () => {
    expect(yml).toContain("NEXT_PUBLIC_GA_MEASUREMENT_ID");
    expect(yml).toContain("vars.GA_MEASUREMENT_ID");
  });
  test("deploys via wrangler from apps/website with the shared secrets", () => {
    // wrangler-action's `workingDirectory:` input went with it (d98be4ad: the
    // action's npm install dies on this workspace's `workspace:*`); the deploy
    // is a plain step now, and the lowercase key is the step's, not an input.
    expect(yml).toContain("working-directory: apps/website");
    expect(yml).toContain("CLOUDFLARE_API_TOKEN");
  });
});
