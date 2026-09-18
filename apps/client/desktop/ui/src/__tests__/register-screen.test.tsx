/**
 * The first run's one press, and the properties that make it safe to have no
 * confirmation behind it.
 *
 * Each case is one of those: that the button cannot be pressed while it could
 * only produce a refusal (empty fields, no tmux), that the press reaches the
 * chain exactly once however it was made, that the loopback footgun is still
 * said out loud now that no dialog says it, and that the key's cost is stated
 * BEFORE the press rather than confirmed after it.
 */
import { afterEach, describe, expect, it } from "bun:test";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { RegisterScreen } from "@/components/assistant/register-screen";
import { useEnrollForm } from "@/hooks/use-enroll-form";
import type { Probe } from "@/lib/ipc";
import { makeProbe } from "./harness";

afterEach(cleanup);

const SHELL = { title: "Register This Machine", subtitle: "Run subshells here." };

/** The mint shape — `nsk_` plus 32 url-safe characters, as `SETUP_KEY_RE` reads it. */
const KEY = "nsk_0123456789abcdefghijklmnopqrstuv";

/** A name that `trim()` calls answered and `normalizeNodeName` reduces to "". */
const CONTROL_CHARACTER_NAME = String.fromCharCode(14);

/**
 * The real `useEnrollForm`, so "all three answered" is decided by the values
 * the app would actually hold rather than by a hand-written stub of them.
 */
function Host(props: {
  probe: Probe | undefined;
  onRegister?: () => void;
  /** Omitted renders NO Back, which is the prop's optionality; `app.tsx` always passes one. */
  onBack?: () => void;
  busy?: boolean;
}) {
  const form = useEnrollForm();
  return (
    <RegisterScreen
      shell={SHELL}
      probe={props.probe}
      form={form}
      onRegister={props.onRegister ?? (() => {})}
      onBack={props.onBack}
      busy={props.busy ?? false}
    />
  );
}

// "Continue", not "Register": this screen COLLECTS the three answers and
// spends nothing, so the press that acts is the start-up screen's
// (2026-09-18). The prop is still `onRegister` — it names what the walk is
// for, not what this button does.
const button = () => screen.getByRole("button", { name: "Continue" }) as HTMLButtonElement;

/** Fill the form through its own inputs, which is how `filled` is ever true. */
function fill(values: { server?: string; key?: string; name?: string } = {}) {
  fireEvent.change(screen.getByLabelText("Server URL"), {
    target: { value: values.server ?? "https://subshell.example.com" },
  });
  fireEvent.change(screen.getByLabelText("Setup key"), { target: { value: values.key ?? KEY } });
  fireEvent.change(screen.getByLabelText("Node name"), { target: { value: values.name ?? "mac mini" } });
}

describe("the Register screen", () => {
  it("refuses the press until all three fields are answered", () => {
    render(<Host probe={makeProbe()} />);
    expect(button().disabled).toBe(true);

    fireEvent.change(screen.getByLabelText("Server URL"), { target: { value: "https://subshell.example.com" } });
    expect(button().disabled).toBe(true);
    fireEvent.change(screen.getByLabelText("Setup key"), { target: { value: KEY } });
    // Two of three: the name became required with the 2026-09-17 node-setup
    // revamp, and this button is where that requirement is felt.
    expect(button().disabled).toBe(true);

    fireEvent.change(screen.getByLabelText("Node name"), { target: { value: "mac mini" } });
    expect(button().disabled).toBe(false);
  });

  /*
   * `normalizeNodeName`, not `trim()`: `String.trim()` strips whitespace and
   * nothing else, so a name that is one stray control character trims to
   * itself and looks answered — while the control plane would store "" and
   * Rust refuses it before any spawn. A button enabled for an answer that
   * cannot be sent is the defect `enroll-validation.ts` documents at its own
   * check.
   */
  it("does not count a name that normalizes away as answered", () => {
    render(<Host probe={makeProbe()} />);
    fill({ name: CONTROL_CHARACTER_NAME });
    expect(button().disabled).toBe(true);
  });

  it("stays disabled without tmux, and says which command installs it", () => {
    render(<Host probe={makeProbe({ tmux: null })} />);
    fill();
    // Everything typed, and still refused: `subshell enroll` preflights tmux
    // before its network call, so a live button could only manufacture the
    // refusal.
    expect(button().disabled).toBe(true);
    expect(screen.getByText(/tmux was not found on the login PATH/)).toBeTruthy();
    expect(screen.getByText(/brew install tmux|apt-get install tmux/)).toBeTruthy();
  });

  /*
   * The first paint, before `node_probe` has answered. The gate reads the
   * CURRENT probe and an absent one is "not read yet", never "no tmux" — the
   * same rule the enroll screen follows.
   */
  it("leaves the controls live while the probe has not landed", () => {
    render(<Host probe={undefined} />);
    fill();
    expect(button().disabled).toBe(false);
    expect(screen.queryByText(/tmux was not found/)).toBeNull();
  });

  it("runs the chain on the press, and on Enter in the form", () => {
    let presses = 0;
    const { container } = render(
      <Host
        probe={makeProbe()}
        onRegister={() => {
          presses += 1;
        }}
      />,
    );
    fill();

    fireEvent.click(button());
    expect(presses).toBe(1);

    // The button lives in the bottom bar and the fields in the region above
    // it, so `form=` is what keeps Enter and the click one code path.
    const form = container.querySelector("form");
    if (!form) throw new Error("the fields are not in a form");
    fireEvent.submit(form);
    expect(presses).toBe(2);
  });

  it("does not run the chain while an action is in flight", () => {
    let presses = 0;
    render(
      <Host
        probe={makeProbe()}
        busy
        onRegister={() => {
          presses += 1;
        }}
      />,
    );
    fill();
    expect(button().disabled).toBe(true);
    fireEvent.click(button());
    expect(presses).toBe(0);
  });

  it("warns on a loopback address, live, without blocking the press", () => {
    render(<Host probe={makeProbe()} />);
    fill({ server: "http://localhost:3080" });
    // Said once, under the field it is about — running the control plane and a
    // node on one box is exactly what the desktop pair exists for, so it is a
    // warning and never a refusal.
    expect(screen.getAllByText(/loopback address/).length).toBe(1);
    expect(button().disabled).toBe(false);

    fireEvent.change(screen.getByLabelText("Server URL"), { target: { value: "https://subshell.example.com" } });
    expect(screen.queryByText(/loopback address/)).toBeNull();
  });

  /*
   * Spec 2026-09-18 § 6.2: the press IS the consent, so what a confirmation
   * would have said has to be on the screen BEFORE it. A confirm panel
   * appearing here would also mean the key had not been spent by the press,
   * which is the whole difference from re-enrolment.
   */
  it("states what the press costs instead of confirming it afterwards", () => {
    let presses = 0;
    render(
      <Host
        probe={makeProbe()}
        // Rendered the way `app.tsx` renders it — with a Back — so the button
        // set below is the one a person actually sees. Asserting the set of a
        // configuration the app never uses is how a pin goes stale without
        // going red.
        onBack={() => {}}
        onRegister={() => {
          presses += 1;
        }}
      />,
    );
    expect(screen.getByText(/Registering spends the setup key/)).toBeTruthy();

    fill();
    fireEvent.click(button());
    expect(presses).toBe(1);
    // Nothing else on the screen but the way out, and no confirmation: the
    // press says what it costs beforehand rather than asking afterwards.
    expect(screen.getAllByRole("button").map((b) => b.textContent)).toEqual(["Back", "Continue"]);
    expect(screen.queryByText(/Confirm/)).toBeNull();
  });

  /**
   * The way OUT of the walk, which this screen had none of.
   *
   * `subtitles.ts` promises on the Choice screen that "whichever you pick, the
   * other is still available afterwards", and until Back existed that sentence
   * was false from the moment you picked: `barLeft` lived only on the progress
   * screen, so nothing here could clear the walk's step.
   */
  it("offers a way back that spends nothing", () => {
    let backs = 0;
    render(<Host probe={makeProbe()} onBack={() => (backs += 1)} />);
    fill();
    fireEvent.click(screen.getByRole("button", { name: "Back" }));
    expect(backs).toBe(1);
  });

  it("goes back without asking anything, even from an empty form", () => {
    // Leaving is not an act on this machine, so it is not gated on the fields
    // the way the primary is — a person who opened this screen by mistake must
    // not have to fill it in to leave.
    let backs = 0;
    render(<Host probe={makeProbe()} onBack={() => (backs += 1)} />);
    expect(button().disabled).toBe(true);
    const back = screen.getByRole("button", { name: "Back" }) as HTMLButtonElement;
    expect(back.disabled).toBe(false);
    fireEvent.click(back);
    expect(backs).toBe(1);
  });

  it("draws no Back where none was given", () => {
    // The prop is optional, and its absence is a real rendering rather than a
    // default: a caller that has nowhere to send a person shows no door.
    render(<Host probe={makeProbe()} />);
    expect(screen.queryByRole("button", { name: "Back" })).toBeNull();
  });

  it("cannot be left while an action is in flight", () => {
    let backs = 0;
    render(<Host probe={makeProbe()} onBack={() => (backs += 1)} busy />);
    const back = screen.getByRole("button", { name: "Back" }) as HTMLButtonElement;
    expect(back.disabled).toBe(true);
    fireEvent.click(back);
    expect(backs).toBe(0);
  });
});
