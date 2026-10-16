import { afterEach, describe, expect, it } from "bun:test";
import { act, cleanup, render, screen, waitFor } from "@testing-library/react";
import { SSH_VIEW_ONLY_COPY, SshPaneLabels } from "@/components/ssh-pane-labels";
import type { SubshellView } from "@/types/subshell";

afterEach(() => cleanup());

/** The fields this header row reads; the rest of the view is irrelevant here. */
function row(overrides: Partial<SubshellView> = {}): SubshellView {
  return { id: "s-1", ssh: false, access: "owner", ...overrides } as SubshellView;
}

describe("SshPaneLabels", () => {
  it("labels an owner's ssh pane with the SSH icon and says nothing more", () => {
    render(<SshPaneLabels subshell={row({ ssh: true, access: "owner" })} />);
    expect(screen.queryByRole("button", { name: "SSH connection" })).not.toBeNull();
    expect(screen.queryByText(SSH_VIEW_ONLY_COPY)).toBeNull();
  });

  it("labels an edit grantee's ssh pane with the icon only (the sentence is the viewer's)", () => {
    render(<SshPaneLabels subshell={row({ ssh: true, access: "edit" })} />);
    expect(screen.queryByRole("button", { name: "SSH connection" })).not.toBeNull();
    expect(screen.queryByText(SSH_VIEW_ONLY_COPY)).toBeNull();
  });

  it("tells a view-only ssh viewer why typing is off", () => {
    render(<SshPaneLabels subshell={row({ ssh: true, access: "view" })} />);
    expect(screen.queryByRole("button", { name: "SSH connection" })).not.toBeNull();
    expect(screen.queryByText("Only the owner can type in this SSH subshell.")).not.toBeNull();
    // One sentence pinned exactly (copy rule), and no em/en dash in it.
    expect(SSH_VIEW_ONLY_COPY).toBe("Only the owner can type in this SSH subshell.");
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

it("explains the SSH icon on keyboard focus", async () => {
  render(<SshPaneLabels subshell={row({ ssh: true })} />);
  await act(async () => screen.getByRole("button", { name: "SSH connection" }).focus());
  await waitFor(() => expect(screen.getByText("This subshell connects to another machine over SSH.")).toBeTruthy());
});

it("lists the destination and the declared forwards in the tooltip", async () => {
  render(
    <SshPaneLabels
      subshell={row({
        ssh: true,
        sshSummary: {
          destination: "theo@build.example:22",
          forwards: [
            { kind: "local", listenPort: 5432, bindHost: null, targetHost: "db.internal", targetPort: 5432 },
            { kind: "dynamic", listenPort: 1080, bindHost: null, targetHost: null, targetPort: null },
          ],
        },
      })}
    />,
  );
  await act(async () => screen.getByRole("button", { name: "SSH connection" }).focus());
  await waitFor(() => expect(screen.getByText("theo@build.example:22")).toBeTruthy());
  expect(screen.getByText("Local · loopback:5432 → db.internal:5432")).toBeTruthy();
  expect(screen.getByText("Dynamic · loopback:1080 → any host the tool picks")).toBeTruthy();
  // The concrete facts replace the vague sentence, they do not stack on it.
  expect(screen.queryByText(/connects to another machine/) === null).toBe(true);
});

it("says so when the connection carries no forwards", async () => {
  render(
    <SshPaneLabels subshell={row({ ssh: true, sshSummary: { destination: "deploy@host:2222", forwards: [] } })} />,
  );
  await act(async () => screen.getByRole("button", { name: "SSH connection" }).focus());
  await waitFor(() => expect(screen.getByText("deploy@host:2222")).toBeTruthy());
  expect(screen.getByText("No port forwards")).toBeTruthy();
});
