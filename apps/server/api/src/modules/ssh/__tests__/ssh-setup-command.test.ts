import { expect, test } from "bun:test";
import { renderSshSetupCommand } from "../ssh-setup-command.js";

test("the setup script reaches real curl over stdin and preserves the destination name", async () => {
  const secret = `nsk_${"a".repeat(32)}`;
  let received = "";
  const server = Bun.serve({
    hostname: "127.0.0.1",
    port: 0,
    fetch(request) {
      received = new URL(request.url).searchParams.get("setup_key") ?? "";
      return new Response('printf "%s" "$SUBSHELL_NODE_NAME"');
    },
  });
  try {
    const command = renderSshSetupCommand(
      `http://127.0.0.1:${server.port}/install.sh?setup_key=${secret}`,
      "host's name",
    );
    const child = Bun.spawn(["bash", "-s"], {
      stdin: new TextEncoder().encode(`${command}\n`),
      stdout: "pipe",
      stderr: "pipe",
    });
    const [stdout, stderr, code] = await Promise.all([
      new Response(child.stdout).text(),
      new Response(child.stderr).text(),
      child.exited,
    ]);
    expect(code).toBe(0);
    expect(stderr).toBe("");
    expect(stdout).toBe("host's name");
    expect(received).toBe(secret);
  } finally {
    server.stop(true);
  }
});
