import { afterEach, describe, expect, it } from "bun:test";
import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";
import { z } from "zod";
import { type FieldProblems, fieldError, fieldErrorToned, makeForm, useSubmitDisabled } from "@/lib/form";
import { makePromptStackSchema } from "@/lib/prompt-stack-form";

afterEach(cleanup);

// The picker's real shape: an always-required body plus a description that is
// required only while a switch is ON — the conditional the substrate must
// recompute on its own (a hand-rolled disabled could forget it).
const schema = z
  .object({
    body: z.string(),
    description: z.string(),
    save: z.boolean(),
  })
  .superRefine((values, ctx) => {
    if (values.body.trim() === "") {
      ctx.addIssue({ code: "custom", path: ["body"], message: "The prompt text is required" });
    }
    if (values.save && values.description.trim() === "") {
      ctx.addIssue({ code: "custom", path: ["description"], message: "A saved prompt needs a short description" });
    }
  });

function Probe({ onSubmit }: { onSubmit: (values: { body: string; description: string; save: boolean }) => void }) {
  const form = makeForm({ defaultValues: { body: "", description: "", save: false }, validator: schema, onSubmit });
  const disabled = useSubmitDisabled(form);
  return (
    <form
      onSubmit={(e) => {
        e.preventDefault();
        void form.handleSubmit();
      }}
    >
      <form.Field name="body">
        {(field) => (
          <>
            <textarea
              data-testid="body"
              value={field.state.value}
              onChange={(e) => field.handleChange(e.target.value)}
              onBlur={field.handleBlur}
            />
            {field.state.meta.isTouched && fieldError(field.state.meta.errors) && (
              <p role="alert">{fieldError(field.state.meta.errors)}</p>
            )}
          </>
        )}
      </form.Field>
      <form.Field name="description">
        {(field) => (
          <>
            <input
              data-testid="description"
              value={field.state.value}
              onChange={(e) => field.handleChange(e.target.value)}
              onBlur={field.handleBlur}
            />
            {field.state.meta.isTouched && fieldError(field.state.meta.errors) && (
              <p role="alert">{fieldError(field.state.meta.errors)}</p>
            )}
          </>
        )}
      </form.Field>
      <form.Field name="save">
        {(field) => (
          <input
            data-testid="save"
            type="checkbox"
            checked={field.state.value}
            onChange={(e) => field.handleChange(e.target.checked)}
          />
        )}
      </form.Field>
      <button data-testid="submit" type="submit" disabled={disabled}>
        go
      </button>
    </form>
  );
}

describe("form substrate (spec 2026-09-29)", () => {
  it("starts DISABLED on a pristine form (onMount validation runs before any keystroke)", () => {
    render(<Probe onSubmit={() => {}} />);
    expect((screen.getByTestId("submit") as HTMLButtonElement).disabled).toBe(true);
    // And quiet: the untouched field shows no red sentence yet.
    expect(screen.queryByRole("alert")).toBeNull();
  });

  it("fills, gates, and re-gates on the switch — all through the one schema", () => {
    render(<Probe onSubmit={() => {}} />);
    // Body filled, switch OFF: the description is optional, gate opens.
    fireEvent.change(screen.getByTestId("body"), { target: { value: "b" } });
    expect((screen.getByTestId("submit") as HTMLButtonElement).disabled).toBe(false);
    // Switch ON with an empty description: the conditional requirement closes
    // the gate by itself — no field changed, the OTHER field became required.
    fireEvent.click(screen.getByTestId("save"));
    expect((screen.getByTestId("submit") as HTMLButtonElement).disabled).toBe(true);
    // Switch back OFF: opens again.
    fireEvent.click(screen.getByTestId("save"));
    expect((screen.getByTestId("submit") as HTMLButtonElement).disabled).toBe(false);
  });

  it("the switch ON makes the empty description invalid AND its sentence shows once touched", () => {
    render(<Probe onSubmit={() => {}} />);
    fireEvent.change(screen.getByTestId("body"), { target: { value: "b" } });
    fireEvent.click(screen.getByTestId("save")); // switch ON: gate closes with no touch needed
    expect((screen.getByTestId("submit") as HTMLButtonElement).disabled).toBe(true);
    fireEvent.change(screen.getByTestId("description"), { target: { value: "d" } });
    fireEvent.blur(screen.getByTestId("description"));
    fireEvent.change(screen.getByTestId("description"), { target: { value: "   " } });
    fireEvent.click(screen.getByTestId("submit")); // stays inert, but the reason is on screen
    expect(screen.getByRole("alert").textContent).toBe("A saved prompt needs a short description");
  });

  it("a function validator (the formProblems shape) gates identically", () => {
    function FnProbe() {
      const form = makeForm({
        defaultValues: { host: "" },
        validator: (values: { host: string }): FieldProblems =>
          values.host.trim() === "" ? { host: "This field is required" } : {},
        onSubmit: () => {},
      });
      const disabled = useSubmitDisabled(form);
      return (
        <>
          <form.Field name="host">
            {(field) => (
              <input
                data-testid="host"
                value={field.state.value}
                onChange={(e) => field.handleChange(e.target.value)}
              />
            )}
          </form.Field>
          <button data-testid="submit" type="submit" disabled={disabled}>
            go
          </button>
        </>
      );
    }
    render(<FnProbe />);
    expect((screen.getByTestId("submit") as HTMLButtonElement).disabled).toBe(true);
    fireEvent.change(screen.getByTestId("host"), { target: { value: "h" } });
    expect((screen.getByTestId("submit") as HTMLButtonElement).disabled).toBe(false);
  });

  it("handleSubmit still fires the guard path (onSubmit validation, values delivered trimmed-of-validity)", async () => {
    const sent: unknown[] = [];
    render(<Probe onSubmit={(v) => sent.push(v)} />);
    fireEvent.change(screen.getByTestId("body"), { target: { value: "hello" } });
    // The button is the UI gate, not the only path: direct handleSubmit works
    // (it is async — onSubmit validation runs before the handoff).
    await act(async () => {
      fireEvent.click(screen.getByTestId("submit"));
    });
    expect(sent.length).toBe(1);
    expect(sent[0]).toMatchObject({ body: "hello" });
  });
});

describe("fieldErrorToned (the gold/red split, ruling 2026-09-30)", () => {
  it("tags a gap:true issue as a requirement (gold) and everything else as a hard error (red)", () => {
    expect(fieldErrorToned([{ message: "A stack needs a short label", gap: true }])).toEqual({
      text: "A stack needs a short label",
      gap: true,
    });
    expect(fieldErrorToned(["Plain string"])).toEqual({ text: "Plain string", gap: false });
    expect(fieldErrorToned([{ message: "too long" }])).toEqual({ text: "too long", gap: false });
    expect(fieldErrorToned([{ message: "", gap: true }, "second"])).toEqual({ text: "second", gap: false });
    expect(fieldErrorToned([])).toBeNull();
  });

  it("the REAL schema carries the tag: zod keeps custom keys on the issue it is given", () => {
    // The split rides on zod preserving `gap` through to the field's error
    // list. If a schema upgrade ever strips extra keys, this fails - the
    // unfilled fields would silently turn red.
    const schema = makePromptStackSchema(1);
    const bad = schema.safeParse({ label: "  ", blocks: [], shared: false });
    expect(bad.success).toBe(false);
    const issues = bad.success ? [] : bad.error.issues;
    expect(issues.map((i) => (i as { message: string; gap?: unknown }).gap)).toContain(true);
    // And a HARD error (over the joined cap) arrives WITHOUT the tag.
    const huge = Array.from({ length: 50 }, (_, i) => ({
      localId: `l${i}`,
      kind: "custom" as const,
      description: "",
      body: "x".repeat(420),
    }));
    const cap = schema.safeParse({ label: "Fine", blocks: huge, shared: false });
    expect(cap.success).toBe(false);
    const capIssues = cap.success ? [] : cap.error.issues;
    expect(capIssues.length).toBeGreaterThan(0);
    expect(capIssues.every((i) => (i as { gap?: unknown }).gap !== true)).toBe(true);
  });
});
