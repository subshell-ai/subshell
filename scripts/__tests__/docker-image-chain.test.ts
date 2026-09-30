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
  });

  test("the parent's own head commit is what gets read for the version", () => {
    expect(WORKFLOW).toMatch(/ref: \$\{\{ github\.event\.workflow_run\.head_sha \}\}/);
    expect(WORKFLOW).toMatch(/apps\/server\/api\/package\.json/);
  });

  test("a chained re-arm of an already-packaged version skips", () => {
    // Both the skip and the no-latest-move live in the decide step, keyed on
    // the imagetools inspect of the version tag.
    expect(WORKFLOW).toMatch(/imagetools inspect "\$IMAGE:\$VERSION"/);
    const decide = WORKFLOW.slice(WORKFLOW.indexOf("id: decide"));
    expect(decide).toMatch(/skip=true/);
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
