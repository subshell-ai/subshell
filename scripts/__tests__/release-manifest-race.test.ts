import { expect, test } from "bun:test";
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

test("manifest refresh regenerates after a competing push without losing main changes", () => {
  const root = mkdtempSync(join(tmpdir(), "release-manifest-race-"));
  const env = { ...process.env };
  delete env.SHELLOPTS;
  delete env.BASHOPTS;
  const run = (cwd: string, cmd: string[]) => {
    const result = Bun.spawnSync(cmd, { cwd, env, stdout: "pipe", stderr: "pipe" });
    expect(result.exitCode, result.stderr.toString()).toBe(0);
    return result.stdout.toString().trim();
  };
  try {
    const remote = join(root, "remote.git");
    const worker = join(root, "worker");
    const peer = join(root, "peer");
    run(root, ["git", "init", "--bare", "--initial-branch=main", remote]);
    run(root, ["git", "clone", remote, worker]);
    for (const key of ["user.name", "user.email"]) run(worker, ["git", "config", key, "test@example.test"]);
    writeFileSync(join(worker, "releases.json"), "stale\n");
    writeFileSync(join(worker, "source"), "initial\n");
    run(worker, ["git", "add", "."]);
    run(worker, ["git", "commit", "-m", "initial"]);
    run(worker, ["git", "push", "origin", "main"]);
    run(root, ["git", "clone", remote, peer]);
    for (const key of ["user.name", "user.email"]) run(peer, ["git", "config", key, "test@example.test"]);
    env.PEER = peer;
    env.RACE_MARKER = join(root, "raced");
    const hook = join(worker, ".git/hooks/pre-push");
    writeFileSync(
      hook,
      `#!/bin/sh
set -eu
if [ ! -e "$RACE_MARKER" ]; then
  touch "$RACE_MARKER"
  printf 'concurrent refresh\\n' > "$PEER/releases.json"
  printf 'new release\\n' > "$PEER/source"
  git -C "$PEER" add .
  git -C "$PEER" commit -m concurrent
  git -C "$PEER" push origin main
fi
`,
    );
    chmodSync(hook, 0o755);
    const bin = join(root, "bin");
    mkdirSync(bin);
    // Generate from the fetched tree; avoid external release and signing services.
    writeFileSync(join(bin, "bun"), "#!/bin/sh\ncat source > releases.json\n");
    writeFileSync(join(bin, "sleep"), "#!/bin/sh\nexit 0\n");
    chmodSync(join(bin, "bun"), 0o755);
    chmodSync(join(bin, "sleep"), 0o755);
    env.PATH = `${bin}:${env.PATH}`;
    const workflow = readFileSync(join(import.meta.dir, "../../.github/workflows/release.yml"), "utf8");
    const block = workflow
      .split("      - name: Generate, commit, verify\n        run: |\n")[1]
      ?.split("          # Verify our own commit")[0];
    expect(block).toBeDefined();
    const script = join(root, "refresh.sh");
    writeFileSync(script, (block ?? "").replace(/^ {10}/gm, ""));
    run(worker, ["bash", script]);
    run(peer, ["git", "pull", "--ff-only", "origin", "main"]);
    expect(readFileSync(join(peer, "source"), "utf8")).toBe("new release\n");
    expect(readFileSync(join(peer, "releases.json"), "utf8")).toBe("new release\n");
    expect(run(peer, ["git", "log", "--format=%s", "-2"])).toBe("chore: refresh releases.json [skip ci]\nconcurrent");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
