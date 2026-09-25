import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";

// Text-pinned structure, like website-workflow.test.ts: a YAML round-trip
// parser is not a repo dependency, and these markers are what the job's
// correctness rests on.
const yml = readFileSync(join(import.meta.dir, "../../.github/workflows/release.yml"), "utf8");
const lint = readFileSync(join(import.meta.dir, "../../.github/workflows/lint.yml"), "utf8");

describe("release.yml site-manifest wiring", () => {
  test("refresh rides the app dropdown", () => {
    expect(yml).toContain("options: [cli-server, cli-node, desktop-server, desktop-client, all, refresh]");
    expect(yml).toContain("refresh_manifest");
    // The ruling: NO separate boolean input.
    expect(yml).not.toContain("refresh_site_manifest");
  });

  test("plan emits refresh_manifest on every path", () => {
    // Declared as a job output, like matrix and apps. This string is a
    // GitHub Actions expression, not a JS template placeholder.
    // biome-ignore lint/suspicious/noTemplateCurlyInString: pinning workflow YAML
    expect(yml).toContain("refresh_manifest: ${{ steps.compute.outputs.refresh_manifest }}");
    // The push / non-dispatch path keeps emitting an empty matrix AND says false.
    expect(yml).toContain("echo 'refresh_manifest=false' >> \"$GITHUB_OUTPUT\"");
    // refresh sets true and cuts nothing.
    expect(yml).toMatch(/refresh\).*refresh_manifest=true/);
    // Every dispatch path carries the final value out.
    expect(yml).toContain('echo "refresh_manifest=$refresh_manifest" >> "$GITHUB_OUTPUT"');
  });

  test("the job is non-matrix and needs publish", () => {
    expect(yml).toContain("  site-manifest:");
    const job = yml.slice(yml.indexOf("  site-manifest:"));
    expect(job).not.toContain("strategy:");
    expect(job).toContain("needs: [plan, publish]");
    expect(job).toContain("contents: write");
    expect(job).toContain("timeout-minutes");
    // Runs after a real cut OR as the standalone refresh dispatch — and ONLY
    // from a run on main, since the job pushes to main.
    expect(job).toContain(
      "if: github.ref == 'refs/heads/main' && (needs.plan.outputs.refresh_manifest == 'true' || needs.publish.result == 'success')",
    );
  });

  test("commit retry is bounded and never forced", () => {
    const job = yml.slice(yml.indexOf("  site-manifest:"));
    expect(job).toContain("pull --rebase origin main");
    expect(job).toMatch(/for attempt in 1 2 3/);
    expect(job).not.toMatch(/git push --force/);
  });

  test("no force-push anywhere in the workflow", () => {
    // The plan job's `git tag -f` is local-only and its push stays
    // non-forced; nothing in this file may rewrite upstream refs. The regex
    // is anchored on the `git push` command (word boundary) and confined to
    // one line (`[^\n]*`), so it reads the flag at its position in the
    // command rather than anything that merely co-occurs in the file.
    expect(yml).not.toMatch(/git push --force/);
    expect(yml).not.toMatch(/git push\b[^\n]*\s-f(\s|$)/);
    // The other way to skip the hooks the non-forced push still pays.
    expect(yml).not.toContain("--no-verify");
  });

  test("generation runs from remote tags and the push is self-verified byte-exactly", () => {
    expect(yml).toContain("bun scripts/site-releases.ts");
    expect(yml).toContain("raw.githubusercontent.com");
    // NOT a schemaVersion grep: readable-but-not-ours would pass that, and
    // the whole point of the verify loop is that raw serves THESE bytes.
    expect(yml).toContain("cmp -s - releases.json");
  });
});

describe("lint.yml drift gate", () => {
  test("site-manifest-fresh checks the committed file against the tags", () => {
    expect(lint).toContain("  site-manifest-fresh:");
    const job = lint.slice(lint.indexOf("  site-manifest-fresh:"));
    expect(job).toContain("bun scripts/site-releases.ts --check");
    expect(job).toContain("runs-on: ubuntu-24.04");
    expect(job).toContain("timeout-minutes");
    // Push-only: a cut in flight lands its tag at cut START, and a PR off an
    // older main must not go red for it (the spec's words: drift is caught
    // "on the next push").
    expect(job).toContain("if: github.event_name == 'push'");
  });
});
