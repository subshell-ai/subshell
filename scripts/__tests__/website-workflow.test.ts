import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";

const yml = readFileSync(join(import.meta.dir, "../../.github/workflows/website.yml"), "utf8");

describe("website.yml structure", () => {
  test("deploy-off-main-only guard", () => {
    expect(yml).toContain("refs/heads/main");
    expect(yml).toContain("docs deploys off main only".replace("docs", "website"));
  });
  test("packages the four jobs docs.yml has, website-scoped", () => {
    for (const job of ["ci-gate:", "plan:", "build:", "deploy:"]) expect(yml).toContain(job);
    expect(yml).toContain("--filter=@internal/website --force");
    expect(yml).toContain('tag="website-v$version"');
    expect(yml).toContain("apps/website/out/index.html");
  });
  test("GA id is build-time env, empty default means no tag in the bundle", () => {
    expect(yml).toContain("NEXT_PUBLIC_GA_MEASUREMENT_ID");
    expect(yml).toContain("vars.GA_MEASUREMENT_ID");
  });
  test("deploys via wrangler from apps/website with the shared secrets", () => {
    expect(yml).toContain("workingDirectory: apps/website");
    expect(yml).toContain("CLOUDFLARE_API_TOKEN");
  });
});
