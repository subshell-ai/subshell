import { mkdirSync, rmSync } from "node:fs";
import { startStack } from "./stack";

/** Boots the scratch stack, resets auth state, runs once before all workers. */
export default async function globalSetup(): Promise<void> {
  rmSync(new URL(".auth/", import.meta.url), { recursive: true, force: true });
  mkdirSync(new URL(".auth/", import.meta.url), { recursive: true });
  await startStack();
}
