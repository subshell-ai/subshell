#!/usr/bin/env bun
/**
 * Copies the root releases.json into data/ before every build and dev start.
 * Same file, one hop: the baked copy is what the page ships, and the runtime
 * fetch refreshes it (spec 2026-09-23 §4). A missing root file is a hard error
 * at build time — an empty install section would ship silently otherwise.
 */
import { copyFileSync, mkdirSync } from "node:fs";
import { join } from "node:path";

const root = join(import.meta.dir, "..", "..", "..");
const src = join(root, "releases.json");
const dir = join(root, "apps", "website", "data");
mkdirSync(dir, { recursive: true });
copyFileSync(src, join(dir, "releases.json"));
console.log("data/releases.json refreshed from the repo root");
