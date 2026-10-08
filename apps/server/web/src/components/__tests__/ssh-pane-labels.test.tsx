import { afterEach, describe, expect, it } from "bun:test";
import { cleanup, render, screen } from "@testing-library/react";
import { SSH_VIEW_ONLY_COPY, SshPaneLabels } from "@/components/ssh-pane-labels";
import type { SubshellView } from "@/types/subshell";

afterEach(() => cleanup());

/** The fields this header row reads; the rest of the view is irrelevant here. */
function row(overrides: Partial<SubshellView> = {}): SubshellView {
  return { id: "s-1", ssh: false, access: "owner", ...overrides } as SubshellView;
}

describe("SshPaneLabels", () => {
  it("labels an owner's ssh pane with the SSH badge and says nothing more", () => {
    render(<SshPaneLabels subshell={row({ ssh: true, access: "owner" })} />);
    expect(screen.queryByText("SSH")).not.toBeNull();
    expect(screen.queryByText(SSH_VIEW_ONLY_COPY)).toBeNull();
  });

  it("labels an edit grantee's ssh pane with the badge only (the sentence is the viewer's)", () => {
    render(<SshPaneLabels subshell={row({ ssh: true, access: "edit" })} />);
    expect(screen.queryByText("SSH")).not.toBeNull();
    expect(screen.queryByText(SSH_VIEW_ONLY_COPY)).toBeNull();
  });

  it("tells a view-only ssh viewer why typing is off", () => {
    render(<SshPaneLabels subshell={row({ ssh: true, access: "view" })} />);
    expect(screen.queryByText("SSH")).not.toBeNull();
    expect(screen.queryByText("SSH sessions take input from their owner only.")).not.toBeNull();
    // One sentence pinned exactly (copy rule), and no em/en dash in it.
    expect(SSH_VIEW_ONLY_COPY).toBe("SSH sessions take input from their owner only.");
    expect(SSH_VIEW_ONLY_COPY).not.toMatch(/[–—]/);
  });

  it("stays silent for an ordinary pane at any access (no regression for view grantees)", () => {
    const view = render(<SshPaneLabels subshell={row({ ssh: false, access: "view" })} />);
    expect(view.container.textContent).toBe("");
    cleanup();
    const owner = render(<SshPaneLabels subshell={row({ ssh: false, access: "owner" })} />);
    expect(owner.container.textContent).toBe("");
  });

  it("renders nothing while the record has not arrived", () => {
    const { container } = render(<SshPaneLabels subshell={undefined} />);
    expect(container.textContent).toBe("");
  });

  it("treats an absent ssh field as not-ssh (an older cached payload)", () => {
    // A payload cached before the field existed has no `ssh` key at all;
    // the component's test is `=== true`, so it must read as not-ssh.
    const cached = { id: "s-1", access: "view" } as SubshellView;
    const { container } = render(<SshPaneLabels subshell={cached} />);
    expect(container.textContent).toBe("");
  });
});
