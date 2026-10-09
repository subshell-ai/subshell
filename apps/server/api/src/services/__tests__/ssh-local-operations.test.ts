import { expect, test } from "bun:test";
import { existsSync } from "node:fs";
import { chmod, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { buildSshConfigPath } from "@internal/pane-runtime";
import { SUBSHELL_SERVER_DATA_DIR } from "@/constants.js";
import { sshExec, sshExecStatus, sshHostKey } from "@/services/nodes/ssh-rpc.js";

test("server setup execution runs in-process, validates its path, redacts secrets and removes temporary config", async () => {
  const directory = await mkdtemp(join(tmpdir(), "local-ssh-exec-"));
  const previous = process.env.SUBSHELL_SSH_PATH;
  const executable = join(directory, "ssh");
  await writeFile(executable, "#!/bin/sh\nprintf 'visible output\\nsecret nsk_do-not-retain\\n'\nexit 23\n");
  await chmod(executable, 0o700);
  process.env.SUBSHELL_SSH_PATH = executable;
  const execId = crypto.randomUUID();
  const configPath = buildSshConfigPath(SUBSHELL_SERVER_DATA_DIR, execId);
  const args = {
    execId,
    configPath,
    fileContent: "Host host\n  HostName example.test\n",
    presetFlags: ["-F", configPath, "host"],
    command: "setup nsk_do-not-retain",
    relay: false,
    agentSocketPath: null,
    timeoutMs: 1000,
  };
  try {
    await expect(sshExec("local", { ...args, configPath: join(directory, "escape") })).rejects.toMatchObject({
      kind: "refused",
    });
    expect(existsSync(join(directory, "escape"))).toBe(false);
    await sshExec("local", args);
    let result = await sshExecStatus("local", execId);
    for (let count = 0; result.state === "running" && count < 100; count++) {
      await new Promise((resolve) => setTimeout(resolve, 5));
      result = await sshExecStatus("local", execId);
    }
    expect(result.state).toBe("done");
    if (result.state !== "done") throw new Error("setup exec did not finish");
    expect(result.code).toBe(23);
    expect(result.stdout).toContain("visible output");
    expect(JSON.stringify(result)).not.toContain("nsk_");
    for (let count = 0; existsSync(configPath) && count < 100; count++)
      await new Promise((resolve) => setTimeout(resolve, 5));
    expect(existsSync(configPath)).toBe(false);
  } finally {
    if (previous === undefined) delete process.env.SUBSHELL_SSH_PATH;
    else process.env.SUBSHELL_SSH_PATH = previous;
    await rm(directory, { recursive: true, force: true });
  }
});

test("server host-key capture uses the service account's exact port-specific trust entry", async () => {
  const directory = await mkdtemp(join(tmpdir(), "local-ssh-host-"));
  const previous = process.env.SUBSHELL_SSH_KNOWN_HOSTS;
  const previousBinary = process.env.SUBSHELL_SSH_KEYGEN_PATH;
  const file = join(directory, "known_hosts");
  // Capture delegates matching to OpenSSH; the public blob is opaque to -F.
  await writeFile(file, "example.test ssh-ed25519 AAAA\n[example.test]:2222 ssh-ed25519 BBBB\n");
  process.env.SUBSHELL_SSH_KNOWN_HOSTS = file;
  process.env.SUBSHELL_SSH_KEYGEN_PATH = "/usr/bin/ssh-keygen";
  try {
    expect(await sshHostKey("local", { host: "example.test", port: 2222, user: null })).toEqual({
      lines: ["[example.test]:2222 ssh-ed25519 BBBB"],
    });
  } finally {
    if (previous === undefined) delete process.env.SUBSHELL_SSH_KNOWN_HOSTS;
    else process.env.SUBSHELL_SSH_KNOWN_HOSTS = previous;
    if (previousBinary === undefined) delete process.env.SUBSHELL_SSH_KEYGEN_PATH;
    else process.env.SUBSHELL_SSH_KEYGEN_PATH = previousBinary;
    await rm(directory, { recursive: true, force: true });
  }
});
