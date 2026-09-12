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

describe("the assistant's wiring, pinned at the source", () => {
  // These read the render path because the tests here run without a DOM: the
  // contract lives in code the test runner cannot execute. `wizard.ts` is the
  // whole render path now that the console is gone, and the tmux warning is
  // the one piece of it that lives in its own module.
  //
  // Reading the wrong file would pass vacuously against a string that simply
  // is not there, so every pin below also asserts its anchor was found.
  const wizard = readFileSync(join(ROOT, "ui/src/wizard.ts"), "utf8");
  const tmuxWarning = readFileSync(join(ROOT, "ui/src/assistant/tmux-warning.ts"), "utf8");

  /**
   * The form is prefilled, so `configPayload` decides what to send from an
   * `explicit` map rather than from blankness. That map MUST be seeded from
   * `explicitFields` when the form is built: keyed on editing alone, opening
   * Customize and pressing Set Up without touching the addresses field sends
   * an empty `trustedOrigins`, which means "no extra addresses" and wipes a
   * stored list. Pinned at the source because this wiring imports Tauri and
   * cannot be loaded here.
   */
  test("the address form seeds `explicit` from explicitFields, not from editing alone", () => {
    const at = wizard.indexOf("function addressForm(");
    expect(at, "the assistant must build an address form").toBeGreaterThan(-1);
    const body = wizard.slice(at, wizard.indexOf("\nfunction ", at + 1));
    expect(body).toContain("explicitFields(");
    // And every send goes through the map. The floor is load-bearing: with
    // zero matches the loop passes vacuously, so renaming the call site would
    // silently erase this pin.
    const sends = wizard.match(/configPayload\([^)]*\)/g) ?? [];
    expect(sends.length).toBeGreaterThanOrEqual(1);
    for (const call of sends) expect(call).toBe("configPayload(form, explicit)");
  });

  /**
   * The CLI refuses `init` and `service install` without tmux, so a recovery
   * action that runs either must be disabled with its reason beside it — a
   * button that can only produce the refusal is a button that teaches the
   * reader to ignore it. Retry and Choose are exempt because neither launches
   * a pane, and gating them would strand the one machine that has no server
   * to install tmux for.
   */
  test("the recovery screen gates every action that needs tmux, and only those", () => {
    const at = wizard.indexOf("const gated =");
    expect(at, "the recovery screen must compute a tmux gate").toBeGreaterThan(-1);
    const expr = wizard.slice(at, wizard.indexOf(";", at));
    expect(expr).toContain("tmuxMissing");
    expect(expr).toContain('action.kind !== "retry"');
    expect(expr).toContain('action.kind !== "choose-binary"');
  });

  test("the tmux warning links out to the docs", () => {
    // Spec §6.1 requires the no-Homebrew screen to LINK to the tmux formula
    // page, not just show a command. The link is a button calling the
    // fixed-URL command (`openTmuxDocs` in lib/ipc.ts — the page sends no URL
    // anywhere, the same rule `desktop_open_path` follows; the command name
    // itself is pinned by ipc-acl.test.ts), and `applyPlan` decides its
    // visibility from the plan's `docsUrl`.
    expect(tmuxWarning).toContain("openTmuxDocs");
    expect(tmuxWarning).toContain("docsUrl");
  });
});

describe("the assistant's stylesheet", () => {
  /**
   * `.warn-text` and `.hint` are both single-class selectors, so for an element
   * carrying BOTH the later declaration wins. The problem lines this page
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
