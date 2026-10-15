import { invoke } from "@tauri-apps/api/core";
import { useRef, useState } from "react";
import { createRoot } from "react-dom/client";
import { Button } from "./components/ui/button";
import { Input } from "./components/ui/input";
import { Label } from "./components/ui/label";
import "./styles.css";

// This entry is loaded only by the bundled unlock window. It never imports
// the control plane bridge, sends events, or stores the password in React state.
function UnlockKey() {
  const input = useRef<HTMLInputElement>(null);
  const [pending, setPending] = useState(false);
  const [error, setError] = useState("");
  async function submit(cancel: boolean) {
    if (pending) return;
    setPending(true);
    const passphrase = cancel ? null : (input.current?.value ?? "");
    if (input.current) input.current.value = "";
    try {
      await invoke("desktop_ssh_key_unlock", { passphrase });
    } catch {
      setError("This SSH key request has expired. Close this window and choose the key again.");
      setPending(false);
    }
  }
  return (
    <main className="flex flex-col gap-4 p-6">
      <h1 className="font-strong text-heading">Unlock this SSH key</h1>
      <p className="text-body text-muted-foreground">
        Your passphrase stays in this desktop app. The key can authorize one SSH login and expires after 90 seconds.
      </p>
      <form
        className="flex flex-col gap-4"
        onSubmit={(event) => {
          event.preventDefault();
          void submit(false);
        }}
      >
        <fieldset className="flex flex-col gap-2">
          <Label htmlFor="passphrase">Key passphrase</Label>
          <Input
            ref={input}
            id="passphrase"
            type="password"
            autoComplete="off"
            autoFocus
            maxLength={4096}
            aria-describedby={error ? "unlock-error" : undefined}
          />
        </fieldset>
        {error && (
          <p id="unlock-error" role="alert" className="text-body text-destructive">
            {error}
          </p>
        )}
        <div className="flex justify-end gap-2">
          <Button
            type="button"
            variant="outline"
            onClick={() => {
              void submit(true);
            }}
            disabled={pending}
            disabledReason="The key is being unlocked."
          >
            Cancel
          </Button>
          <Button type="submit" disabled={pending} disabledReason="The key is being unlocked.">
            Unlock key
          </Button>
        </div>
      </form>
    </main>
  );
}

const root = document.getElementById("root");
if (!root) throw new Error("Root element not found");
createRoot(root).render(<UnlockKey />);
