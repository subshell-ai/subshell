/**
 * The tmux gate, and the install pane behind it.
 *
 * Every case here is the difference between a gate and a caption: that the
 * screen offers the install where an install is possible, that it shows the
 * package manager's own words while one runs, that it names the command a
 * person can run themselves, and above all that there is NO way past it — tmux
 * is required to register, and a Continue here would only produce an enroll
 * refusal or a node that 409s every launch.
 *
 * The brew-less Mac is where "offers the install" and "offers no way past it"
 * meet: there is nothing this app may run, so the button would be a second
 * thing on screen that cannot work, beside an instruction naming the very
 * program that is missing. Both halves are pinned below, as is the pane's
 * mirror of `apps/server/desktop`'s — progress while it runs, two routes with
 * their own instructions when it cannot run at all.
 *
 * The platform comes from the user agent (`isMacos`), which these tests set
 * per case — a const frozen at import can only ever be exercised on the
 * platform the test process happens to be, which is the platform that was
 * never the problem. Note that `TMUX_INSTALL_CMD` IS such a const, so the line
 * the install branch prints stays this host's throughout; the branch under
 * test is which block renders, not which command it names.
 */
import { afterEach, describe, expect, it } from "bun:test";
import { act, cleanup, fireEvent, screen, waitFor } from "@testing-library/react";
import { elapsed, TmuxScreen } from "@/components/assistant/tmux-screen";
import { manualTmuxRoutes, TMUX_INSTALL_CMD } from "@/lib/copy";
import { INSTALL_LINE_EVENT } from "@/lib/ipc";
import { type FakeIpc, installFakeIpc, makeProbe, renderApp } from "./harness";

// Unmount after each test. Testing Library appends every `render` to
// `document.body`, and there is ONE document per bun test process — so a file
// that renders without unmounting leaves its DOM for whatever file bun shards
// into that process next, and a test asking a GLOBAL question
// (`getAllByRole("button")`) reads the leftovers as its own. That is exactly
// how the Welcome screen's "Continue is the only control" case passed on a Mac
// and failed on CI, counting four About-screen buttons as its own (2026-09-18).
afterEach(cleanup);

const shell = { title: "Install tmux" };

/** A machine with no tmux — the only state this screen is ever shown in. */
const noTmux = makeProbe({ tmux: null });
/** The dead end: no tmux, and no package manager this app may drive. */
const brewless = makeProbe({ tmux: null, hasBrew: false });

const REAL_UA = navigator.userAgent;
const MAC_UA = "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 SubshellClient/1.0";
const LINUX_UA = "Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 SubshellClient/1.0";

/** What `navigator.userAgent` says for the rest of this test. */
function on(ua: string): void {
  Object.defineProperty(navigator, "userAgent", { value: ua, configurable: true });
}

/** One frame as Tauri's event plugin delivers it. */
interface EventFrame {
  event: string;
  id: number;
  payload: string;
}

let fake: FakeIpc | null = null;
/** Push one line as `node_install_tmux`'s sink would, or null before a render. */
let deliver: ((line: string) => void) | null = null;

/**
 * The harness's fake, plus a way to DELIVER an event.
 *
 * `listen()` hands its callback to `transformCallback` and then invokes the
 * event plugin; the harness answers both so the page's effect does not throw,
 * but nothing there can push a frame back. Capturing the callback is the whole
 * addition, and it is local to this file because the streamed install line is
 * this screen's alone.
 */
function fakeIpc(handlers: Record<string, (args: Record<string, unknown>) => unknown> = {}): FakeIpc {
  const installed = installFakeIpc({ handlers });
  const internals = (window as unknown as { __TAURI_INTERNALS__: Record<string, unknown> }).__TAURI_INTERNALS__;
  let callback: ((frame: EventFrame) => void) | null = null;
  internals.transformCallback = (cb: (frame: EventFrame) => void): number => {
    callback = cb;
    return 1;
  };
  deliver = (line) => {
    const handler = callback;
    expect(handler, "the page registered an event listener").not.toBeNull();
    act(() => handler?.({ event: INSTALL_LINE_EVENT, id: 1, payload: line }));
  };
  fake = installed;
  return installed;
}

/** Every button on screen, by the name a screen reader would announce. */
const buttonNames = (): (string | null)[] =>
  screen.getAllByRole("button").map((b) => b.getAttribute("aria-label") ?? b.textContent);

afterEach(() => {
  on(REAL_UA);
  cleanup();
  fake?.restore();
  fake = null;
  deliver = null;
});

describe("the tmux screen", () => {
  it("installs on the one press it offers", () => {
    fakeIpc();
    const pressed: string[] = [];
    renderApp(<TmuxScreen shell={shell} probe={noTmux} onInstall={() => pressed.push("install")} busy={false} />);
    fireEvent.click(screen.getByRole("button", { name: "Install tmux" }));
    expect(pressed).toEqual(["install"]);
  });

  // The whole point of the screen: it leaves by itself when the probe next
  // sees a tmux. A press that reached Register without one would produce an
  // enroll refusal — or spend the setup key — which is why the assertion is
  // about MEANING rather than about a count.
  //
  // Back is not such a press: it leaves the walk, and the machine is exactly
  // as it was. The inventory is named beside the regex so a button nobody
  // meant to add still fails something.
  it("offers no way past it — no continue, no skip", () => {
    fakeIpc();
    renderApp(<TmuxScreen shell={shell} probe={noTmux} onInstall={() => {}} onBack={() => {}} busy={false} />);
    expect(screen.queryByRole("button", { name: /continue|skip|later|not now/i })).toBeNull();
    expect(buttonNames()).toEqual(["Install tmux", "Copy the install command", "Back"]);
  });

  // The way OUT of the walk, which is not a way through the gate: tmux is
  // still required to register, and this answers a different question — "not
  // this machine, not now". Until it existed the only exits from a machine
  // with no package manager this app can drive were a terminal and quitting.
  it("leaves the walk on Back, having touched nothing", () => {
    const ipc = fakeIpc();
    const backs: number[] = [];
    renderApp(
      <TmuxScreen shell={shell} probe={noTmux} onInstall={() => {}} onBack={() => backs.push(1)} busy={false} />,
    );
    fireEvent.click(screen.getByRole("button", { name: "Back" }));
    expect(backs).toEqual([1]);
    // Navigation, not an act: nothing was asked of the MACHINE. The page's own
    // event subscription is in `calls` and is not one — it is the listener the
    // install pane needs, registered on mount.
    expect(ipc.calls.filter((call) => call.cmd.startsWith("node_"))).toEqual([]);
  });

  // The host decides whether there IS a way back — Choice on a fresh machine,
  // the status screen for a configured client that came here from "Register
  // this machine" — so a screen given none draws none rather than a dead one.
  it("draws no Back where the host offers no way back", () => {
    fakeIpc();
    renderApp(<TmuxScreen shell={shell} probe={noTmux} onInstall={() => {}} busy={false} />);
    expect(screen.queryByRole("button", { name: "Back" })).toBeNull();
  });

  // Shown ALWAYS, not as a fallback after a failure: a package manager may
  // want a password, and the one line a person can paste belongs on screen
  // before the press rather than after a refusal.
  it("names this platform's install command and the password it may ask for", () => {
    fakeIpc();
    renderApp(<TmuxScreen shell={shell} probe={noTmux} onInstall={() => {}} busy={false} />);
    expect(screen.getByText(TMUX_INSTALL_CMD)).toBeTruthy();
    expect(screen.getByText("Your package manager may ask for your password.")).toBeTruthy();
  });

  // A person who went off to a terminal comes back and reads the top of the
  // pane first; a window that says nothing about watching looks frozen.
  it("says what it did not find, and that it is still watching", () => {
    fakeIpc();
    renderApp(<TmuxScreen shell={shell} probe={noTmux} onInstall={() => {}} busy={false} />);
    expect(screen.getByRole("status").textContent).toContain("was not found on the login PATH");
    expect(screen.getByRole("status").textContent).toContain("continues on its own");
  });

  it("says it is checking while the probe has not answered yet", () => {
    fakeIpc();
    renderApp(<TmuxScreen shell={shell} probe={undefined} onInstall={() => {}} busy={false} />);
    expect(screen.getByRole("status").textContent).toBe("Checking for tmux…");
  });

  // An unread probe must not flicker into the shape reserved for the one
  // machine that cannot be helped — so the button is there before the first
  // answer, on every platform.
  it("offers the install while the probe has not answered, even on a Mac", () => {
    on(MAC_UA);
    fakeIpc();
    renderApp(<TmuxScreen shell={shell} probe={undefined} onInstall={() => {}} busy={false} />);
    expect(screen.getByRole("button", { name: "Install tmux" })).toBeTruthy();
  });

  // Linux is not brew's business: `pkexec apt-get` is runnable on every
  // machine this app ships a `.deb` to, and pkexec raises the desktop's own
  // password prompt. A brew check leaking into this branch would take the
  // button away from every Linux node.
  it("still offers the install on Linux, where brew is beside the point", () => {
    on(LINUX_UA);
    fakeIpc();
    renderApp(<TmuxScreen shell={shell} probe={brewless} onInstall={() => {}} busy={false} />);
    expect(screen.getByRole("button", { name: "Install tmux" })).toBeTruthy();
    expect(screen.queryByText("sudo port install tmux")).toBeNull();
  });

  it("still offers the install on a Mac that has Homebrew", () => {
    on(MAC_UA);
    fakeIpc();
    renderApp(<TmuxScreen shell={shell} probe={noTmux} onInstall={() => {}} busy={false} />);
    expect(screen.getByRole("button", { name: "Install tmux" })).toBeTruthy();
    expect(screen.queryByText("sudo port install tmux")).toBeNull();
  });
});

describe("the install, while it runs", () => {
  // A button during a run is either a lie or a second way to start what is
  // already started. The pane replaces it, exactly as the sibling app's does —
  // and the copy button stays, because being unable to copy the fix while an
  // install is in flight would be the worst possible timing.
  it("replaces the button with the pane, leaving nothing to press twice", () => {
    fakeIpc();
    renderApp(<TmuxScreen shell={shell} probe={noTmux} onInstall={() => {}} busy />);
    expect(screen.queryByRole("button", { name: "Install tmux" })).toBeNull();
    expect(buttonNames()).toEqual(["Copy the install command"]);
  });

  // Back stays live while `brew` runs, unlike every other bottom-bar control
  // in this app: a cold install takes minutes under a ten-minute deadline, and
  // a screen whose complaint is "there is no way out of this wait" cannot take
  // its way out away for the length of the wait. Leaving changes nothing — the
  // install is Rust's and finishes either way.
  it("can still be left while an install runs", () => {
    fakeIpc();
    const backs: number[] = [];
    renderApp(<TmuxScreen shell={shell} probe={noTmux} onInstall={() => {}} onBack={() => backs.push(1)} busy />);
    const back = screen.getByRole("button", { name: "Back" }) as HTMLButtonElement;
    expect(back.disabled).toBe(false);
    fireEvent.click(back);
    expect(backs).toEqual([1]);
  });

  // The clock and the line are two moving things for one reason each: the line
  // is the only real progress (brew reports Fetching, then Pouring, with no
  // percentage to derive), and the clock is what a stalled download leaves
  // moving when the line stops changing.
  it("says what it is doing, with a clock, before the manager has said anything", () => {
    fakeIpc();
    renderApp(<TmuxScreen shell={shell} probe={noTmux} onInstall={() => {}} busy />);
    expect(screen.getByRole("status").textContent).toContain("Installing tmux…");
    expect(screen.getByRole("status").textContent).toContain("0:00");
    expect(screen.getByText("Starting the package manager…")).toBeTruthy();
  });

  it("shows the package manager's own last line, verbatim", async () => {
    fakeIpc();
    renderApp(<TmuxScreen shell={shell} probe={noTmux} onInstall={() => {}} busy />);
    deliver?.("==> Fetching tmux");
    await waitFor(() => expect(screen.getByText("==> Fetching tmux")).toBeTruthy());
    deliver?.("==> Pouring tmux--3.5a.arm64_sequoia.bottle.tar.gz");
    await waitFor(() => expect(screen.getByText("==> Pouring tmux--3.5a.arm64_sequoia.bottle.tar.gz")).toBeTruthy());
    // The previous line is replaced, not appended: this is a progress line,
    // not a transcript — the whole of stdout comes back on the action's own
    // result.
    expect(screen.queryByText("==> Fetching tmux")).toBeNull();
  });

  // A manager drawing progress emits blank lines; blanking the one thing on
  // screen that is moving is how a working install starts looking hung.
  it("ignores empty frames rather than blanking the line", async () => {
    fakeIpc();
    renderApp(<TmuxScreen shell={shell} probe={noTmux} onInstall={() => {}} busy />);
    deliver?.("==> Fetching tmux");
    await waitFor(() => expect(screen.getByText("==> Fetching tmux")).toBeTruthy());
    deliver?.("   ");
    expect(screen.getByText("==> Fetching tmux")).toBeTruthy();
  });

  it("counts in m:ss from the moment the install began", () => {
    expect(elapsed(0, 0)).toBe("0:00");
    expect(elapsed(1_000, 9_400)).toBe("0:08");
    expect(elapsed(0, 61_000)).toBe("1:01");
    expect(elapsed(0, 600_000)).toBe("10:00");
    // A clock that ran backwards (the machine's own time moved) reads zero
    // rather than a negative.
    expect(elapsed(5_000, 0)).toBe("0:00");
  });
});

describe("the tmux screen on a Mac with no Homebrew", () => {
  // The dead end this branch exists to close: the button could only ever
  // produce `NO_MANAGER`, and pressing a thing that always fails is what
  // teaches people to click through warnings. Two meanings in one assertion —
  // nothing that can only refuse, and nothing that advances — and the
  // inventory beside it, which is the two managers and the way out.
  it("offers nothing that can only refuse, and still no way past the gate", () => {
    on(MAC_UA);
    fakeIpc();
    renderApp(<TmuxScreen shell={shell} probe={brewless} onInstall={() => {}} onBack={() => {}} busy={false} />);
    expect(screen.queryByRole("button", { name: /install tmux|continue|skip|later|not now/i })).toBeNull();
    expect(buttonNames()).toEqual(["Homebrew", "MacPorts", "Back"]);
  });

  it("names both routes, the likelier one first", () => {
    on(MAC_UA);
    fakeIpc();
    renderApp(<TmuxScreen shell={shell} probe={brewless} onInstall={() => {}} busy={false} />);
    expect(buttonNames()).toEqual(["Homebrew", "MacPorts"]);
    expect(screen.getByText("Installing tmux through Homebrew or MacPorts is recommended.")).toBeTruthy();
  });

  // Nothing is shown until asked for: printing both shell lines up front asks
  // someone to paste an unexplained command on a window's say-so.
  it("shows no command until a manager is chosen", () => {
    on(MAC_UA);
    fakeIpc();
    renderApp(<TmuxScreen shell={shell} probe={brewless} onInstall={() => {}} busy={false} />);
    expect(screen.queryByText("brew install tmux")).toBeNull();
    expect(screen.queryByText("sudo port install tmux")).toBeNull();
  });

  it("reveals one manager's steps when its button is pressed, and says which is open", () => {
    on(MAC_UA);
    fakeIpc();
    renderApp(<TmuxScreen shell={shell} probe={brewless} onInstall={() => {}} busy={false} />);
    fireEvent.click(screen.getByRole("button", { name: "Homebrew" }));
    expect(screen.getByRole("button", { name: "Homebrew" }).getAttribute("aria-pressed")).toBe("true");
    expect(screen.getByRole("button", { name: "MacPorts" }).getAttribute("aria-pressed")).toBe("false");
    // Both steps, in the order they happen — where to get it, then the line.
    expect(screen.getByText("Don't have Homebrew? Install it from its site, then come back.")).toBeTruthy();
    expect(screen.getByText("Once you have Homebrew, run:")).toBeTruthy();
    expect(screen.getByText("brew install tmux")).toBeTruthy();
    // And only that one's.
    expect(screen.queryByText("sudo port install tmux")).toBeNull();
  });

  it("swaps to the other manager's steps, and closes on a second press", () => {
    on(MAC_UA);
    fakeIpc();
    renderApp(<TmuxScreen shell={shell} probe={brewless} onInstall={() => {}} busy={false} />);
    fireEvent.click(screen.getByRole("button", { name: "Homebrew" }));
    fireEvent.click(screen.getByRole("button", { name: "MacPorts" }));
    expect(screen.getByText("sudo port install tmux")).toBeTruthy();
    expect(screen.queryByText("brew install tmux")).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: "MacPorts" }));
    expect(screen.queryByText("sudo port install tmux")).toBeNull();
  });

  // A MEMBER of the closed URL set, never an address: Rust owns every page
  // this app can open. The line that installs the MANAGER is never printed —
  // that is the `curl … | bash` nobody should take from a window's say-so.
  it("opens a manager's site by naming it, never by handing over a URL", async () => {
    on(MAC_UA);
    const ipc = fakeIpc({ node_open_web: () => null });
    renderApp(<TmuxScreen shell={shell} probe={brewless} onInstall={() => {}} busy={false} />);
    fireEvent.click(screen.getByRole("button", { name: "MacPorts" }));
    fireEvent.click(screen.getByRole("button", { name: "Open MacPorts site" }));
    await waitFor(() => expect(ipc.callsTo("node_open_web")).toEqual([{ target: "macports" }]));
    expect(screen.queryByText(/https?:/)).toBeNull();
  });

  it("keeps saying it is watching — this is the screen someone walks away from", () => {
    on(MAC_UA);
    fakeIpc();
    renderApp(<TmuxScreen shell={shell} probe={brewless} onInstall={() => {}} busy={false} />);
    expect(screen.getByRole("status").textContent).toContain("continues on its own");
  });
});

describe("manualTmuxRoutes", () => {
  it("has nothing to say on Linux, brew or no brew", () => {
    on(LINUX_UA);
    expect(manualTmuxRoutes(false)).toEqual([]);
    expect(manualTmuxRoutes(true)).toEqual([]);
  });

  it("has nothing to say on a Mac that has Homebrew", () => {
    on(MAC_UA);
    expect(manualTmuxRoutes(true)).toEqual([]);
  });

  it("answers Homebrew then MacPorts on a Mac without it", () => {
    on(MAC_UA);
    expect(manualTmuxRoutes(false).map((r) => r.name)).toEqual(["Homebrew", "MacPorts"]);
    // Members of the closed URL set, not addresses.
    expect(manualTmuxRoutes(false).map((r) => r.target)).toEqual(["homebrew", "macports"]);
  });
});
