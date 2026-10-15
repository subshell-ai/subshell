import { Button, Input } from "@internal/node-admin";
import { SSH_LOCAL_KEY_MAX_BYTES, SSH_LOCAL_KEY_MAX_PASSPHRASE_BYTES } from "@internal/subshell-protocol";
import { useCallback, useEffect, useRef, useState } from "react";
import { Checkbox } from "@/components/ui/checkbox";
import { Field, FieldLabel } from "@/components/ui/field";
import { makeForm, useSubmitDisabled } from "@/lib/form";
import { isAndroid, isIOS } from "@/lib/platform";
import { type BrowserKeyMaterial, browserSigningUnavailable } from "@/lib/ssh-browser-key";

function hiddenFilesTip(): string | null {
  const ua = typeof navigator === "undefined" ? "" : navigator.userAgent;
  if (isIOS() || isAndroid(ua)) return null;
  if (/Macintosh|Mac OS X/.test(ua))
    return "Press Command + Shift + . in the file dialog to show hidden files and folders.";
  if (/Windows/.test(ua))
    return "To show hidden files and folders, enable Hidden items in File Explorer’s View menu, then reopen the file dialog.";
  if (/Linux/.test(ua))
    return "Press Ctrl + H in the file dialog to show hidden files and folders. In KDE dialogs, use Alt + . instead.";
  return null;
}

/** File contents and passphrases never enter form state, query caches, or the shared SSH draft. */
export function useBrowserKeySelection() {
  const input = useRef<HTMLInputElement>(null);
  const passphrase = useRef<HTMLInputElement>(null);
  const file = useRef<File | null>(null);
  const [name, setName] = useState("");
  const [trusted, setTrusted] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const clear = useCallback(() => {
    file.current = null;
    if (input.current) input.current.value = "";
    if (passphrase.current) passphrase.current.value = "";
    setName("");
    setTrusted(false);
    setError(null);
  }, []);
  useEffect(() => {
    // A page in the back/forward cache stays mounted, so navigation must also
    // release a selection that hasn't reached the worker yet.
    window.addEventListener("pagehide", clear);
    return () => {
      window.removeEventListener("pagehide", clear);
      file.current = null;
      if (passphrase.current) passphrase.current.value = "";
      if (input.current) input.current.value = "";
    };
  }, [clear]);
  const problem = () =>
    browserSigningUnavailable() ??
    (!trusted
      ? "Confirm that you trust this website before choosing a key."
      : !file.current
        ? "Choose an SSH private key from your machine."
        : null);
  return {
    input,
    passphrase,
    name,
    trusted,
    error,
    clear,
    problem,
    acknowledge(value: boolean) {
      if (!value) clear();
      else setTrusted(true);
    },
    choose() {
      if (!trusted || browserSigningUnavailable()) return;
      const chosen = input.current?.files?.[0];
      if (!chosen) return;
      file.current = null;
      setName("");
      if (passphrase.current) passphrase.current.value = "";
      if (input.current) input.current.value = "";
      if (!chosen.size || chosen.size > SSH_LOCAL_KEY_MAX_BYTES) {
        setError("Choose a private key no larger than 64 KiB.");
        return;
      }
      file.current = chosen;
      setName(chosen.name);
      setError(null);
    },
    take(): BrowserKeyMaterial {
      const reason = problem();
      const chosen = file.current;
      if (reason || !chosen) throw new Error(reason ?? "Choose an SSH private key.");
      const password = new TextEncoder().encode(passphrase.current?.value ?? "");
      // Keep the selection and input for retry. The worker gets a disposable
      // byte copy; success or leaving the flow clears the input separately.
      if (password.length > SSH_LOCAL_KEY_MAX_PASSPHRASE_BYTES) {
        password.fill(0);
        throw new Error("Use a key passphrase no longer than 4 KiB once encoded.");
      }
      return { file: chosen, passphrase: password };
    },
  };
}

export type BrowserKeySelection = ReturnType<typeof useBrowserKeySelection>;

export function BrowserKeyFields({ selection, busy }: { selection: BrowserKeySelection; busy: boolean }) {
  const unavailable = browserSigningUnavailable();
  const pickerTip = hiddenFilesTip();
  const form = makeForm({
    defaultValues: { trusted: selection.trusted },
    validator: ({ trusted }): Record<string, string> =>
      unavailable
        ? { trusted: unavailable }
        : !trusted
          ? { trusted: "Confirm that you trust this website before choosing a key." }
          : {},
    onSubmit: () => {},
  });
  useEffect(() => {
    form.setFieldValue("trusted", selection.trusted);
    void form.validate("change");
  }, [form, selection.trusted]);
  const disabled = useSubmitDisabled(form, busy);
  return (
    <section className="flex min-w-0 flex-col gap-3" aria-label="Key from this browser">
      <p id="ssh-browser-key-risk" className="text-detail text-warning">
        Only continue if you trust this website and its operator. Compromised page code could steal your key. Subshell
        does not upload or save your SSH key, but complete erasure from browser memory cannot be guaranteed.
      </p>
      <p className="text-detail text-muted-foreground">
        The key is used for one authentication, with a 90-second limit after you start. Subshell then releases its
        temporary copy of your key from browser memory.
      </p>
      <Field className="flex-row items-center gap-2">
        <Checkbox
          id="ssh-browser-key-trust"
          checked={selection.trusted}
          disabled={busy}
          onCheckedChange={(checked) => selection.acknowledge(checked === true)}
          aria-describedby="ssh-browser-key-risk"
        />
        <FieldLabel htmlFor="ssh-browser-key-trust">I trust this website and its operator</FieldLabel>
      </Field>
      {unavailable && (
        <p role="status" className="text-detail text-warning">
          {unavailable}
        </p>
      )}
      <input
        ref={selection.input}
        type="file"
        className="sr-only"
        tabIndex={-1}
        aria-label="SSH private key"
        disabled={disabled}
        onChange={selection.choose}
      />
      <div className="flex flex-wrap items-center gap-2">
        <Button
          type="button"
          variant="outline"
          aria-describedby={pickerTip ? "ssh-key-hidden-files-tip" : undefined}
          disabled={disabled}
          disabledReason={
            busy
              ? "SSH startup is in progress."
              : (unavailable ?? "Confirm that you trust this website before choosing a key.")
          }
          onClick={() => {
            if (!disabled && selection.trusted) selection.input.current?.click();
          }}
        >
          {selection.name ? "Choose another key…" : "Choose key…"}
        </Button>
        {selection.name && <span className="break-all text-detail">{selection.name}</span>}
      </div>
      {pickerTip && (
        <p id="ssh-key-hidden-files-tip" className="text-detail text-muted-foreground">
          {pickerTip}
        </p>
      )}
      {selection.name && (
        <Field>
          <FieldLabel htmlFor="ssh-browser-passphrase">Key passphrase (if encrypted)</FieldLabel>
          <Input
            ref={selection.passphrase}
            id="ssh-browser-passphrase"
            type="password"
            autoComplete="off"
            disabled={busy}
          />
        </Field>
      )}
      {selection.error && (
        <p role="alert" className="text-destructive text-detail">
          {selection.error}
        </p>
      )}
    </section>
  );
}
