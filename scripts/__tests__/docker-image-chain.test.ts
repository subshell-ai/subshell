import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";

/**
 * The GHCR image rail never ran once through cli-server v1.7.0: it listened
 * `on: release`, but a cut's release is published by softprops under
 * GITHUB_TOKEN, and GitHub starts no workflows from Actions-created events.
 * The chain is `workflow_run` on Release (the sanctioned exception), with a
 * plan job that re-derives the version from the parent's head commit and
 * skips re-arms. These pins are the shape that must not regress back to a
 * trigger that can never fire, or to a plan that packages the same version
 * twice, or that lets a rebuild regress :latest.
 */

const WORKFLOW = readFileSync(join(import.meta.dir, "../../.github/workflows/docker-image.yml"), "utf8");

describe("docker-image.yml chain", () => {
  test("triggered by workflow_run on Release, never by the dead on: release", () => {
    expect(WORKFLOW).toMatch(/workflow_run:\s*\n\s*workflows: \["Release"\]/);
    // An `on: release` block would sit at the triggers' indentation level.
    expect(WORKFLOW).not.toMatch(/^ {2}release:/m);
  });

  test("a failed or off-main parent packages nothing", () => {
    expect(WORKFLOW).toMatch(/CONCLUSION" != "success"/);
    expect(WORKFLOW).toMatch(/BRANCH" != "main"/);
    // The skip triple must come from `decide` alone: the job's outputs map
    // there, and the first chained run let a versionless build launch
    // because a failed-parent `skip=true` was written to resolve's outputs
    // and never reached the gate.
    const resolve = WORKFLOW.slice(WORKFLOW.indexOf("id: resolve"), WORKFLOW.indexOf("id: decide"));
    expect(resolve).not.toMatch(/echo "skip=/);
    // And build gates on BOTH the skip flag and a non-empty version.
    const buildIf = WORKFLOW.match(/if: needs\.plan\.outputs\.skip[^\n]+/);
    expect(buildIf?.[0]).toContain("version != ''");
  });

  test("the parent's own head commit is what gets read for the version", () => {
    expect(WORKFLOW).toMatch(/ref: \$\{\{ github\.event\.workflow_run\.head_sha \}\}/);
    expect(WORKFLOW).toMatch(/apps\/server\/api\/package\.json/);
  });

  test("a chained re-arm whose version has no published release yet skips, not dies", () => {
    // 2026-10-04: the version-bump commit completed a Release run minutes
    // before the dispatched cut published cli-server-v1.9.1; the re-arm
    // checked only GHCR, found nothing packaged, launched, and died
    // "release not found" in the build. The gate is the RELEASE's existence.
    const decide = WORKFLOW.split("id: decide")[1];
    expect(decide).toMatch(/if ! gh release view "cli-server-v\$VERSION"/);
    expect(decide).toMatch(/skip=true/);
    expect(decide).toMatch(/move_latest=false/);
    // and the gate precedes the fresh-build branch that would move :latest.
    expect(decide.indexOf("gh release view")).toBeLessThan(decide.indexOf("move_latest=true"));
  });

  test("a chained re-arm of an already-packaged version skips", () => {
    // Both the skip and the no-latest-move live in the decide step, keyed on
    // the imagetools inspect of the version tag.
    expect(WORKFLOW).toMatch(/imagetools inspect "\$IMAGE:\$VERSION"/);
    const decide = WORKFLOW.slice(WORKFLOW.indexOf("id: decide"));
    expect(decide).toMatch(/skip=true/);
  });

  test("smoke requires an anonymous pull before advancing latest", () => {
    const smoke = WORKFLOW.slice(WORKFLOW.indexOf("  smoke:"), WORKFLOW.indexOf("  latest:"));
    expect(smoke).not.toContain("docker/login-action");
    expect(smoke).toContain("DOCKER_CONFIG=$(mktemp -d)");
    expect(smoke).toContain('docker pull "$IMAGE:$V" || {');
    expect(smoke).toContain("exit 1");
  });

  test(":latest moves on a fresh chained build, and on a dispatch only when absent", () => {
    const decide = WORKFLOW.slice(WORKFLOW.indexOf("id: decide"));
    // Chained fresh build: move.
    expect(decide).toMatch(/elif \[ "\$EVENT" = "workflow_run" \]/);
    // Dispatch: only the bootstrap (no :latest at all) moves it.
    expect(decide).toMatch(/imagetools inspect "\$IMAGE:latest"/);
    const latestJob = WORKFLOW.slice(WORKFLOW.indexOf("latest:"));
    expect(latestJob).toMatch(/if: needs\.plan\.outputs\.move_latest == 'true'/);
  });
});
