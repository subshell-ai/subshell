/**
 * The step vocabulary and the three facts every screen reads off a probe.
 */
import { describe, expect, it } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import type { Probe } from "@/lib/ipc";
import { isLoopback, PROBE_STEPS, paneRisk, rewriteKillsPanes, stepLabel, stepTone } from "@/lib/steps";
import { makeProbe } from "./harness";

const CONTROL_RS = join(import.meta.dir, "../../../src-tauri/src/control.rs");

describe("PROBE_STEPS", () => {
  // The union in `lib/ipc.ts` is hand-transcribed from `ProbeStep`, so the one
  // thing worth checking mechanically is that the Rust enum has not grown a
  // variant this build has no screen for.
  it("covers every variant of the Rust ProbeStep enum", () => {
    const rust = readFileSync(CONTROL_RS, "utf8");
    const block = /pub enum ProbeStep \{([\s\S]*?)\n\}/.exec(rust)?.[1] ?? "";
    const variants = [...block.matchAll(/^\s{4}([A-Z][A-Za-z]*),$/gm)].map((m) =>
      // `#[serde(rename_all = "kebab-case")]`.
      (m[1] as string).replace(/([a-z0-9])([A-Z])/g, "$1-$2").toLowerCase(),
    );
    expect(variants.length).toBeGreaterThan(0);
    expect(variants.sort()).toEqual([...PROBE_STEPS].sort());
  });

  it("has a label and a tone for every step", () => {
    for (const step of PROBE_STEPS) {
      expect(stepLabel(step)).not.toBe("Unknown");
      expect(["ok", "warn", "bad", "neutral"]).toContain(stepTone(step));
    }
  });

  // A step this build predates must read as "Unknown" rather than asserting
  // something about the machine: it means the app is older than the agent.
  it("answers Unknown for a step it has never heard of", () => {
    expect(stepLabel(undefined)).toBe("Unknown");
    expect(stepLabel("what-is-this" as never)).toBe("Unknown");
    expect(stepTone("what-is-this" as never)).toBe("neutral");
  });
});

describe("paneRisk", () => {
  const withService = (service: Probe["service"]) => makeProbe({ service });

  it("is false when nothing is installed", () => {
    expect(paneRisk(withService({ installed: false, state: "not-installed", paneSafety: null }))).toBe(false);
  });

  it("is false only for a positive `keeps`", () => {
    expect(paneRisk(withService({ installed: true, state: "running", paneSafety: "keeps" }))).toBe(false);
  });

  // Fails CLOSED on `unknown`, the way the CLI's own guard does: an unreadable
  // definition is not evidence of safety.
  it("is true for kills AND for unknown", () => {
    expect(paneRisk(withService({ installed: true, state: "running", paneSafety: "kills" }))).toBe(true);
    expect(paneRisk(withService({ installed: true, state: "running", paneSafety: "unknown" }))).toBe(true);
    expect(paneRisk(withService({ installed: true, state: "running" }))).toBe(true);
  });

  it("is false with no probe at all", () => {
    expect(paneRisk(undefined)).toBe(false);
  });
});

describe("rewriteKillsPanes", () => {
  const risky = { installed: true, state: "running" as const, paneSafety: "kills" as const };

  // launchd has no reload: `service install` boots the loaded job OUT, and a
  // job whose loaded definition predates `AbandonProcessGroup` takes its whole
  // process group — every pane on the machine.
  it("is true only where the rewrite itself tears the agent down", () => {
    expect(rewriteKillsPanes(makeProbe({ service: risky, rewriteTearsDown: true }))).toBe(true);
    expect(rewriteKillsPanes(makeProbe({ service: risky, rewriteTearsDown: false }))).toBe(false);
  });

  // Both halves are required: on macOS with a pane-sparing definition already
  // installed there is nothing at stake.
  it("is false when there are no panes at risk", () => {
    expect(
      rewriteKillsPanes(
        makeProbe({ service: { installed: true, state: "running", paneSafety: "keeps" }, rewriteTearsDown: true }),
      ),
    ).toBe(false);
  });
});

describe("isLoopback", () => {
  it("matches every spelling `is_loopback_server` matches", () => {
    for (const url of [
      "http://localhost:3080",
      "https://sub.localhost",
      "http://127.0.0.1:3080",
      "http://127.1.2.3",
      "http://[::1]:3080",
      "http://0.0.0.0:3080",
    ]) {
      expect(isLoopback(url), url).toBe(true);
    }
  });

  it("does not match a real control plane", () => {
    for (const url of ["https://subshell.example.com", "http://10.0.0.4:3080", "https://localhostings.dev"]) {
      expect(isLoopback(url), url).toBe(false);
    }
  });

  it("answers false rather than throwing on junk", () => {
    expect(isLoopback("not a url")).toBe(false);
    expect(isLoopback("")).toBe(false);
    expect(isLoopback(null)).toBe(false);
    expect(isLoopback(undefined)).toBe(false);
  });
});
