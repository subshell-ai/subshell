/**
 * Register This Machine — the first run's one press (spec 2026-09-18 §§ 5.2, 6).
 *
 * The same three answers `EnrollScreen` collects, asked once. The fields and
 * their rules are `EnrollFields` + `useEnrollForm` unchanged — a second
 * spelling of "is this a setup key" is how two screens come to disagree about
 * one.
 *
 * **The button says Continue, because this press does not register** (operator,
 * 2026-09-18). It collects the answers and asks the start-up question, and the
 * press on THAT screen is the one that installs, enrols and starts the service
 * — so that is the one labelled Register. A button that named an act happening
 * one screen later is the kind of lie this flow was rebuilt to remove.
 *
 * It is not for want of trying to register here: nothing can check a setup key
 * without CONSUMING it (a key is single-use, and `enroll` is the only operation
 * that tests one), and adding an endpoint that answers "is this key good?"
 * would be an oracle for guessing them — refused on those grounds, 2026-09-18.
 * What this press CAN do is check the answers' shape, and it does:
 * `validateEnroll` runs here, so a URL that does not parse or a truncated key
 * is refused on the screen that owns the fields rather than three screens
 * later. Everything that needs the network is reported by the checklist, which
 * offers a way back here when it fails.
 *
 * Two deliberate differences from `EnrollScreen`, both from § 6.2:
 *
 * - **No confirmation.** The press IS the consent: the person typed a
 *   single-use credential into a field labelled as one. What the confirmation
 *   existed to say — that this spends the key — is said here instead, as one
 *   line under the fields, before the press rather than after it. Re-enrolment
 *   keeps its two-phase confirm, because that one overwrites a working node's
 *   identity; this one has nothing to overwrite.
 * - **No notes column.** `ENROLL_NOTES` explains where a key comes from and what
 *   spends it; the first run reaches this screen having just been told to mint
 *   one, and three paragraphs above a form is what people scroll past.
 *
 * The tmux gate is `EnrollScreen`'s verbatim, for its reason: `subshell enroll`
 * preflights tmux BEFORE its network call precisely so an unenrollable box does
 * not burn a one-time key, so a live button here could only manufacture a
 * refusal.
 */
import { normalizeNodeName } from "@internal/subshell-protocol";
import { KeyRound } from "lucide-react";
import { Frame, type FrameShell } from "@/components/assistant/frame";
import { EnrollFields } from "@/components/enroll-fields";
import { Button } from "@/components/ui/button";
import type { EnrollForm } from "@/hooks/use-enroll-form";
import { tmuxHint } from "@/lib/copy";
import type { Probe } from "@/lib/ipc";

/**
 * Ties the bar's button to the form it submits.
 *
 * The button lives in the frame's bottom bar and the fields live in the scroll
 * region above it, so they are not nested — `form=` is what makes ENTER in a
 * field and a click on Register one code path instead of two that drift.
 */
const FORM_ID = "register-form";

/**
 * Said before the press, because there is no confirmation after it.
 *
 * One `detail` line: what it costs, and what the answer is when it is gone.
 * `ENROLL_NOTES` says the same thing at length for the screen that has room
 * for it.
 */
const KEY_IS_SPENT =
  "Registering spends the setup key. It is single-use, so anything that fails after the control plane has accepted " +
  "it needs a new key from Nodes → Add node, never a retry.";

export function RegisterScreen(props: {
  shell: FrameShell;
  probe: Probe | undefined;
  form: EnrollForm;
  /** Runs the register chain — install the node if needed, enroll, start the service. */
  onRegister: () => void;
  /**
   * Leave the walk. Absent only where there is nowhere to go — see `app.tsx`,
   * which answers Choice on a fresh machine and the status screen on one that
   * is already set up.
   */
  onBack?: () => void;
  busy: boolean;
}) {
  const { shell, probe, form, onRegister, onBack, busy } = props;
  // `probe === undefined` is "not read yet": the controls stay live then, the
  // same rule `EnrollScreen` follows, because the first probe landing is what
  // reveals whether the gate applies.
  const blocked = probe !== undefined && !probe.tmux;
  // Shown only while the gate actually applies. The sentence says enrolling is
  // DISABLED, so printing it beside a live button would be the screen
  // contradicting itself in the one state where nothing is known yet.
  const hint = blocked ? tmuxHint(probe, "enroll") : "";

  /*
   * "All three answered", by the SAME rules `validateEnroll` calls empty —
   * `trim()` for the two pasted values, and `normalizeNodeName` for the name,
   * which is what the control plane will store. That last one is the reason
   * this is not three `=== ""` checks: a field holding one stray control
   * character trims to itself and looks answered, and enrolling with a name
   * that reduces to "" is refused Rust-side after the form has already
   * promised it would work.
   *
   * Deliberately NOT full validity. A malformed key or a scheme-less URL keeps
   * the button live so the press renders `validateEnroll`'s per-field refusal —
   * which is the only way those sentences are ever seen. A disabled button
   * explains nothing.
   */
  const { server, key, name } = form.values;
  const filled = server.trim() !== "" && key.trim() !== "" && normalizeNodeName(name) !== "";

  const submit = () => {
    if (busy || blocked || !filled) return;
    onRegister();
  };

  return (
    <Frame
      {...shell}
      icon={<KeyRound />}
      barLeft={
        // A walk that cannot be left is a trap, and this screen's own Choice
        // subtitle promises the opposite ("whichever you pick, the other is
        // still available afterwards"). Ghost, because leaving is not the act
        // this screen is for.
        onBack ? (
          <Button variant="ghost" disabled={busy} onClick={onBack}>
            Back
          </Button>
        ) : undefined
      }
      barRight={
        <Button className="min-w-[120px]" type="submit" form={FORM_ID} disabled={busy || blocked || !filled}>
          Continue
        </Button>
      }
    >
      <form
        id={FORM_ID}
        className="mx-auto w-[360px]"
        onSubmit={(event) => {
          event.preventDefault();
          submit();
        }}
      >
        {/*
         * The loopback warning is `EnrollFields`' own, under the URL field and
         * live as it is typed (§ 6.3). It is not repeated out here: two
         * near-identical sentences about one address in one 560px column read
         * as a bug rather than as emphasis.
         */}
        <EnrollFields form={form} busy={busy} />
      </form>
      <div className="mt-6">
        <p className="text-muted-foreground text-detail leading-relaxed">{KEY_IS_SPENT}</p>
        {hint && <p className="mt-3 text-detail text-warning">{hint}</p>}
      </div>
    </Frame>
  );
}
