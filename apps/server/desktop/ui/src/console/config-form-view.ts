/**
 * The DOM half of the configuration form. The pure half — which fields exist,
 * what is sent, what `status` complains about — is `lib/config-form.ts`.
 *
 * Two surfaces build it: Overview's `init` step (a machine with a server and
 * no config.env, where the first save also installs and starts the service)
 * and the Addresses section (an edit of a configuration that exists). They
 * share this function rather than a copy each, because the prefill rule is
 * the subtle part and two copies would drift on it.
 */
import {
  CONFIG_FIELDS,
  derivedBaseUrl,
  type ExplicitMap,
  effectiveForm,
  explicitFields,
  fieldProblems,
} from "../lib/config-form";
import { state } from "./state";

/**
 * Build the form, seeded from what the server itself reports rather than from
 * a second copy of its defaults. See `configPayload` for why a value nobody
 * chose is still SENT as empty.
 *
 * A field the user has already typed into wins over the probe: every guarded
 * action ends with a re-probe, so re-seeding here would overwrite what someone
 * is in the middle of typing.
 */
export function buildForm(): HTMLElement {
  const seeded = effectiveForm(state.probe?.status?.settings);
  for (const { name } of CONFIG_FIELDS) state.form[name] = state.form[name] || seeded[name];
  // Additive, and needed because the `init` step is reached without going
  // through the Addresses section's seeding: a value already chosen (an env
  // var, on a machine with no config.env yet) must still be sent back rather
  // than dropped.
  for (const [name, on] of Object.entries(explicitFields(state.probe?.status?.settings)) as [
    keyof ExplicitMap,
    boolean,
  ][]) {
    if (on) state.explicit[name] = true;
  }
  const wrap = document.createElement("div");
  wrap.className = "grid w-full grid-cols-2 gap-2.5";
  for (const field of CONFIG_FIELDS) {
    const { name, label, placeholder, numeric, wide, hint } = field;
    const cell = document.createElement("div");
    // A URL and a comma-separated list do not fit half a two-column grid.
    if (wide) cell.className = "col-span-2";
    const l = document.createElement("label");
    l.htmlFor = `field-${name}`;
    l.textContent = label;
    const input = document.createElement("input");
    input.id = `field-${name}`;
    input.value = state.form[name];
    input.placeholder = placeholder;
    input.spellcheck = false;
    input.autocapitalize = "off";
    if (numeric) input.inputMode = "numeric";
    input.addEventListener("input", () => {
      state.form[name] = input.value;
      state.explicit[name] = true;
      // An untouched base URL FOLLOWS the port. The save is already safe
      // without this (unedited fields are sent empty, so the CLI re-derives),
      // but a filled field still reading `http://localhost:3080` after the
      // port became 4000 looks exactly like the value about to be written.
      if (name === "port" && state.explicit.baseUrl !== true) {
        state.form.baseUrl = derivedBaseUrl(input.value);
        const mirror = document.getElementById("field-baseUrl") as HTMLInputElement | null;
        if (mirror) mirror.value = state.form.baseUrl;
      }
    });
    cell.append(l, input);
    if (hint) {
      const h = document.createElement("p");
      h.className = "hint";
      h.textContent = hint;
      cell.append(h);
    }
    // What `status` says a BROWSER will do with the value currently stored —
    // beside the field that changes it, which is the whole reason those
    // problems travel as data rather than as a line of CLI output.
    //
    // These describe the STORED value and stay put while the field is edited.
    // A guard that hid them on edit was tried and removed: the form is built
    // only when its surface is entered, so it never re-ran on input and the
    // guard was dead code behind a comment claiming otherwise. Re-rendering
    // per keystroke to make it true would rebuild the inputs and lose focus —
    // and a problem about the value on disk is still true while someone types
    // a replacement, so there is nothing to hide. It clears on save, when the
    // re-probe reports the new value.
    for (const problemEntry of fieldProblems(state.probe?.status?.settings, name)) {
      const warn = document.createElement("p");
      warn.className = "hint warn-text";
      warn.textContent = problemEntry.reason;
      cell.append(warn);
    }
    wrap.append(cell);
  }
  return wrap;
}
