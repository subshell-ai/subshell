import { rmSync } from "node:fs";
import { isAbsolute } from "node:path";
import type { SshConnectionSnapshotWire } from "@internal/subshell-protocol";
import { type APIRequestContext, expect, request as pwRequest } from "@playwright/test";
import { SSH_FIXTURE_ALIAS } from "../fixtures/sshd";
import { BASE_URL } from "../ports";
import { ADMIN, ADMIN_STATE } from "./helpers";

/**
 * Shared machinery for the SSH end-to-end spec (21). Kept out of the spec so
 * the spec file stays the orchestrator of user-visible flows (the repo's
 * thin-route rule applied to tests): this module owns the admin seed, the
 * connection round-trip helpers, and the scratch-dir guard.
 */

/** The SSH family validates the cookie-write Origin itself (§2); the API rides the instance's own origin. */
export const SSH_HEADERS = { origin: BASE_URL };

export interface NodeRow {
  id: string;
  name: string;
  status: "online" | "offline";
  protocolVersion: number | null;
  capabilities: string[];
}
export interface RunView {
  status: "accepted" | "running" | "completed" | "unknown";
  remoteStatus: number | null;
  remoteStatusConfirmed: boolean;
  localExitCode: number | null;
}

/** Delete a scratch dir only when it is a real absolute path (never "" or "."). */
export function rmScratch(dir: string): void {
  if (isAbsolute(dir)) rmSync(dir, { recursive: true, force: true });
}

/**
 * The admin, present-or-seeded, as an authenticated API context. A focused
 * run never booted spec 01, so the admin, its storage state, AND its
 * completed-onboarding bookmark are seeded here when absent; in the full
 * suite 01 already did all three. `request` from @playwright/test inherits
 * the file's `test.use` storageState, so the anon seed context passes an
 * EXPLICIT empty state - a bare newContext would READ the (focused-run:
 * not-yet-written) admin.json and ENOENT before the seed could create it.
 */
export async function seedAdminApi(): Promise<APIRequestContext> {
  const anon = await pwRequest.newContext({
    baseURL: BASE_URL,
    extraHTTPHeaders: { origin: BASE_URL },
    storageState: { cookies: [], origins: [] },
  });
  const status = await anon.get("/api/setup/status");
  expect(status.ok(), await status.text()).toBe(true);
  let seededAdmin = false;
  if (((await status.json()) as { needsSetup: boolean }).needsSetup) {
    const signUp = await anon.post("/api/auth/sign-up/email", {
      data: { name: ADMIN.name, email: ADMIN.email, password: ADMIN.password },
    });
    expect(signUp.ok(), `seed sign-up: HTTP ${signUp.status()}`).toBe(true);
    await anon.storageState({ path: ADMIN_STATE });
    seededAdmin = true;
  }
  await anon.dispose();
  const api = await pwRequest.newContext({
    baseURL: BASE_URL,
    storageState: ADMIN_STATE,
    extraHTTPHeaders: { origin: BASE_URL },
  });
  // A user minted through the raw sign-up endpoint has never walked the boot
  // wizard, so its `setup-progress` bookmark is set and the root gate RESUMES
  // it onto /setup - which would bounce every /settings/* navigation. Clearing
  // the bookmark (step:null) is exactly the write the wizard's final step
  // makes; only the seeded (focused-run) case needs it - spec 01 finished it.
  if (seededAdmin) {
    const progress = await api.patch("/api/setup/progress", { data: { step: null } });
    expect(progress.ok(), `clear seeded onboarding bookmark: HTTP ${progress.status()}`).toBe(true);
  }
  return api;
}

/** Resolve the fixture alias on the real node through the human door (a fresh approved snapshot). */
export async function resolveFixtureSnapshot(
  api: APIRequestContext,
  nodeId: string,
): Promise<SshConnectionSnapshotWire> {
  const res = await api.post("/api/ssh/connections/resolve", {
    data: { nodeId, alias: SSH_FIXTURE_ALIAS },
    headers: SSH_HEADERS,
  });
  expect(res.ok(), await res.text()).toBe(true);
  const view = (await res.json()) as { accepted: boolean; snapshot?: SshConnectionSnapshotWire };
  expect(view.accepted, "the fixture config must resolve through the real ssh -G").toBe(true);
  return view.snapshot as SshConnectionSnapshotWire;
}

/** Find-or-create a connection by display name (idempotent across a CI retry of a later test). */
export async function ensureConnection(
  api: APIRequestContext,
  nodeId: string,
  displayName: string,
  portOverride: number | null = null,
): Promise<string> {
  const list = await api.get("/api/ssh/connections");
  expect(list.ok(), await list.text()).toBe(true);
  const found = ((await list.json()) as { connections: { id: string; displayName: string }[] }).connections.find(
    (c) => c.displayName === displayName,
  );
  if (found) return found.id;
  const snapshot = await resolveFixtureSnapshot(api, nodeId);
  const created = await api.post("/api/ssh/connections", {
    data: {
      nodeId,
      displayName,
      snapshot: portOverride === null ? snapshot : { ...snapshot, port: portOverride },
      remoteDir: null,
    },
    headers: SSH_HEADERS,
  });
  expect(created.ok(), await created.text()).toBe(true);
  return ((await created.json()) as { id: string }).id;
}
