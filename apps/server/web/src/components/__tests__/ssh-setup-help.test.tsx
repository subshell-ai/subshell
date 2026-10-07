import { afterEach, expect, test } from "bun:test";
import { cleanup, render, screen } from "@testing-library/react";
import { SshSetupHelp, sshLoginCommand } from "@/components/connect/ssh-setup-help";

afterEach(cleanup);

test("ready hosts get no installation instructions", () => {
  const { container } = render(<SshSetupHelp code={null} alias="dev" machine="Server" />);
  expect(container.textContent).toBe("");
});

test("unknown host recovery identifies the connecting account and requires fingerprint verification", () => {
  render(<SshSetupHelp code="host_key_unknown" alias="dev" machine="Server" account="service-user" />);
  expect(screen.getByText(/Server as service-user/)).toBeTruthy();
  expect(screen.getByText(/check that the SHA256 fingerprint matches/)).toBeTruthy();
  expect(screen.getByRole("button", { name: "Copy SSH login command" })).toBeTruthy();
  expect(screen.queryByRole("link", { name: "Download the Subshell CLI" })).toBeNull();
});

test("changed identities never get instructions to blindly accept or remove trust", () => {
  render(<SshSetupHelp code="host_key_changed" alias="dev" machine="Server" />);
  expect(screen.getByText(/Keep host-key checking enabled/)).toBeTruthy();
  expect(screen.queryByText(/before accepting it/)).toBeNull();
});

test("runtime recovery provides platform, install and noninteractive verification commands", () => {
  render(<SshSetupHelp code="runtime_missing" alias="dev" machine="Server" />);
  expect(screen.getByRole("button", { name: "Copy platform check" })).toBeTruthy();
  expect(screen.getByRole("button", { name: "Copy runtime install command" })).toBeTruthy();
  expect(screen.getByText("ssh -- 'dev' 'subshell --version; tmux -V'")).toBeTruthy();
});

test("copied SSH commands quote shell metacharacters and terminate option parsing", () => {
  expect(sshLoginCommand("-oProxyCommand=$(touch /tmp/oops)'")).toBe("ssh -- '-oProxyCommand=$(touch /tmp/oops)'\\'''");
});
