import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { expect, test } from "@playwright/test";
import { missingSshBins, type SshFixture, startSshFixture } from "../fixtures/sshd";
import { ADMIN_STATE } from "./helpers";

test.use({ storageState: ADMIN_STATE });
let root: string;
let fixture: SshFixture;
const passphrase = "disposable-browser-signing-fixture";
const missing = missingSshBins();
// A host without the OpenSSH binaries cannot run this suite. Skipping LOUDLY,
// naming the missing binaries at file level, is the sibling SSH specs'
// convention; a skip inside beforeAll reads as a pass to the reporter.
test.skip(missing.length > 0, `SSH binaries absent on this host (${missing.join(", ")}) - spec 25 needs a real sshd`);
test.beforeAll(async () => {
  root = mkdtempSync(path.join(tmpdir(), "subshell-browser-ssh-"));
  fixture = await startSshFixture(root);
  execFileSync("ssh-keygen", ["-p", "-P", "", "-N", passphrase, "-f", fixture.trustedKeyPath]);
});
test.afterAll(async () => {
  await fixture?.stop();
  if (root) rmSync(root, { recursive: true, force: true });
});

test("an encrypted browser key signs a real SSH login without uploading the key or passphrase", async ({ page }) => {
  const enabled = await page.request.put("/api/nodes/local/ssh-enabled", { data: { on: true } });
  expect(enabled.ok()).toBe(true);
  const outgoing: string[] = [];
  page.on("request", (request) => {
    const body = request.postData();
    if (body) outgoing.push(body);
  });
  await page.goto("/connect");
  // The absence proof is only real once the form has rendered: count(0) on a
  // still-loading page passes even if the warning were unconditional.
  await expect(page.getByRole("radio", { name: "Use a key from my machine", exact: true })).toBeVisible();
  await expect(page.getByText(/Compromised page code could steal your key/)).toHaveCount(0);
  await page.getByRole("combobox", { name: "Connect from" }).click();
  await page.getByRole("option", { name: "Server", exact: true }).click();
  await page.getByRole("radio", { name: "Use a key from my machine", exact: true }).check();
  await expect(page.getByText(/Compromised page code could steal your key/)).toBeVisible();
  await expect(page.getByRole("button", { name: "Choose key…", exact: true })).toBeDisabled();
  await page.getByRole("checkbox", { name: "I trust this website and its operator", exact: true }).check();
  await page.getByLabel("SSH private key", { exact: true }).setInputFiles(fixture.trustedKeyPath);
  await page.getByLabel("Key passphrase (if encrypted)", { exact: true }).fill("wrong-disposable-passphrase");
  // Choosing the key first must survive the later destination choice.
  await page.getByLabel("SSH destination", { exact: true }).fill(`${fixture.user}@127.0.0.1:${fixture.port}`);
  await expect(page.getByText(path.basename(fixture.trustedKeyPath), { exact: true })).toBeVisible();
  await expect(page.getByLabel("Key passphrase (if encrypted)", { exact: true })).toHaveValue(
    "wrong-disposable-passphrase",
  );
  await page.getByRole("button", { name: "Start SSH subshell", exact: true }).click();
  const confirmation = page.getByRole("dialog", { name: "Use this key to connect?", exact: true });
  await expect(confirmation.getByText(path.basename(fixture.trustedKeyPath), { exact: true })).toBeVisible();
  await expect(confirmation.getByText("Server", { exact: true })).toBeVisible();
  await expect(
    confirmation.getByText(`ssh -p ${fixture.port} ${fixture.user}@127.0.0.1`, { exact: true }),
  ).toBeVisible();
  await expect(confirmation.getByText(/SHA256:/)).toBeVisible();
  await confirmation.getByRole("button", { name: "Use key and connect", exact: true }).click();
  await expect(confirmation).toHaveCount(0);
  const failure = page.getByRole("alert").filter({ hasText: "Couldn't unlock that SSH key" });
  await expect(failure).toBeVisible();
  await expect(failure).toContainText("Check its passphrase and try again.");
  await expect(page.getByText(path.basename(fixture.trustedKeyPath), { exact: true })).toBeVisible();
  await expect(
    page.getByRole("checkbox", { name: "I trust this website and its operator", exact: true }),
  ).toBeChecked();
  await expect(page.getByLabel("Key passphrase (if encrypted)", { exact: true })).toHaveValue(
    "wrong-disposable-passphrase",
  );
  const errorBounds = await failure.boundingBox();
  const startBounds = await page.getByRole("button", { name: "Start SSH subshell", exact: true }).boundingBox();
  expect(errorBounds && startBounds && errorBounds.y < startBounds.y).toBe(true);
  // Retry the same File without reopening the picker, with a fresh passphrase and approval.
  await page.getByLabel("Key passphrase (if encrypted)", { exact: true }).fill(passphrase);
  await page.getByLabel("SSH destination", { exact: true }).fill(`missing-browser-key-user@127.0.0.1:${fixture.port}`);
  await page.getByRole("button", { name: "Start SSH subshell", exact: true }).click();
  await expect(confirmation).toBeVisible();
  const refusedLaunch = page.waitForResponse(
    (response) => response.url().endsWith("/api/ssh/launch") && response.request().method() === "POST",
  );
  await confirmation.getByRole("button", { name: "Use key and connect", exact: true }).click();
  const refused = await (await refusedLaunch).json();
  await expect(page.getByRole("alert").filter({ hasText: "SSH ended before requesting a signature" })).toBeVisible();
  await expect.poll(async () => (await page.request.get(`/api/subshells/${refused.subshell.id}`)).status()).toBe(404);
  await expect(page.getByRole("button", { name: "Start SSH subshell", exact: true })).toBeEnabled();
  await expect(page.getByLabel("Key passphrase (if encrypted)", { exact: true })).toHaveValue(passphrase);
  await expect(page.getByText(path.basename(fixture.trustedKeyPath), { exact: true })).toBeVisible();
  await page.getByLabel("SSH destination", { exact: true }).fill(`${fixture.user}@127.0.0.1:${fixture.port}`);
  await page.getByRole("button", { name: "Start SSH subshell", exact: true }).click();
  await expect(confirmation).toBeVisible();
  const launched = page.waitForResponse(
    (response) => response.url().endsWith("/api/ssh/launch") && response.request().method() === "POST",
  );
  await confirmation.getByRole("button", { name: "Use key and connect", exact: true }).click();
  const response = await launched;
  expect(response.ok(), await response.text()).toBe(true);
  const created = await response.json();
  try {
    await expect.poll(() => readFileSync(fixture.logPath, "utf8"), { timeout: 30_000 }).toContain("Accepted publickey");
    const bodies = outgoing.join("\n");
    expect(bodies).not.toContain(passphrase);
    expect(bodies).not.toContain("wrong-disposable-passphrase");
    expect(bodies).not.toContain("OPENSSH PRIVATE KEY");
    expect(bodies).not.toContain(readFileSync(fixture.trustedKeyPath, "utf8").split("\n")[1]);
    expect(bodies).toContain('"reply"');
  } finally {
    await page.request.delete(`/api/subshells/${created.subshell.id}`);
  }
});
