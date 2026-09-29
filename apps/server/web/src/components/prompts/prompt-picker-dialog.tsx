import { Button, errMessage, Input, Label, Switch } from "@internal/node-admin";
import { PenLine } from "lucide-react";
import { useEffect, useState } from "react";
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
 * loses nothing.
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
  // The custom step: null = the list, set = the editor for one free-text
  // block. A stored draft means the person was mid-edit when the page went
  // away: reopen THERE, with the text, not at the list.
  const [draft] = useState(() => loadDraft(mode));
  const [customBody, setCustomBody] = useState<string | null>(draft?.body ?? null);
  const [customDescription, setCustomDescription] = useState(draft?.description ?? "");
  const [saveToLibrary, setSaveToLibrary] = useState(draft?.saveToLibrary ?? false);
  const [customError, setCustomError] = useState<string | null>(null);
  const create = useCreatePrompt();

  useEffect(() => {
    // null = the list step: leave the stored draft ALONE (Back to list
    // keeps it; that is the point of the ruling). "" = the person opened
    // the step and erased it (or never typed): there is no draft, and a
    // stale key must not hijack the next open into an empty editor.
    if (customBody === null) return;
    try {
      if (customBody === "") {
        sessionStorage.removeItem(draftKey(mode));
      } else {
        sessionStorage.setItem(
          draftKey(mode),
          JSON.stringify({ body: customBody, description: customDescription, saveToLibrary } satisfies PickerDraft),
        );
      }
    } catch {
      // Storage full or blocked: the draft just is not durable this time.
    }
  }, [mode, customBody, customDescription, saveToLibrary]);

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

  async function submitCustom() {
    const body = customBody ?? "";
    if (body.trim() === "") {
      setCustomError("The prompt text is required");
      return;
    }
    const description = customDescription.trim();
    if (saveToLibrary && description === "") {
      setCustomError("A saved prompt needs a short description");
      return;
    }
    setCustomError(null);
    if (saveToLibrary) {
      try {
        await create.mutateAsync({ description, body, shared: false });
      } catch (err) {
        setCustomError(errMessage(err, "The prompt could not be saved"));
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
      description: description === "" ? "Untitled" : description,
      body,
    });
    onOpenChange(false);
  }

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-lg">
        <DialogHeader>
          <DialogTitle>{customBody === null ? "Add a prompt" : "Write your own"}</DialogTitle>
          <DialogDescription>
            {mode === "multi" ? "Pick one; press Add prompt again for the next." : "One prompt, typed into the pane."}
          </DialogDescription>
        </DialogHeader>

        {customBody === null ? (
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
                // Resume a stored draft if one exists (the ruling is
                // "until submission"): a list->step->list->step walk must
                // not discard half-typed text.
                setCustomBody(loadDraft(mode)?.body ?? "");
                setCustomError(null);
              }}
            >
              <PenLine className="h-4 w-4 text-muted-foreground" />
              Write your own...
            </button>
          </div>
        ) : (
          <div className="space-y-3">
            <Textarea
              value={customBody}
              rows={6}
              autoFocus
              placeholder="The text to type into the pane"
              onChange={(e) => setCustomBody(e.target.value)}
            />
            <div className="flex items-center gap-3">
              <Switch
                id="prompt-picker-save-switch"
                checked={saveToLibrary}
                onCheckedChange={(checked) => setSaveToLibrary(checked === true)}
              />
              <Label htmlFor="prompt-picker-save-switch">Save to my prompts</Label>
            </div>
            {saveToLibrary && (
              <Input
                value={customDescription}
                maxLength={120}
                placeholder="Short label for discoverability"
                aria-label="Prompt description"
                onChange={(e) => setCustomDescription(e.target.value)}
              />
            )}
            {customError && (
              <p role="alert" className="text-destructive text-detail">
                {customError}
              </p>
            )}
          </div>
        )}

        <DialogFooter>
          {customBody !== null && (
            <Button
              variant="outline"
              onClick={() => {
                setCustomBody(null);
                setCustomError(null);
              }}
            >
              Back to list
            </Button>
          )}
          {customBody !== null ? (
            <Button onClick={() => void submitCustom()} disabled={create.isPending}>
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
