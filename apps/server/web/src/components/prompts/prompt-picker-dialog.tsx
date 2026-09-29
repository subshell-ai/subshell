import { Button, errMessage, Input, Label, Switch } from "@internal/node-admin";
import { PenLine } from "lucide-react";
import { useMemo, useState } from "react";
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
import type { PromptBlock } from "@/lib/prompt-stack";
import { matchesPromptQuery, type PromptsView } from "@/lib/prompts";

/**
 * The shared prompt picker (spec 2026-09-28): the launch form's block stack
 * and the subshell menu's inject action both open THIS dialog, so "choose a
 * prompt" looks and behaves the same in both. Search matches description or
 * body; the own/shared tabs are the same question the page answers.
 * "Write your own..." is the pinned first row: a one-off typed right here,
 * with an optional save into the library that is OFF by default, because a
 * prompt used once has not earned a row.
 *
 * `mode` is the whole difference between the two callers: "multi" (launch)
 * adds and stays open, "single" (inject) hands one block back and closes.
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
  const { data } = usePrompts();
  const view: PromptsView = data ?? { own: [], shared: [] };
  const [tab, setTab] = useState<"own" | "shared">("own");
  const [query, setQuery] = useState("");
  // The custom step: null = the list, set = the editor for one free-text block.
  const [customBody, setCustomBody] = useState<string | null>(null);
  const [customDescription, setCustomDescription] = useState("");
  const [saveToLibrary, setSaveToLibrary] = useState(false);
  const [customError, setCustomError] = useState<string | null>(null);
  const create = useCreatePrompt();

  const rows = useMemo(() => {
    const source = tab === "own" ? view.own : view.shared;
    return source.filter((p) => matchesPromptQuery(p, query));
  }, [view, tab, query]);

  function pick(row: { id: string; description: string; body: string }) {
    onPick({
      localId: crypto.randomUUID(),
      kind: "saved",
      promptId: row.id,
      description: row.description,
      body: row.body,
    });
    if (mode === "single") onOpenChange(false);
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
    onPick({
      localId: crypto.randomUUID(),
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
            {mode === "multi" ? "Pick one or more; you can reorder them next." : "One prompt, typed into the pane."}
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
            <Input
              value={query}
              onChange={(e) => setQuery(e.target.value)}
              placeholder="Search prompts"
              aria-label="Search prompts"
            />
            <button
              type="button"
              className="flex w-full items-center gap-2 rounded-lg border border-dashed px-3 py-2 text-left text-label hover:bg-accent/40"
              onClick={() => {
                setCustomBody("");
                setCustomError(null);
              }}
            >
              <PenLine className="h-4 w-4 text-muted-foreground" />
              Write your own...
            </button>
            <div className="max-h-64 space-y-1 overflow-y-auto">
              {rows.length === 0 && <p className="px-1 text-detail text-muted-foreground">Nothing matches.</p>}
              {rows.map((p) => (
                <button
                  type="button"
                  key={p.id}
                  className="flex w-full flex-col gap-0.5 rounded-lg px-3 py-2 text-left hover:bg-accent/60"
                  onClick={() => pick(p)}
                >
                  <span className="truncate font-strong text-label">{p.description}</span>
                  <span className="truncate text-detail text-muted-foreground">{p.body.split("\n", 1)[0]}</span>
                </button>
              ))}
            </div>
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
                checked={saveToLibrary}
                onCheckedChange={(checked) => setSaveToLibrary(checked === true)}
                aria-label="Save to my prompts"
              />
              <Label>Save to my prompts</Label>
            </div>
            {saveToLibrary && (
              <Input
                value={customDescription}
                maxLength={120}
                placeholder="Short description"
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
