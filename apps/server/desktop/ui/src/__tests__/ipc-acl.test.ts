/**
 * The three-way contract: the page, the Rust command set, and the ACL.
 *
 * A command name lives in `lib/ipc.ts`, in `src-tauri/permissions/desktop.toml`
 * and in `src-tauri/capabilities/console.json`. Changing one without the others
 * produces a command that is REFUSED AT RUNTIME with a message about
 * permissions — not a compile error, and not something any type check sees.
 * Nothing held those three files together before this test.
 *
 * The `main` window is the other half of the boundary, and it is pinned too:
 * unlike Subshell Client's (which is granted NOTHING because a control plane
 * can live anywhere), this app's `main` shows the server IT manages over
 * loopback, so its origin is enumerable in `main.json` and it holds exactly
 * three commands. Three is a number worth a test: "a few harmless ones" is
 * how a boundary erodes.
 */
import { describe, expect, it } from "bun:test";
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";

const TAURI_DIR = join(import.meta.dir, "../../../src-tauri");
const UI_SRC = join(import.meta.dir, "..");

const ipcSource = readFileSync(join(UI_SRC, "lib/ipc.ts"), "utf8");

/** The commands `lib/ipc.ts` actually invokes. */
function invokedCommands(): Set<string> {
  // `invoke<Probe>("desktop_probe")` and `invoke<void>("desktop_open_path", args)`.
  const found = new Set<string>();
  for (const match of ipcSource.matchAll(/\binvoke\s*(?:<[^>]*>)?\s*\(\s*"([^"]+)"/g)) {
    found.add(match[1] as string);
  }
  return found;
}

/**
 * The commands ONE page can reach: the `ipc.<name>` calls in its file, mapped
 * to command names through ipc.ts's own exports.
 *
 * This replaced "ipc.ts's full set == console.json" when the wizard arrived.
 * One shared `lib/ipc.ts` serving two windows makes the full set the union of
 * two grants, and a per-page pin is the only way both stay EXACT sets: a
 * command the console stops calling must leave console.json even while the
 * wizard still calls it (that is how `allow-desktop-open-console` was removed
 * from the console in the first place).
 */
function commandsInvokedBy(pageFile: string): Set<string> {
  const nameToCommand = new Map<string, string>();
  const decl = /export const (\w+)[^;]*?invoke\s*(?:<[^>]*>)?\s*\(\s*"([^"]+)"/g;
  for (const m of ipcSource.matchAll(decl)) {
    nameToCommand.set(m[1] as string, m[2] as string);
  }
  const src = codeOf(join(UI_SRC, pageFile)); // codeOf takes a PATH and strips comments itself
  const out = new Set<string>();
  for (const m of src.matchAll(/\bipc\.(\w+)\s*\(/g)) {
    const cmd = nameToCommand.get(m[1] as string);
    if (cmd) out.add(cmd);
  }
  return out;
}

/** The `desktop_*` commands a capability file grants, expanded through the manifest. */
function grantedCommands(file: string): Set<string> {
  const manifest = manifestPermissions();
  return new Set(capabilityPermissions(file).flatMap((id) => manifest.get(id) ?? []));
}

/**
 * A file's CODE, with comments removed.
 *
 * This app's prose names commands and `window.__TAURI__` deliberately — it is
 * the invocation everything here is arranged to avoid, and the reasons are
 * worth writing down. What must not exist is a call the page could actually
 * make. Crude by design (a `//` inside a string literal is stripped too),
 * which is harmless for checks that only ask whether a token survives.
 */
function codeOf(file: string): string {
  return readFileSync(file, "utf8")
    .replace(/\/\*[\s\S]*?\*\//g, " ")
    .replace(/(^|[^:])\/\/.*$/gm, "$1");
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

function capabilityPermissions(file: string): string[] {
  const capability = JSON.parse(readFileSync(join(TAURI_DIR, "capabilities", file), "utf8")) as {
    permissions: string[];
  };
  return capability.permissions;
}

/** Every `.ts` file under `ui/src`, tests included. */
function sourceFiles(dir: string = UI_SRC): string[] {
  const out: string[] = [];
  for (const entry of readdirSync(dir)) {
    const path = join(dir, entry);
    if (statSync(path).isDirectory()) {
      out.push(...sourceFiles(path));
    } else if (path.endsWith(".ts")) {
      out.push(path);
    }
  }
  return out;
}

describe("the console's IPC contract", () => {
  it("invokes exactly the commands the ACL grants this window", () => {
    // Per-page since the wizard: the console page's ipc.* calls, and console's
    // grants, are the same exact set - not merely a subset of anything.
    expect([...commandsInvokedBy("main.ts")].sort()).toEqual([...grantedCommands("console.json")].sort());
  });

  it("the wizard invokes exactly the commands its capability grants", () => {
    // The third window holds the setup verbs and nothing else: no service, no
    // init, no logs, no config reads, no tray settings. This set being exact is
    // the wizard's whole boundary (§ 3 of the 2026-09-10 spec), and the Done
    // screen's open-console here is the one command shared with `main`.
    expect([...commandsInvokedBy("wizard.ts")].sort()).toEqual([...grantedCommands("wizard.json")].sort());
    // And the union still lands where ipc.ts says it must: every command any
    // page can invoke is granted SOMEWHERE, and ipc.ts hides nothing extra.
    const pages = new Set([...commandsInvokedBy("main.ts"), ...commandsInvokedBy("wizard.ts")]);
    expect([...invokedCommands()].sort()).toEqual([...pages].sort());
  });

  it("names no permission the manifest does not define", () => {
    const manifest = manifestPermissions();
    // `core:*`, `dialog:*` and `opener:*` come from Tauri and its plugins; only
    // this app's own `allow-desktop-*` identifiers have to exist in desktop.toml.
    // ALL THREE capability files: an undefined id in main.json or wizard.json
    // would contribute nothing to its file's expansion and slip past otherwise.
    const own = [
      ...capabilityPermissions("console.json"),
      ...capabilityPermissions("main.json"),
      ...capabilityPermissions("wizard.json"),
    ].filter((id) => !id.includes(":"));
    for (const id of own) expect(manifest.has(id), `${id} is granted but not defined`).toBe(true);
  });

  it("defines no app permission neither capability grants", () => {
    // A granted-nowhere permission is a command no page can call, which is the
    // same runtime rejection read from the other end. This is the check that
    // makes the reset permission's toml entry and its console.json grant land
    // in the same commit (plan P1).
    const granted = new Set([
      ...capabilityPermissions("console.json"),
      ...capabilityPermissions("main.json"),
      ...capabilityPermissions("wizard.json"),
    ]);
    for (const id of manifestPermissions().keys()) expect(granted.has(id)).toBe(true);
  });

  it("keeps `main` to exactly its three harmless commands", () => {
    // Show a window that already exists, drop this app's own title bar, and
    // display one fixed-shape notification. Nothing that touches the CLI, the
    // config, the service or the filesystem may appear here; adding a fourth
    // is the change this line exists to make loud.
    const manifest = manifestPermissions();
    const appCommands = capabilityPermissions("main.json")
      .filter((id) => !id.includes(":"))
      .flatMap((id) => manifest.get(id) ?? []);
    expect(appCommands.sort()).toEqual(["desktop_notify", "desktop_open_console", "desktop_shell_ready"]);
    // And no plugin permission of consequence: the loopback page gets dialog-
    // free, opener-free, fs-free handling by construction.
    const pluginPermissions = capabilityPermissions("main.json").filter((id) => id.includes(":"));
    expect(pluginPermissions.sort()).toEqual(["core:window:allow-start-dragging"]);
  });

  it("keeps the console's dialog surface to open + ask", () => {
    // The two the page calls: the file dialog (choose a server binary) and the
    // native confirmations on update/restart. `ask` needed adding when the
    // page moved to @tauri-apps/plugin-dialog — with only `allow-message`
    // granted, `ask()` would reject at the ACL and "restart anyway" would
    // strand on the first refusal.
    const dialog = capabilityPermissions("console.json").filter((id) => id.startsWith("dialog:"));
    expect(dialog.sort()).toEqual(["dialog:allow-ask", "dialog:allow-open"]);
  });

  it("keeps the wizard's dialog surface to open alone", () => {
    // pickBinary's file dialog is the wizard's only native popup; its consent
    // is on-screen (the Run screen's bullet list), not a system ask sheet.
    const dialog = capabilityPermissions("wizard.json").filter((id) => id.startsWith("dialog:"));
    expect(dialog.sort()).toEqual(["dialog:allow-open"]);
  });

  it("reaches Tauri through lib/ipc.ts and nowhere else", () => {
    // `withGlobalTauri` is off, so a stray `window.__TAURI__` read is dead
    // code that will silently reject; a stray `invoke("desktop_...")` outside
    // the typed boundary is a command the pins above have never seen.
    for (const file of sourceFiles()) {
      // This file names the tokens it scans for, in code rather than in
      // comments, and cannot also be forbidden from doing so. The client
      // app's identical guard skips itself the same way.
      if (file.endsWith("ipc-acl.test.ts")) continue;
      const code = codeOf(file);
      expect(code, `${file} reads the Tauri global`).not.toContain("__TAURI__");
      if (!file.endsWith(join("lib", "ipc.ts"))) {
        expect(code, `${file} invokes a command directly`).not.toMatch(/\binvoke\s*(?:<[^>]*>)?\s*\(\s*"desktop_/);
      }
    }
  });
});
