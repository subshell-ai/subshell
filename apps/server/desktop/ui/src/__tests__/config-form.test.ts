/**
 * The console's configure form is the only place these four keys are typed
 * together, and it is a NON-INTERACTIVE `init --yes` under the hood — so
 * `configure` resolves every unflagged key to its stored value. That makes the
 * seeding rule load-bearing rather than cosmetic: a field the form fails to
 * seed is a field the form sends back wrong, and the two failure modes are
 * silent (a repointed database, an origin list quietly dropped).
 *
 * These are the pure halves of the console — no DOM, no Tauri.
 */
import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import {
  CONFIG_FIELDS,
  configPayload,
  derivedBaseUrl,
  effectiveForm,
  explicitFields,
  fieldProblems,
} from "../lib/config-form";
import type { SettingEntry } from "../lib/ipc";

const ROOT = join(import.meta.dir, "../../..");

/** A `status --json` settings map, one entry per key given. */
const settings = (entries: Record<string, [string, string]>): Record<string, SettingEntry> =>
  Object.fromEntries(Object.entries(entries).map(([key, [value, source]]) => [key, { value, source }]));

describe("effectiveForm", () => {
  test("prefills port, bind address and base URL with what the server would boot with", () => {
    // The fields used to be blank whenever the value was derived, which left
    // the reader to notice greyed placeholder text to learn the configuration.
    expect(
      effectiveForm(
        settings({
          SERVER_PORT: ["3080", "default"],
          HOST: ["0.0.0.0", "default"],
          APP_BASE_URL: ["http://localhost:3080", "default"],
          TRUSTED_ORIGINS: ["http://localhost:5174,http://localhost:5173", "default"],
        }),
      ),
    ).toEqual({
      port: "3080",
      host: "0.0.0.0",
      baseUrl: "http://localhost:3080",
      // NOT prefilled: its default is the dev Vite origins, which would be a
      // bizarre thing to show someone configuring a real instance.
      trustedOrigins: "",
    });
  });

  test("shows a chosen value over a derived one", () => {
    expect(effectiveForm(settings({ SERVER_PORT: ["4000", "config.env"] })).port).toBe("4000");
  });

  test("is empty before the first probe lands", () => {
    expect(effectiveForm(undefined)).toEqual({ port: "", host: "", baseUrl: "", trustedOrigins: "" });
    expect(effectiveForm({})).toEqual({ port: "", host: "", baseUrl: "", trustedOrigins: "" });
  });
});

describe("explicitFields", () => {
  test("marks only what somebody chose", () => {
    const e = explicitFields(
      settings({
        SERVER_PORT: ["4000", "config.env"],
        HOST: ["0.0.0.0", "default"],
        APP_BASE_URL: ["http://box.local:4000", "process env"],
      }),
    );
    expect(e.port).toBe(true);
    expect(e.baseUrl).toBe(true);
    expect(e.host).toBeUndefined();
    expect(e.trustedOrigins).toBeUndefined();
  });

  test("an empty chosen value is not a choice", () => {
    expect(explicitFields(settings({ TRUSTED_ORIGINS: ["", "config.env"] })).trustedOrigins).toBeUndefined();
  });

  test("nothing is explicit before the first probe", () => {
    expect(explicitFields(undefined)).toEqual({});
  });
});

describe("derivedBaseUrl", () => {
  test("mirrors the CLI's derivation, so a prefilled base URL can follow the port", () => {
    expect(derivedBaseUrl("4000")).toBe("http://localhost:4000");
    expect(derivedBaseUrl(" 9000 ")).toBe("http://localhost:9000");
  });

  test("falls back to the default port for an empty field mid-edit", () => {
    expect(derivedBaseUrl("")).toBe("http://localhost:3080");
  });
});

describe("configPayload", () => {
  test("sends every field, so a save means the form and not the file", () => {
    expect(
      configPayload({
        port: "9000",
        host: "0.0.0.0",
        baseUrl: "http://box.local:9000",
        trustedOrigins: "http://box.local:9000",
      }),
    ).toEqual({
      port: "9000",
      host: "0.0.0.0",
      baseUrl: "http://box.local:9000",
      trustedOrigins: "http://box.local:9000",
    });
  });

  /**
   * The asymmetry is the whole contract. An empty port/host/base-url means
   * "you decide" — the Rust side omits the flag. An empty origins field means
   * "none", which has to reach the CLI as an explicit empty `--trusted-origins`
   * or a cleared list would silently come back on the next save.
   */
  test("an empty origins field is sent as an explicit empty string, never dropped", () => {
    expect(configPayload({ port: "", host: "", baseUrl: "", trustedOrigins: "" })).toEqual({
      port: "",
      host: "",
      baseUrl: "",
      trustedOrigins: "",
    });
  });

  test("whitespace in the origins field is not mistaken for a value", () => {
    expect(configPayload({ trustedOrigins: "  " }).trustedOrigins).toBe("");
  });

  test("a partially filled form still names all four keys", () => {
    expect(Object.keys(configPayload({ port: "9000" })).sort()).toEqual(["baseUrl", "host", "port", "trustedOrigins"]);
  });
});

describe("CONFIG_FIELDS", () => {
  test("declares one row per form key, and every key effectiveForm fills", () => {
    // Keys-first so the assertion compares string[] to string[]: bun's
    // `toEqual` binds the expected type to the actual's, and `FormName[]` is
    // assignable to `string[]` but not the reverse.
    expect(Object.keys(effectiveForm({})).sort()).toEqual(CONFIG_FIELDS.map((f) => f.name).sort());
  });

  test("every field names the status key it seeds from", () => {
    for (const field of CONFIG_FIELDS) {
      expect(field.settingKey).toMatch(/^[A-Z_]+$/);
    }
  });
});

describe("configPayload with the explicit map", () => {
  const filled = {
    port: "3080",
    host: "0.0.0.0",
    baseUrl: "http://localhost:3080",
    trustedOrigins: "http://box.local:3080",
  };

  test("sends every field when nothing is known about choices", () => {
    expect(configPayload(filled)).toEqual(filled);
  });

  test("a value nobody chose is sent EMPTY, so the CLI keeps deriving it", () => {
    // The fields are prefilled, so without this the derived base URL would be
    // written into config.env and would then name a dead port after the next
    // port change. This is the failure the whole form was added to fix.
    expect(configPayload(filled, { port: true })).toEqual({
      port: "3080",
      host: "",
      baseUrl: "",
      trustedOrigins: "",
    });
  });

  test("a CHOSEN value is sent even when untouched, or saving would wipe it", () => {
    // trustedOrigins is the emptyable flag: an empty one means "no extra
    // addresses". Opening Configure and saving without touching the field must
    // not clear a stored list.
    expect(
      configPayload(filled, explicitFields(settings({ TRUSTED_ORIGINS: ["http://box.local:3080", "config.env"] }))),
    ).toEqual({ port: "", host: "", baseUrl: "", trustedOrigins: "http://box.local:3080" });
  });

  test("clearing a chosen field still clears it", () => {
    // The user typed in it, so it is explicit, and empty means empty.
    expect(configPayload({ ...filled, trustedOrigins: "" }, { trustedOrigins: true }).trustedOrigins).toBe("");
  });

  test("trims what it sends", () => {
    expect(configPayload({ port: "  4000  " }, { port: true }).port).toBe("4000");
  });
});

describe("fieldProblems", () => {
  /**
   * The reason `status` carries problems as data rather than as a rendered
   * line: the console can put the diagnosis next to the field being edited,
   * instead of leaving it in the output block at the bottom.
   */
  test("returns the problems for the field's own status key", () => {
    const s = {
      TRUSTED_ORIGINS: {
        value: "box.local:3080",
        source: "config.env",
        problems: [{ entry: "box.local:3080", reason: "no scheme" }],
      },
    };
    expect(fieldProblems(s, "trustedOrigins")).toEqual([{ entry: "box.local:3080", reason: "no scheme" }]);
  });

  test("empty for a field with none, and for a missing settings map", () => {
    expect(fieldProblems({ TRUSTED_ORIGINS: { value: "x", source: "config.env" } }, "trustedOrigins")).toEqual([]);
    expect(fieldProblems(undefined, "trustedOrigins")).toEqual([]);
    expect(fieldProblems({}, "port")).toEqual([]);
  });

  test("does not leak one field's problems onto another", () => {
    const s = {
      APP_BASE_URL: { value: "nope", source: "config.env", problems: [{ entry: "nope", reason: "bad url" }] },
    };
    expect(fieldProblems(s, "baseUrl")).toHaveLength(1);
    expect(fieldProblems(s, "trustedOrigins")).toEqual([]);
    expect(fieldProblems(s, "port")).toEqual([]);
  });

  test("every CONFIG_FIELDS entry can be asked, so the render never has a gap", () => {
    for (const field of CONFIG_FIELDS) {
      expect(fieldProblems({}, field.name)).toEqual([]);
    }
  });
});

describe("the console's wiring, pinned at the source", () => {
  // These read the render path because the tests here run without a DOM: the
  // contract lives in code these files cannot execute.
  const main = readFileSync(join(ROOT, "ui/src/main.ts"), "utf8");

  /**
   * The form is prefilled, so `configPayload` decides what to send from an
   * `explicit` map rather than from blankness. That map MUST be seeded from
   * `explicitFields` when the configure form opens: keyed on editing alone,
   * opening Configure and saving without touching the addresses field sends an
   * empty `trustedOrigins`, which means "no extra addresses" and wipes a
   * stored list. Pinned at the source because this wiring lives in `main.ts`,
   * which imports Tauri and cannot be loaded here.
   */
  test("the configure form seeds `explicit` from explicitFields, not from editing alone", () => {
    const fn = main.slice(main.indexOf("function showConfigure()"));
    const body = fn.slice(0, fn.indexOf("\n}"));
    expect(body).toContain("explicitFields(");
    // And every send goes through the map. The floor is load-bearing: with
    // zero matches the loop passes vacuously, so renaming both call sites
    // would silently erase this pin. Today there are exactly two (init,
    // configure).
    const sends = main.match(/configPayload\([^)]*\)/g) ?? [];
    expect(sends.length).toBeGreaterThanOrEqual(2);
    for (const call of sends) {
      expect(call).toBe("configPayload(form, explicit)");
    }
  });

  /**
   * `refresh` rewrites `problem` from `probe.error`, so the guard must apply
   * an action's own failure line AFTER its settle loop, not inside the try.
   * It did not, until 2026-09-10: every successful re-probe erased "That did
   * not work. See the output below." before the render that showed it, and
   * only the red output pane survived to say anything. Measured with the
   * built page under a stubbed bridge — a refusal rendered, the line never
   * did.
   */
  test("an action's failure line is applied after the guard's re-probe", () => {
    const fn = main.slice(main.indexOf("function guard("), main.indexOf("const retry = guard"));
    const apply = fn.indexOf("if (failure !== null) problem = failure;");
    const reprobe = fn.lastIndexOf("await refresh();");
    expect(apply).toBeGreaterThan(-1);
    expect(reprobe).toBeGreaterThan(-1);
    expect(apply, "the failure line must be set after the last refresh()").toBeGreaterThan(reprobe);
  });

  test("every setup-advancing console action is tmux-gated", () => {
    /** The `[...]` starting at `from`, found by bracket depth rather than by regex. */
    const entryAt = (from: number): string => {
      let depth = 0;
      for (let i = from; i < main.length; i++) {
        if (main[i] === "[") depth++;
        else if (main[i] === "]" && --depth === 0) return main.slice(from + 1, i);
      }
      throw new Error("unbalanced action entry");
    };

    /** Split on TOP-LEVEL commas: a handler like `service("install", true)` has its own. */
    const args = (entry: string): string[] => {
      const out: string[] = [];
      let depth = 0;
      let start = 0;
      for (let i = 0; i < entry.length; i++) {
        const c = entry[i];
        if (c === "(" || c === "[") depth++;
        else if (c === ")" || c === "]") depth--;
        else if (c === "," && depth === 0) {
          out.push(entry.slice(start, i).trim());
          start = i + 1;
        }
      }
      out.push(entry.slice(start).trim());
      return out;
    };

    // `renderStep` disables buttons flagged `data-tmux` while the probe finds
    // no tmux, and the flag is the 4th argument to `button()`. Every step that
    // ADVANCES setup must carry it: the CLI refuses `init`, `configure` and
    // `service install` without tmux, so an enabled button there only produces
    // the refusal.
    //
    // "Install server" was the one that did not. Installing the binary does
    // not itself need tmux — which is why it looked correct — but the step
    // immediately after it is `Create configuration`, which refuses. So the
    // console walked the user to a wall it already knew about.
    //
    // "Set up and start" inherits that gate as the chain it replaced. Agent
    // CLI installs moved to the control plane (spec 2026-09-11 § 7) and this
    // app's own "Add agents in the dashboard" button only opens the
    // dashboard — it is not gated, because opening a window needs no pane.
    for (const label of [
      "Set up and start",
      "Save and start",
      "Install and start as a service",
      "Start",
      "Save and restart",
    ]) {
      const at = main.indexOf(`["${label}",`);
      expect(at, `no action entry found for "${label}"`).toBeGreaterThan(-1);
      expect(args(entryAt(at))[3], `"${label}" is not tmux-gated`).toBe("true");
    }
  });

  test("the setup step offers nothing that cannot run without a server", () => {
    // `setup` is emitted exactly when no binary resolves (`Setup` replaces
    // `InstallServer` only where `resolve` found nothing), and every write
    // verb — `desktop_init`, `desktop_service` — answers "no subshell-server
    // found" there. "Change addresses…" lived on this screen briefly: its
    // save could only ever fail, and the next "Set up and start" discarded
    // what was typed without a word. The form is reachable the moment a
    // server exists, which is every screen after this one.
    const at = main.indexOf("  setup: {");
    expect(at).toBeGreaterThan(-1);
    const entry = main.slice(at, main.indexOf("\n  },", at));
    expect(entry).not.toContain("showConfigure");
    expect(entry).not.toContain("doInit");
  });

  test("the tmux warning links out to the docs", () => {
    // Spec §6.1 requires the no-Homebrew screen to LINK to the tmux formula
    // page, not just show a command. The link is a button calling the fixed-URL
    // command (`openTmuxDocs` in lib/ipc.ts — the page sends no URL anywhere,
    // the same rule `desktop_open_control_plane` follows; the command name
    // itself is pinned by ipc-acl.test.ts), and `applyPlan` decides its
    // visibility from the plan's `docsUrl`.
    expect(main).toContain("openTmuxDocs");
    expect(main).toContain("docsUrl");
  });
});

describe("the console's stylesheet", () => {
  /**
   * `.warn-text` and `.hint` are both single-class selectors, so for an element
   * carrying BOTH the later declaration wins. The problem lines `main.ts`
   * builds are `class="hint warn-text"` and rendered amber deliberately — with
   * `.warn-text` declared first they came out muted grey, indistinguishable
   * from the ordinary field hint directly above them. Same cascade LAYER is
   * part of the contract: moved into different layers, layer order would beat
   * source order and the fix would silently invert. No test can see a computed
   * colour here, so the ORDER is what gets pinned.
   */
  test("`.warn-text` is declared after `.hint` in the same layer, or a combined class renders muted", () => {
    const css = readFileSync(join(ROOT, "ui/src/styles.css"), "utf8");
    const hint = css.indexOf(".hint {");
    const warn = css.indexOf(".warn-text {");
    expect(hint).toBeGreaterThan(-1);
    expect(warn).toBeGreaterThan(hint);
    // Same cascade LAYER: a `@layer` opening between the two would move one
    // of them, and layer precedence would silently beat declaration order —
    // the exact failure this pin exists to catch, arriving by refactor
    // rather than by reordering.
    expect(css.slice(hint, warn)).not.toContain("@layer");
  });
});
