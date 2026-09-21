/**
 * The four address fields, drawn from `CONFIG_FIELDS` (spec 2026-09-21; plan
 * Task 3, reused by Task 6).
 *
 * Shared by the two screens that edit them — the first run's *Customize port
 * and addresses…* and **Server Addresses** — because what they draw is one
 * contract (`lib/config-form.ts`) and a second copy of the grid is a second
 * place for the send rules to drift. What differs is passed in: each screen
 * brings its OWN state, so neither shows the other's half-typed values, and
 * `onEdit` is where the setup screen re-measures the port.
 *
 * The inputs are CONTROLLED, which is the one deliberate reshaping the React
 * port makes: the old form mutated its values object and patched the base-URL
 * mirror's DOM node in place, because a re-render would have taken the cursor
 * out of the field. A React re-render is reconciliation, and a controlled
 * input keeps its text and cursor — so the mirror is a value like any other,
 * carried in the next state the handler hands up.
 */
import type { ReactElement } from "react";
import {
  CONFIG_FIELDS,
  derivedBaseUrl,
  type ExplicitMap,
  effectiveForm,
  type FormName,
  type FormValues,
  fieldProblems,
} from "../lib/config-form";
import type { Probe, SettingEntry } from "../lib/ipc";

/** What an edit hands up: the whole next form state, plus which field moved. */
export interface AddressEdit {
  name: FormName;
  values: FormValues;
  explicit: ExplicitMap;
}

export function AddressFields(props: {
  /** The form's current values and chosen-fields map. */
  values: FormValues;
  explicit: ExplicitMap;
  /** The machine's stored settings, for the per-field problem lines. */
  settings: Record<string, SettingEntry> | undefined;
  /** Called with the whole next state after each edit. */
  onEdit: (edit: AddressEdit) => void;
  /**
   * A per-field note, rendered under the hint. The settings screen passes the
   * https-restart note; the setup screen passes none.
   */
  note?: (field: (typeof CONFIG_FIELDS)[number], values: FormValues) => ReactElement | null;
}): ReactElement {
  const handleInput = (field: (typeof CONFIG_FIELDS)[number], raw: string): void => {
    const values: FormValues = { ...props.values, [field.name]: raw };
    const explicit: ExplicitMap = { ...props.explicit, [field.name]: true };
    // The base-URL-follows-the-port mirror: a base URL nobody chose is derived
    // from the port, so a filled field reading `http://localhost:3080` beside
    // a port of 4000 would look like the value about to be written.
    if (field.name === "port" && props.explicit.baseUrl !== true) {
      values.baseUrl = derivedBaseUrl(raw);
    }
    props.onEdit({ name: field.name, values, explicit });
  };
  return (
    <div className="mt-4 grid w-full grid-cols-2 gap-2.5">
      {CONFIG_FIELDS.map((field) => (
        <div key={field.name} className={field.wide ? "col-span-2" : undefined}>
          <label htmlFor={`field-${field.name}`}>{field.label}</label>
          <input
            id={`field-${field.name}`}
            value={props.values[field.name]}
            placeholder={field.placeholder}
            spellCheck={false}
            autoCapitalize="off"
            inputMode={field.numeric ? "numeric" : undefined}
            onChange={(e) => handleInput(field, e.currentTarget.value)}
          />
          {field.hint && <p className="hint">{field.hint}</p>}
          {props.note?.(field, props.values)}
          {fieldProblems(props.settings, field.name).map((pe) => (
            <p key={`${pe.entry}-${pe.reason}`} className="hint warn-text">
              {pe.reason}
            </p>
          ))}
        </div>
      ))}
    </div>
  );
}

/**
 * The port the setup chain would actually bind.
 *
 * Seeded the way the form seeds its own field, because the form may never
 * have been opened: `form.port` stays empty until it renders once, so reading
 * it alone would ask about port 3080 on a machine configured for 4000.
 * `effectiveForm` is the one place that turns `status --json`'s settings into
 * what the field would show, and the `"3080"` tail is `setupRows`' own
 * fallback — a blank port means the CLI's default, not "no port".
 */
export function chosenPort(form: FormValues, probe: Probe): string {
  return (form.port || effectiveForm(probe.status?.settings).port || "").trim() || "3080";
}
