/**
 * The three-way contract: the page, the Rust command set, and the ACL.
 *
 * A command name lives in `lib/ipc.ts`, in `src-tauri/permissions/desktop.toml`
 * and in `src-tauri/capabilities/main.json`. Changing one without the others
 * produces a command that is REFUSED AT RUNTIME with a message about
 * permissions — not a compile error, and not something any type checks. Nothing
 * held those three files together before this test.
 */
import { describe, expect, it } from "bun:test";
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";

const TAURI_DIR = join(import.meta.dir, "../../../src-tauri");
const UI_SRC = join(import.meta.dir, "..");

const ipcSource = readFileSync(join(UI_SRC, "lib/ipc.ts"), "utf8");

/** The commands `lib/ipc.ts` actually invokes. */
function invokedCommands(): Set<string> {
  // `invoke<Probe>("node_probe")` and `invoke<void>("node_open_path", args)`.
  const found = new Set<string>();
  for (const match of ipcSource.matchAll(/\binvoke\s*(?:<[^>]*>)?\s*\(\s*"([^"]+)"/g)) {
    found.add(match[1] as string);
  }
  return found;
}

/** `[[permission]]` blocks in the app's ACL manifest, as identifier → commands. */
function manifestPermissions(): Map<string, string[]> {
  const toml = readFileSync(join(TAURI_DIR, "permissions/desktop.toml"), "utf8");
  const out = new Map<string, string[]>();
  let identifier: string | null = null;
  for (const line of toml.split("\n")) {
    const trimmed = line.trim();
    if (trimmed.startsWith("#")) continue;
    const id = /^identifier\s*=\s*"([^"]+)"/.exec(trimmed);
    if (id) {
      identifier = id[1] as string;
      continue;
    }
    const allow = /^commands\.allow\s*=\s*\[([^\]]*)\]/.exec(trimmed);
    if (allow && identifier !== null) {
      const commands = [...(allow[1] as string).matchAll(/"([^"]+)"/g)].map((m) => m[1] as string);
      out.set(identifier, commands);
    }
  }
  return out;
}

function capabilityPermissions(): string[] {
  const capability = JSON.parse(readFileSync(join(TAURI_DIR, "capabilities/main.json"), "utf8")) as {
    permissions: string[];
  };
  return capability.permissions;
}

/**
 * A file's CODE, with comments removed.
 *
 * The prose in this app names `status --probe` repeatedly and has to: it is the
 * invocation everything here is arranged to avoid, and the reason is worth
 * writing down. What must not exist is a `--probe` the page could actually
 * emit. Crude by design (a `//` inside a string literal is stripped too), which
 * is harmless for a check that only asks whether one token survives.
 */
function codeOf(file: string): string {
  return readFileSync(file, "utf8")
    .replace(/\/\*[\s\S]*?\*\//g, " ")
    .replace(/(^|[^:])\/\/.*$/gm, "$1");
}

/** Every `.ts`/`.tsx` file under `ui/src`, tests included. */
function sourceFiles(dir: string = UI_SRC): string[] {
  const out: string[] = [];
  for (const entry of readdirSync(dir)) {
    const path = join(dir, entry);
    if (statSync(path).isDirectory()) {
      out.push(...sourceFiles(path));
    } else if (path.endsWith(".ts") || path.endsWith(".tsx")) {
      out.push(path);
    }
  }
  return out;
}

describe("the IPC contract", () => {
  it("invokes exactly the commands the ACL grants this window", () => {
    const manifest = manifestPermissions();
    const granted = new Set(capabilityPermissions().flatMap((id) => manifest.get(id) ?? []));
    expect([...invokedCommands()].sort()).toEqual([...granted].sort());
  });

  it("names no permission the manifest does not define", () => {
    const manifest = manifestPermissions();
    // `core:*`, `dialog:*` and `opener:*` come from Tauri and its plugins; only
    // this app's own `allow-node-*` identifiers have to exist in desktop.toml.
    const own = capabilityPermissions().filter((id) => !id.includes(":"));
    for (const id of own) expect(manifest.has(id)).toBe(true);
  });

  it("defines no permission the capability does not grant", () => {
    // A granted-nowhere permission is a command the page cannot call, which is
    // the same runtime rejection read from the other end.
    const granted = new Set(capabilityPermissions());
    for (const id of manifestPermissions().keys()) expect(granted.has(id)).toBe(true);
  });

  it("keeps the dialog surface to open + message, with no `ask`", () => {
    // The confirmations are several sentences of consequence and are rendered
    // in the page (components/confirm-panel.tsx). A native `ask` would have to
    // be dismissed to re-read the form behind it.
    const dialog = capabilityPermissions().filter((id) => id.startsWith("dialog:"));
    expect(dialog.sort()).toEqual(["dialog:allow-message", "dialog:allow-open"]);
  });
});

describe("the invocations that must stay unreachable", () => {
  // `status --probe` DIALS the control plane, and the node registry is
  // newest-wins, so a probe supersede-kicks whatever agent is live — possibly
  // one on another machine for this same node (close 4409). The Rust side's
  // `AgentCommand` enum is the real guard; this is the other half, so the page
  // cannot grow an affordance that asks for it.
  it("can emit --probe from no code path", () => {
    for (const file of sourceFiles()) {
      if (file.endsWith("ipc-acl.test.ts")) continue;
      expect(codeOf(file), file).not.toContain("--probe");
    }
  });

  // `subshell run` never resolves and competes with the installed service for
  // one node (both restart on exit, so the pair flaps); `subshell mcp` is
  // per-pane plumbing only a launch's environment can configure.
  it("keeps the service verbs to the five the CLI accepts", () => {
    const union = /export type ServiceVerb =([^;]+);/.exec(ipcSource)?.[1] ?? "";
    expect(union).not.toBe("");
    const verbs = [...union.matchAll(/"([^"]+)"/g)].map((m) => m[1] as string);
    expect(verbs.sort()).toEqual(["install", "restart", "start", "stop", "uninstall"]);
    expect(verbs).not.toContain("run");
    expect(verbs).not.toContain("mcp");
  });
});
