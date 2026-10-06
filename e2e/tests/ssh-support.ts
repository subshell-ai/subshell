import { rmSync } from "node:fs";
import { isAbsolute } from "node:path";
import { type APIRequestContext, expect, request as pwRequest } from "@playwright/test";
import { BASE_URL } from "../ports";
import { ADMIN, ADMIN_STATE } from "./helpers";

/**
 * Shared machinery for the SSH-runtime end-to-end specs (22, 23). Kept out of
 * the specs so the spec files stay the orchestrators of user-visible flows
 * (the repo's thin-route rule applied to tests): this module owns the admin
 * seed, the node-row shape, and the scratch-dir guard. The destination
 * product's connection round-trip helpers retired with it (design
 * 2026-10-05 §7); the wizard specs drive `/api/ssh-runtime` directly.
 */

export interface NodeRow {
  id: string;
  name: string;
  status: "online" | "offline";
  protocolVersion: number | null;
  capabilities: string[];
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
