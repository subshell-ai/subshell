import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { chromium, expect, type Locator, type Page, request } from "@playwright/test";
import { startContainerSshFixture } from "./fixtures/sshd-container";
import { BASE_URL, PORTS } from "./ports";
import { shortTmuxBase, startStack, stopStack } from "./stack";
import { startNode } from "./stub/client";
import { sweepTmux } from "./stub/relay-spec";

// Run after building the SPA. Everything shown comes from the real API and
// browser; the SSH destination and both nodes use disposable fixture state.
if (PORTS.backend === 3080) throw new Error("Documentation capture must not use the live instance");
const root = mkdtempSync(path.join(tmpdir(), "ssh-docs-"));
const output = path.resolve(import.meta.dirname, "../apps/docs/public/screenshots");
const cleanup: (() => Promise<void> | void)[] = [() => rmSync(root, { recursive: true, force: true })];

async function capture(page: Page, name: string, first: Locator, last = first) {
  await first.scrollIntoViewIfNeeded();
  const a = await first.boundingBox();
  const b = await last.boundingBox();
  if (!a || !b) throw new Error(`Missing screenshot bounds: ${name}`);
  const x = Math.min(a.x, b.x) - 16;
  const y = Math.min(a.y, b.y) - 16;
  const width = Math.max(a.x + a.width, b.x + b.width) - x + 16;
  const height = Math.max(a.y + a.height, b.y + b.height) - y + 16;
  await page.screenshot({ path: path.join(output, name), clip: { x, y, width, height }, animations: "disabled" });
  console.log(`${name}: ${Math.round(width)} × ${Math.round(height)}`);
}

try {
  const destination = await startContainerSshFixture(root);
  cleanup.push(() => destination.stop());
  const agent = spawnSync("ssh-agent", ["-s"], { encoding: "utf8" });
  const socket = agent.stdout.match(/SSH_AUTH_SOCK=([^;]+)/)?.[1];
  const pid = Number(agent.stdout.match(/SSH_AGENT_PID=([^;]+)/)?.[1]);
  if (agent.status !== 0 || !socket || !Number.isInteger(pid) || pid <= 0)
    throw new Error("Could not start fixture SSH agent");
  cleanup.push(() => {
    process.kill(pid, "SIGTERM");
  });
  const rename = spawnSync("ssh-keygen", ["-c", "-C", "Build access", "-P", "", "-f", destination.trustedKeyPath]);
  if (rename.status !== 0) throw new Error("Could not name the fixture key");
  const add = spawnSync("ssh-add", [destination.trustedKeyPath], { env: { ...process.env, SSH_AUTH_SOCK: socket } });
  if (add.status !== 0) throw new Error("Could not load the fixture key");

  cleanup.push(stopStack);
  await startStack();
  const api = await request.newContext({ baseURL: BASE_URL });
  cleanup.push(() => api.dispose());
  const account = await api.post("/api/auth/sign-up/email", {
    data: { name: "Alex", email: "alex@example.test", password: "docs-fixture-password-1" },
  });
  expect(account.ok()).toBe(true);
  expect((await api.patch("/api/setup/progress", { data: { step: null } })).ok()).toBe(true);

  for (const [index, name] of ["Build node", "Personal node"].entries()) {
    const home = path.join(root, `node-${index}`);
    mkdirSync(path.join(home, ".ssh"), { recursive: true, mode: 0o700 });
    writeFileSync(
      path.join(home, ".ssh/config"),
      `Host build\n  HostName ${destination.host}\n  Port ${destination.port}\n  User developer\n`,
    );
    // No known_hosts: the second capture must ask for first-connection trust.
    const tmuxBase = shortTmuxBase();
    mkdirSync(tmuxBase, { recursive: true });
    cleanup.push(() => {
      sweepTmux(tmuxBase);
      rmSync(path.dirname(tmuxBase), { recursive: true, force: true });
    });
    const mint = await api.post("/api/nodes/setup-keys");
    expect(mint.status()).toBe(201);
    const node = await startNode({
      home: path.join(home, "config"),
      dataDir: path.join(home, "data"),
      tmuxBase,
      setupKey: (await mint.json()).key,
      name,
      env: { HOME: home, SSH_AUTH_SOCK: index === 1 ? socket : undefined },
    });
    cleanup.push(() => node.stop());
    let id: string | undefined;
    await expect
      .poll(
        async () => {
          const { nodes } = await (await api.get("/api/nodes")).json();
          id = nodes.find((n: { name: string; status: string }) => n.name === name && n.status === "online")?.id;
          return !!id;
        },
        { timeout: 60_000 },
      )
      .toBe(true);
    expect((await api.put(`/api/nodes/${id}/ssh-enabled`, { data: { on: true } })).ok()).toBe(true);
  }

  const browser = await chromium.launch();
  cleanup.push(() => browser.close());
  const context = await browser.newContext({
    storageState: await api.storageState(),
    viewport: { width: 1000, height: 1400 },
    colorScheme: "dark",
  });
  const page = await context.newPage();
  page.setDefaultTimeout(20_000);
  await page.goto(`${BASE_URL}/connect`);
  await page.getByRole("combobox", { name: "Connect from", exact: true }).click();
  await page.getByRole("option", { name: "Build node", exact: true }).click();
  await page.getByLabel("SSH destination", { exact: true }).fill("developer@build.example.com:22");
  await page.getByLabel("Remember this destination", { exact: true }).check();
  await page.getByRole("heading", { name: "New subshell", exact: true }).click();
  await capture(
    page,
    "ssh-connection.png",
    page.getByRole("combobox", { name: "Connect from" }).locator(".."),
    page.getByLabel("Remember this destination").locator("../.."),
  );
  await capture(
    page,
    "ssh-authentication.png",
    page.locator("fieldset").filter({ has: page.getByRole("radio", { name: "Enter a password when connecting" }) }),
  );

  await page.getByLabel("SSH destination", { exact: true }).fill("build");
  await page.getByLabel("Remember this destination", { exact: true }).uncheck();
  await page.getByRole("radio", { name: "Use another node’s keys", exact: true }).check();
  await page.getByRole("combobox", { name: "Use keys from", exact: true }).click();
  await page.getByRole("option", { name: "Personal node", exact: true }).click();
  await page.getByRole("checkbox", { name: "Build access", exact: true }).check();
  await page.getByRole("button", { name: "Start SSH subshell", exact: true }).click();
  const confirmation = page.getByRole("dialog", { name: "Connect to this destination?", exact: true });
  await expect(confirmation).toContainText("Connect to this destination?");
  await capture(page, "ssh-destination-confirmation.png", confirmation);
  await page.getByRole("button", { name: "Cancel", exact: true }).last().click();
  expect((await (await api.get("/api/ssh/host-pins")).json()).pins).toEqual([]);
} finally {
  const errors: unknown[] = [];
  for (const stop of cleanup.reverse()) {
    try {
      await stop();
    } catch (error) {
      errors.push(error);
    }
  }
  if (errors.length) {
    console.error(new AggregateError(errors, "SSH documentation fixture cleanup failed"));
    process.exitCode = 1;
  }
}
