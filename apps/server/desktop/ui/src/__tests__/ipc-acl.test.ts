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
    const manifest = manifestPermissions();
    const granted = new Set(capabilityPermissions("console.json").flatMap((id) => manifest.get(id) ?? []));
    expect([...invokedCommands()].sort()).toEqual([...granted].sort());
  });

  it("names no permission the manifest does not define", () => {
    const manifest = manifestPermissions();
    // `core:*`, `dialog:*` and `opener:*` come from Tauri and its plugins; only
    // this app's own `allow-desktop-*` identifiers have to exist in desktop.toml.
    // BOTH capability files: an undefined id in main.json would contribute
    // nothing to the "exactly three" expansion and slip past it otherwise.
    const own = [...capabilityPermissions("console.json"), ...capabilityPermissions("main.json")].filter(
      (id) => !id.includes(":"),
    );
    for (const id of own) expect(manifest.has(id), `${id} is granted but not defined`).toBe(true);
  });

  it("defines no app permission neither capability grants", () => {
    // A granted-nowhere permission is a command no page can call, which is the
    // same runtime rejection read from the other end.
    const granted = new Set([...capabilityPermissions("console.json"), ...capabilityPermissions("main.json")]);
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
