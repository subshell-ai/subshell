/**
 * The three-way contract: the page, the Rust command set, and the ACL.
 *
 * A command name lives in `lib/ipc.ts`, in `src-tauri/permissions/desktop.toml`
 * and in a capability file. Changing one without the others produces a command
 * that is REFUSED AT RUNTIME with a message about permissions — not a compile
 * error, and not something any type check sees. Nothing held those three files
 * together before this test.
 *
 * There are TWO windows now (spec 2026-09-12 § 5.1), and the boundary is which
 * one a page came from:
 *
 * - `wizard` is the assistant — a bundled `tauri://` page this repo ships — and
 *   it holds every command that drives the CLI, the destructive ones included.
 * - `main` shows the SERVER's own SPA. Unlike Subshell Client's remote window
 *   (which holds ONE path-only command, because a control plane can live
 *   anywhere and only the argument can be narrow there), this one shows the
 *   server THIS APP manages over loopback, so its origin is enumerable in
 *   `main.json`. It holds exactly FIVE commands, and the count
 *   is worth a test because "a few harmless ones" is how a boundary erodes —
 *   which is precisely what `desktop_set_supervision` proves can happen: four
 *   of them cannot reach the CLI at all, and that one can. It is an
 *   argued exception (operator's call 2026-09-12, accounted in
 *   `docs/security.md`), not a precedent. A sixth needs the same argument
 *   made again, in writing, before this number moves.
 *
 *   The fifth, `desktop_open_in_browser`, is of the harmless kind and joined
 *   the list on 2026-09-14: it takes a PATH, the Rust side refuses anything
 *   that could name a host, and the origin is the window's own. It is pinned
 *   by SIGNATURE below for the same reason the supervision one is — an
 *   exception is only as narrow as its arguments.
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
 * The commands ONE page can reach: the `ipc.<name>` calls in its own modules,
 * mapped to command names through ipc.ts's own exports.
 *
 * A page is a LIST of files, not one entry: the assistant is `wizard.ts` plus
 * every module under `assistant/`, which are loaded by that entry and by
 * nothing else. Reading the entry alone would make this pin blind to the
 * modules that hold the reset and the tmux docs — and blind in the
 * SAFE-LOOKING direction, reporting a smaller set than the window can reach.
 */
function commandsInvokedBy(...pageFiles: string[]): Set<string> {
  const nameToCommand = new Map<string, string>();
  const decl = /export const (\w+)[^;]*?invoke\s*(?:<[^>]*>)?\s*\(\s*"([^"]+)"/g;
  for (const m of ipcSource.matchAll(decl)) {
    nameToCommand.set(m[1] as string, m[2] as string);
  }
  const out = new Set<string>();
  for (const file of pageFiles) {
    const src = codeOf(join(UI_SRC, file)); // codeOf takes a PATH and strips comments itself
    for (const m of src.matchAll(/\bipc\.(\w+)\s*\(/g)) {
      const cmd = nameToCommand.get(m[1] as string);
      if (cmd) out.add(cmd);
    }
  }
  return out;
}

/** Every file the assistant loads: its entry and the modules under `assistant/`. */
function assistantPageFiles(): string[] {
  const dir = join(UI_SRC, "assistant");
  const modules = readdirSync(dir)
    .filter((name) => name.endsWith(".ts"))
    .map((name) => join("assistant", name));
  // A floor, so a directory that failed to list cannot pass this file's
  // equality checks by reporting an empty page.
  expect(modules.length, "the assistant's screen modules must be found").toBeGreaterThan(2);
  return ["wizard.ts", ...modules];
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

describe("the assistant's IPC contract", () => {
  it("is the app's only two capability files", () => {
    // The console's went with the console. A third capability file is a third
    // window, and a window added without a deliberate grant list is exactly
    // what the manifest below exists to prevent.
    expect(readdirSync(join(TAURI_DIR, "capabilities")).sort()).toEqual(["main.json", "wizard.json"]);
  });

  it("invokes exactly the commands the ACL grants this window", () => {
    // An EXACT set, not a subset: a command the page stops calling must leave
    // the capability too, or the window keeps a privilege nothing asked for.
    expect([...commandsInvokedBy(...assistantPageFiles())].sort()).toEqual([...grantedCommands("wizard.json")].sort());
    // And ipc.ts hides nothing extra: every command any page can invoke is
    // granted somewhere, and nothing in the typed edge is unreachable.
    expect([...invokedCommands()].sort()).toEqual([...commandsInvokedBy(...assistantPageFiles())].sort());
  });

  it("names no permission the manifest does not define", () => {
    const manifest = manifestPermissions();
    // `core:*`, `dialog:*` and `opener:*` come from Tauri and its plugins; only
    // this app's own `allow-desktop-*` identifiers have to exist in desktop.toml.
    // BOTH capability files: an undefined id in either would contribute nothing
    // to its file's expansion and slip past otherwise.
    const own = [...capabilityPermissions("main.json"), ...capabilityPermissions("wizard.json")].filter(
      (id) => !id.includes(":"),
    );
    for (const id of own) expect(manifest.has(id), `${id} is granted but not defined`).toBe(true);
  });

  it("defines no app permission neither capability grants", () => {
    // A granted-nowhere permission is a command no page can call, which is the
    // same runtime rejection read from the other end — and after a deletion it
    // is also how a dead command survives in Rust unnoticed.
    const granted = new Set([...capabilityPermissions("main.json"), ...capabilityPermissions("wizard.json")]);
    for (const id of manifestPermissions().keys()) expect(granted.has(id)).toBe(true);
  });

  it("keeps `main` to exactly its five commands — four harmless, one deliberate exception", () => {
    // Raise a window, drop this app's own title bar, display one fixed-shape
    // notification, open a page of this same server in the system browser —
    // and switch who runs the server. That last one is the
    // ONE command here that touches the service, and it is here on purpose
    // (operator's call, 2026-09-12): the assistant window that carried it read
    // as a bug, and a page that already holds the admin restart route can do
    // worse than move the server between two supervisors. The accounting is
    // in docs/security.md. Adding a SIXTH is the change this line exists to
    // make loud; so is quietly widening any of these.
    //
    // `desktop_open_assistant` is the deep link the SPA sends from three
    // places — the Settings danger card (`{ screen: "reset" }`), the Service
    // page's Update card (`{ screen: "update" }`) and the sidebar pill (no
    // argument). It names a SCREEN, never a command: raising `update`
    // performs one read-only probe, and every verb behind either screen needs
    // a press inside the bundled page.
    const manifest = manifestPermissions();
    const appCommands = capabilityPermissions("main.json")
      .filter((id) => !id.includes(":"))
      .flatMap((id) => manifest.get(id) ?? []);
    expect(appCommands.sort()).toEqual([
      "desktop_notify",
      "desktop_open_assistant",
      "desktop_open_in_browser",
      "desktop_set_supervision",
      "desktop_shell_ready",
    ]);
    // And no plugin permission of consequence: the loopback page gets dialog-
    // free, opener-free, fs-free handling by construction.
    const pluginPermissions = capabilityPermissions("main.json").filter((id) => id.includes(":"));
    expect(pluginPermissions.sort()).toEqual(["core:window:allow-start-dragging"]);
  });

  it("keeps `main`'s SCOPE pinned, not just its permission list", () => {
    // The list above says WHICH commands. This says WHO gets them, and until
    // now nothing held it: widening `remote.urls` to `http://*`, flipping
    // `local` to true, or adding a window id would hand this grant — the one
    // that includes `desktop_set_supervision` — to a page on any host, with
    // every command-name assertion in this file still passing.
    const capability = JSON.parse(readFileSync(join(TAURI_DIR, "capabilities", "main.json"), "utf8")) as {
      local?: boolean;
      remote?: { urls?: string[] };
      windows?: string[];
    };
    // Loopback, both spellings, any port — the server this app itself manages.
    // A wildcard host here is the failure this pins.
    expect(capability.remote?.urls?.slice().sort()).toEqual(["http://127.0.0.1:*", "http://localhost:*"]);
    for (const url of capability.remote?.urls ?? []) {
      expect(url.startsWith("http://localhost:") || url.startsWith("http://127.0.0.1:")).toBe(true);
    }
    // `local: false` is what makes this a REMOTE capability. True would apply
    // the same grant to bundled `tauri://` pages as well.
    expect(capability.local).toBe(false);
    // One window, by name. A second id added here inherits the whole grant.
    expect(capability.windows).toEqual(["main"]);
  });

  it("keeps the served page's one CLI-driving command to its known signature", () => {
    // `desktop_set_supervision` is the exception, and an exception is only as
    // narrow as its arguments. Every one of these is a CLOSED value Rust
    // validates — two booleans and a word checked against a two-item set —
    // so the page names no path, no command line and no host. A parameter
    // added later (a binary path, a service name, extra flags) would widen
    // what an XSS in the served SPA can ask for without touching the ACL,
    // which is the only thing this file otherwise watches.
    const rust = readFileSync(join(TAURI_DIR, "src/control.rs"), "utf8");
    const signature = rust.slice(rust.indexOf("pub fn desktop_set_supervision("));
    const params = signature.slice(signature.indexOf("(") + 1, signature.indexOf(")"));
    const names = params
      .split(",")
      .map((line) => line.trim())
      .filter(Boolean)
      .map((line) => line.split(":")[0]?.trim());
    expect(names).toEqual(["app", "mode", "autostart", "force"]);
    expect(params).toContain("mode: String");
    expect(params).toContain("autostart: bool");
    expect(params).toContain("force: bool");
  });

  it("keeps the browser command to a PATH, so the page names no host", () => {
    // The only string argument the served SPA sends, and the whole safety of
    // the command is what it CANNOT be. One parameter, `path`, joined onto the
    // origin this window is already on. A second string parameter — an origin,
    // a base URL, a host — would make the page able to name where the system
    // browser goes, which is a different command with the same name, and no
    // ACL assertion in this file would see it.
    const rust = readFileSync(join(TAURI_DIR, "src/control.rs"), "utf8");
    const signature = rust.slice(rust.indexOf("pub fn desktop_open_in_browser("));
    const params = signature.slice(signature.indexOf("(") + 1, signature.indexOf(")"));
    const names = params
      .split(",")
      .map((line) => line.trim())
      .filter(Boolean)
      .map((line) => line.split(":")[0]?.trim());
    expect(names).toEqual(["app", "path"]);
    expect(params).toContain("path: String");
    // And the refusals are the SHARED ones, not a second copy written here:
    // `crates/desktop-core` holds the join and its tests, so the two apps
    // cannot disagree about what a path is.
    expect(rust).toContain("subshell_desktop_core::browser::browser_url");
  });

  it("keeps the assistant's dialog surface to open alone", () => {
    // `pickBinary`'s file dialog is the page's only native popup. `ask` was
    // the console's — its update and restart confirmations — and both of those
    // are screens here, with their consequences written on the screen instead
    // of inside a system sheet.
    const dialog = capabilityPermissions("wizard.json").filter((id) => id.startsWith("dialog:"));
    expect(dialog.sort()).toEqual(["dialog:allow-open"]);
  });

  it("mentions no command the console took with it", () => {
    // Deleted in Rust (spec 2026-09-12 § 5.6). A leftover name in ipc.ts or a
    // page would be an invoke that rejects at runtime with a message about a
    // command that does not exist — which is indistinguishable, from the
    // page's side, from a permission it was never granted.
    const gone = [
      "desktop_open_console",
      "desktop_init",
      "desktop_settings",
      "desktop_set_close_to_tray",
      "desktop_open_control_plane",
    ];
    for (const file of sourceFiles()) {
      if (file.endsWith("ipc-acl.test.ts")) continue;
      const code = codeOf(file);
      for (const name of gone) expect(code, `${file} still names ${name}`).not.toContain(name);
    }
  });

  it("reaches Tauri through lib/ipc.ts and nowhere else", () => {
    // A stray `window.__TAURI__` read is dead code that will silently reject;
    // a stray `invoke("desktop_...")` outside the typed boundary is a command
    // the pins above have never seen.
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
