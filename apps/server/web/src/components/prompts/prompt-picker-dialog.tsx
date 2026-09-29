import { Button, errMessage, Input, Label, Switch } from "@internal/node-admin";
import { useStore } from "@tanstack/react-form";
import { PenLine } from "lucide-react";
import { useEffect, useState } from "react";
import { z } from "zod";
import { SearchableSelect } from "@/components/ui/combobox";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Segmented } from "@/components/ui/segmented";
import { Textarea } from "@/components/ui/textarea";
import { useCreatePrompt, usePrompts } from "@/hooks/use-prompts";
import { fieldError, makeForm, useSubmitDisabled } from "@/lib/form";
import { newPromptLocalId, type PromptBlock } from "@/lib/prompt-stack";
import type { PromptsView } from "@/lib/prompts";

/** What "Write your own..." keeps across an accidental reload (operator
 *  ruling 2026-09-29): the draft lives in sessionStorage (so a closed tab
 *  discards it) and is removed the moment the draft is SUBMITTED. */
interface PickerDraft {
  body: string;
  description: string;
  saveToLibrary: boolean;
}

function draftKey(mode: "multi" | "single"): string {
  return `subshell/prompt-picker-draft/${mode}`;
}

function loadDraft(mode: "multi" | "single"): PickerDraft | null {
  try {
    const raw = sessionStorage.getItem(draftKey(mode));
    if (raw === null) return null;
    const parsed = JSON.parse(raw) as Partial<PickerDraft>;
    if (typeof parsed?.body !== "string") return null;
    return {
      body: parsed.body,
      description: typeof parsed.description === "string" ? parsed.description : "",
      saveToLibrary: parsed.saveToLibrary === true,
    };
  } catch {
    return null;
  }
}

/** The ONE validity rule for the custom step (substrate spec 2026-09-29):
 *  the button's `disabled` and the submit guard read this same schema, so
 *  they cannot drift. The description is required only while the save
 *  switch is ON — the conditional a hand-rolled disabled could forget. */
const customStepSchema = z
  .object({ body: z.string(), description: z.string(), saveToLibrary: z.boolean() })
  .superRefine((values, ctx) => {
    if (values.body.trim() === "") {
      ctx.addIssue({ code: "custom", path: ["body"], message: "The prompt text is required" });
    }
    if (values.saveToLibrary && values.description.trim() === "") {
      ctx.addIssue({ code: "custom", path: ["description"], message: "A saved prompt needs a short description" });
    }
  });

/**
 * The shared prompt picker (spec 2026-09-28): the launch form's block stack
 * and the subshell menu's inject action both open THIS dialog, so "choose a
 * prompt" looks and behaves the same in both. The search is the shared
 * searchable dropdown, filtering description OR body; the own/shared tabs
 * are the same question the page answers. "Write your own..." is the step
 * under the list: a one-off typed right here, with an optional save into
 * the library that is OFF by default, because a prompt used once has not
 * earned a row. That step is durable (operator ruling 2026-09-29): the
 * draft rides sessionStorage until it is submitted, so a refresh mid-edit
 * loses nothing. Since the gating sweep (spec 2026-09-29) its submit is
 * DISABLED until the step's schema is satisfied — the guard in onSubmit
 * stays as the guarantee behind the explanation.
 *
 * `mode` survives as the COPY and STORAGE difference between the two
 * callers (a pick closes the dialog in both; the custom step names its
 * button for the flow it belongs to).
 */
export function PromptPickerDialog({
  open,
  onOpenChange,
  mode,
  onPick,
}: {
  open: boolean;
  onOpenChange: (next: boolean) => void;
  mode: "multi" | "single";
  onPick: (block: PromptBlock) => void;
}) {
  const { data, isLoading, isError } = usePrompts();
  const view: PromptsView = data ?? { own: [], shared: [] };
  const [tab, setTab] = useState<"own" | "shared">("own");
  // The custom step: "list" = the list, "custom" = the editor for one
  // free-text block. A stored draft means the person was mid-edit when the
  // page went away: reopen THERE, with the text, not at the list.
  const [draft] = useState(() => loadDraft(mode));
  const [step, setStep] = useState<"list" | "custom">(draft === null ? "list" : "custom");
  const [serverError, setServerError] = useState<string | null>(null);
  const create = useCreatePrompt();

  const form = makeForm({
    defaultValues: {
      body: draft?.body ?? "",
      description: draft?.description ?? "",
      saveToLibrary: draft?.saveToLibrary ?? false,
    },
    validator: customStepSchema,
    onSubmit: async ({ body, description, saveToLibrary }) => {
      // The guard behind the gate (Enter-key paths, races): the button
      // already refuses this draft, but the guarantee lives here.
      if (body.trim() === "" || (saveToLibrary && description.trim() === "")) return;
      setServerError(null);
      const trimmed = { description: description.trim(), body, shared: false };
      if (saveToLibrary) {
        try {
          await create.mutateAsync(trimmed);
        } catch (err) {
          setServerError(errMessage(err, "The prompt could not be saved"));
          return;
        }
      }
      // Submitted: the draft is spent, and the next "Write your own..." starts
      // clean (the durability covers accidents, not a second copy of a sent
      // prompt).
      try {
        sessionStorage.removeItem(draftKey(mode));
      } catch {
        // Nothing to do if even the removal fails.
      }
      onPick({
        localId: newPromptLocalId(),
        kind: "custom",
        description: trimmed.description === "" ? "Untitled" : trimmed.description,
        body,
      });
      onOpenChange(false);
    },
  });
  const customDisabled = useSubmitDisabled(form, create.isPending);
  // The draft-ruling effect writes what the person TYPES, so this component
  // subscribes to the step's values — the same re-render `customBody` state
  // produced before the substrate (spec 2026-09-29).
  const customValues = useStore(form.store, (state) => state.values);

  useEffect(() => {
    // The list step: leave the stored draft ALONE (Back to list keeps it;
    // that is the point of the ruling). On the step, an empty body (opened
    // fresh, or erased) means there is no draft, and a stale key must not
    // hijack the next open into an empty editor.
    if (step !== "custom") return;
    try {
      if (customValues.body === "") {
        sessionStorage.removeItem(draftKey(mode));
      } else {
        sessionStorage.setItem(
          draftKey(mode),
          JSON.stringify({
            body: customValues.body,
            description: customValues.description,
            saveToLibrary: customValues.saveToLibrary,
          } satisfies PickerDraft),
        );
      }
    } catch {
      // Storage full or blocked: the draft just is not durable this time.
    }
  }, [mode, step, customValues]);

  const rows = tab === "own" ? view.own : view.shared;
  const emptyText = isLoading ? (
    "Loading…"
  ) : isError ? (
    // The one sentence that is not neutral: the page's rule (a failure
    // never reads as "none yet") keeps the destructive colour too.
    <span className="text-destructive">The prompts could not be loaded.</span>
  ) : rows.length === 0 ? (
    tab === "own" ? (
      "No prompts yet"
    ) : (
      "No shared prompts yet"
    )
  ) : (
    "No prompts match the search."
  );

  function pick(row: { id: string; description: string; body: string }) {
    onPick({
      localId: newPromptLocalId(),
      kind: "saved",
      promptId: row.id,
      description: row.description,
      body: row.body,
    });
    // Close on the pick, BOTH modes (live report 2026-09-29): a pick that
    // kept the dialog open showed nothing changing, because the block stack
    // is behind the modal. One press, one decisive action; "Add prompt" is
    // one click away for the next one.
    onOpenChange(false);
  }

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-lg">
        <DialogHeader>
          <DialogTitle>{step === "custom" ? "Write your own" : "Add a prompt"}</DialogTitle>
          <DialogDescription>
            {mode === "multi" ? "Pick one; press Add prompt again for the next." : "One prompt, typed into the pane."}
          </DialogDescription>
        </DialogHeader>

        {step === "list" ? (
          <div className="space-y-3">
            <div className="flex items-center gap-2">
              <Segmented
                ariaLabel="Prompt source"
                options={[
                  { value: "own", label: "Yours" },
                  { value: "shared", label: "Shared" },
                ]}
                value={tab}
                onChange={setTab}
                fill={false}
              />
            </div>
            <div className="space-y-1">
              <Label htmlFor="prompt-picker-search" className="sr-only">
                Search prompts
              </Label>
              {/* The consumed posture, shared with "Copy settings from": the
                  pick is an action, so the input returns to its placeholder
                  and the next pick starts fresh. (The row clicks that failed
                  in the operator's browser on 2026-09-29 were the absent
                  crypto.randomUUID throwing in the pick handler, fixed at
                  its source, not the dropdown.) */}
              <SearchableSelect
                id="prompt-picker-search"
                value=""
                placeholder="Search prompts"
                emptyText={emptyText}
                options={rows.map((p) => ({
                  value: p.id,
                  label: p.description,
                  searchText: p.body,
                  reason: p.body.split("\n", 1)[0],
                }))}
                onValueChange={(id) => {
                  const row = rows.find((p) => p.id === id);
                  if (row) pick(row);
                }}
              />
            </div>
            <button
              type="button"
              className="flex w-full items-center gap-2 rounded-lg border border-dashed px-3 py-2 text-left text-label hover:bg-accent/40"
              onClick={() => {
                // The form already holds the draft (or an empty body): the
                // step just becomes visible. Resume-a-stored-draft is the
                // mount seeding above.
                setStep("custom");
              }}
            >
              <PenLine className="h-4 w-4 text-muted-foreground" />
              Write your own...
            </button>
          </div>
        ) : (
          <div className="space-y-3">
            <form.Field name="body">
              {(field) => (
                <>
                  <Textarea
                    value={field.state.value}
                    rows={6}
                    autoFocus
                    placeholder="The text to type into the pane"
                    onChange={(e) => field.handleChange(e.target.value)}
                    onBlur={field.handleBlur}
                  />
                  {field.state.meta.isTouched && fieldError(field.state.meta.errors) && (
                    <p role="alert" className="text-destructive text-detail">
                      {fieldError(field.state.meta.errors)}
                    </p>
                  )}
                </>
              )}
            </form.Field>
            <form.Field name="saveToLibrary">
              {(field) => (
                <div className="flex items-center gap-3">
                  <Switch
                    id="prompt-picker-save-switch"
                    checked={field.state.value}
                    onCheckedChange={(checked) => field.handleChange(checked === true)}
                  />
                  <Label htmlFor="prompt-picker-save-switch">Save to my prompts</Label>
                </div>
              )}
            </form.Field>
            {customValues.saveToLibrary && (
              <form.Field name="description">
                {(field) => (
                  <>
                    <Input
                      value={field.state.value}
                      maxLength={120}
                      placeholder="Short label for discoverability"
                      aria-label="Prompt description"
                      onChange={(e) => field.handleChange(e.target.value)}
                      onBlur={field.handleBlur}
                    />
                    {field.state.meta.isTouched && fieldError(field.state.meta.errors) && (
                      <p role="alert" className="text-destructive text-detail">
                        {fieldError(field.state.meta.errors)}
                      </p>
                    )}
                  </>
                )}
              </form.Field>
            )}
            {serverError && (
              <p role="alert" className="text-destructive text-detail">
                {serverError}
              </p>
            )}
          </div>
        )}

        <DialogFooter>
          {step === "custom" && (
            <Button
              variant="outline"
              onClick={() => {
                setStep("list");
                setServerError(null);
              }}
            >
              Back to list
            </Button>
          )}
          {step === "custom" ? (
            <Button onClick={() => void form.handleSubmit()} disabled={customDisabled}>
              {create.isPending ? "Saving…" : mode === "multi" ? "Add to stack" : "Use prompt"}
            </Button>
          ) : (
            <Button variant="outline" onClick={() => onOpenChange(false)}>
              Done
            </Button>
          )}
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
