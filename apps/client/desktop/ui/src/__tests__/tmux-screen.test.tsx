/**
 * The tmux gate.
 *
 * Every case here is the difference between a gate and a caption: that the
 * screen offers the install, that it names the command a person can run
 * themselves (the install may need a password this app cannot answer), and
 * above all that there is NO way past it — tmux is required to register, and a
 * Continue here would only produce an enroll refusal or a node that 409s every
 * launch.
 */
import { afterEach, describe, expect, it } from "bun:test";
import { cleanup, fireEvent, screen } from "@testing-library/react";
import { TmuxScreen } from "@/components/assistant/tmux-screen";
import { TMUX_INSTALL_CMD } from "@/lib/copy";
import { makeProbe, renderApp } from "./harness";

const shell = { title: "Install tmux" };

/** A machine with no tmux — the only state this screen is ever shown in. */
const noTmux = makeProbe({ tmux: null });

afterEach(cleanup);

describe("the tmux screen", () => {
  it("installs on the one press it offers", () => {
    const pressed: string[] = [];
    renderApp(<TmuxScreen shell={shell} probe={noTmux} onInstall={() => pressed.push("install")} busy={false} />);
    fireEvent.click(screen.getByRole("button", { name: "Install tmux" }));
    expect(pressed).toEqual(["install"]);
  });

  // The whole point of the screen: it leaves by itself when the probe next
  // sees a tmux. A skip would let a person reach Register on a machine that
  // cannot enroll — and `subshell enroll` would refuse, or spend the key.
  it("offers no way past it — no continue, no skip", () => {
    renderApp(<TmuxScreen shell={shell} probe={noTmux} onInstall={() => {}} busy={false} />);
    expect(screen.getAllByRole("button").map((b) => b.textContent)).toEqual(["Install tmux"]);
    expect(screen.queryByRole("button", { name: /continue|skip|later|not now/i })).toBeNull();
  });

  // Shown ALWAYS, not as a fallback after a failure: on Linux the package
  // manager wants a password and this app has no terminal to answer it.
  it("names this platform's install command and the password it may ask for", () => {
    renderApp(<TmuxScreen shell={shell} probe={noTmux} onInstall={() => {}} busy={false} />);
    expect(screen.getByText(TMUX_INSTALL_CMD)).toBeTruthy();
    expect(screen.getByText("Your package manager may ask for your password.")).toBeTruthy();
  });

  // A person who went off to a terminal comes back and reads the top of the
  // pane first; a window that says nothing about watching looks frozen.
  it("says what it did not find, and that it is still watching", () => {
    renderApp(<TmuxScreen shell={shell} probe={noTmux} onInstall={() => {}} busy={false} />);
    expect(screen.getByRole("status").textContent).toContain("was not found on the login PATH");
    expect(screen.getByRole("status").textContent).toContain("continues on its own");
  });

  it("says it is checking while the probe has not answered yet", () => {
    renderApp(<TmuxScreen shell={shell} probe={undefined} onInstall={() => {}} busy={false} />);
    expect(screen.getByRole("status").textContent).toBe("Checking for tmux…");
  });

  it("refuses a second press while one install is running, and says it is running", () => {
    const pressed: string[] = [];
    renderApp(<TmuxScreen shell={shell} probe={noTmux} onInstall={() => pressed.push("install")} busy />);
    const button = screen.getByRole("button", { name: "Install tmux" }) as HTMLButtonElement;
    expect(button.disabled).toBe(true);
    fireEvent.click(button);
    expect(pressed).toEqual([]);
    expect(screen.getByRole("status").textContent).toBe("Installing tmux…");
  });
});
