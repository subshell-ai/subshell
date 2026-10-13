import { spawnSync } from "node:child_process";
import { randomBytes } from "node:crypto";
import { appendFileSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { GenericContainer, Wait } from "testcontainers";
import { SSH_FIXTURE_ALIAS } from "./sshd";

/** Real password accounts live only in the disposable container, never on the developer's host. */
export async function startContainerSshFixture(root: string) {
  const password = randomBytes(18).toString("hex");
  const user = "developer";
  const sshConfigHome = path.join(root, "home");
  mkdirSync(path.join(sshConfigHome, ".ssh"), { recursive: true, mode: 0o700 });
  const hostKey = path.join(root, "hostkey");
  const trustedKeyPath = path.join(root, "clientkey");
  for (const key of [hostKey, trustedKeyPath]) {
    const result = spawnSync("ssh-keygen", ["-q", "-t", "ed25519", "-N", "", "-f", key]);
    if (result.status !== 0) throw new Error(`Fixture key generation failed: ${result.stderr}`);
  }
  const image = await GenericContainer.fromDockerfile(path.join(import.meta.dirname, "ssh-container")).build();
  const container = await image
    .withExposedPorts(22)
    .withCopyContentToContainer([
      { target: "/etc/ssh/ssh_host_ed25519_key", content: readFileSync(hostKey), mode: 0o600 },
      { target: "/etc/ssh/authorized_keys", content: readFileSync(`${trustedKeyPath}.pub`), mode: 0o644 },
      {
        target: "/etc/ssh/sshd_config",
        content: [
          "Port 22",
          "HostKey /etc/ssh/ssh_host_ed25519_key",
          "AuthorizedKeysFile /etc/ssh/authorized_keys",
          "PasswordAuthentication yes",
          "KbdInteractiveAuthentication no",
          "PubkeyAuthentication yes",
          "UsePAM no",
          "StrictModes yes",
          "LogLevel VERBOSE",
          "PrintMotd no",
        ].join("\n"),
      },
    ])
    .withWaitStrategy(Wait.forListeningPorts())
    .withStartupTimeout(120_000)
    .start();
  try {
    const accounts = await container.exec([
      "sh",
      "-c",
      'printf "developer:%s\\noperator:%s\\n" "$1" "$1" | chpasswd',
      "sh",
      password,
    ]);
    if (accounts.exitCode !== 0) throw new Error("Could not configure fixture accounts");
    const host = container.getHost();
    const port = container.getMappedPort(22);
    const hostKeyLine = `[${host}]:${port} ${readFileSync(`${hostKey}.pub`, "utf8").trim().split(" ").slice(0, 2).join(" ")}`;
    const knownHosts = path.join(sshConfigHome, ".ssh", "known_hosts");
    writeFileSync(knownHosts, `${hostKeyLine}\n`);
    writeFileSync(
      path.join(sshConfigHome, ".ssh", "config"),
      [
        `Host ${SSH_FIXTURE_ALIAS}`,
        `    HostName ${host}`,
        `    Port ${port}`,
        `    User ${user}`,
        `    IdentityFile ${trustedKeyPath}`,
        "    IdentitiesOnly yes",
        "    IdentityAgent none",
        `    UserKnownHostsFile ${knownHosts}`,
        "",
        "Host *",
        `    UserKnownHostsFile ${knownHosts}`,
        "",
      ].join("\n"),
      { mode: 0o600 },
    );
    const logPath = path.join(root, "sshd.log");
    writeFileSync(logPath, "");
    const logs = await container.logs();
    logs.on("data", (chunk) => appendFileSync(logPath, chunk));
    return {
      user,
      host,
      port,
      password,
      hostKeyLine,
      trustedKeyPath,
      sshConfigHome,
      logPath,
      stop: async () => {
        logs.destroy();
        await container.stop();
      },
    };
  } catch (error) {
    await container.stop();
    throw error;
  }
}
