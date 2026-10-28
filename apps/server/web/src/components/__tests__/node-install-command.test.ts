import { expect, test } from "bun:test";
import { once } from "node:events";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { installCommandFor, setupCommandFor } from "../nodes/node-key-setup";

test("the copied installer command passes its key to curl over stdin, not argv", async () => {
  const directory = await mkdtemp(join(tmpdir(), "subshell-command-"));
  const argsFile = join(directory, "curl-args");
  let requested = "";
  const server = createServer((request, response) => {
    requested = request.url ?? "";
    response.end("printf 'installed'\n");
  });
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("No fixture port");
  try {
    await writeFile(
      join(directory, "curl"),
      '#!/bin/sh\nprintf "%s\\n" "$@" > "$CAPTURE_ARGS"\nexec /usr/bin/curl "$@"\n',
      { mode: 0o700 },
    );
    const origin = `http://127.0.0.1:${address.port}`;
    const child = Bun.spawn(["/bin/bash"], {
      stdin: new TextEncoder().encode(`${installCommandFor(origin, "nsk_test_secret", origin)}\n`),
      stdout: "pipe",
      stderr: "pipe",
      env: { PATH: `${directory}:/usr/bin:/bin`, CAPTURE_ARGS: argsFile },
    });
    expect(await child.exited).toBe(0);
    expect(await Bun.readableStreamToText(child.stdout)).toBe("installed");
    expect(requested).toBe("/install.sh?setup_key=nsk_test_secret");
    expect(await readFile(argsFile, "utf8")).toBe("-fsSL\n--config\n-\n");
  } finally {
    server.close();
    await rm(directory, { recursive: true, force: true });
  }
});

test("the direct setup command preserves literal credentials without putting them in argv", async () => {
  const directory = await mkdtemp(join(tmpdir(), "subshell-command-"));
  try {
    const argsFile = join(directory, "args");
    const keyFile = join(directory, "key");
    const key = "nsk_literal'$(printf expanded)`printf expanded`";
    await writeFile(
      join(directory, "subshell"),
      '#!/bin/sh\nprintf "%s\\n" "$@" > "$CAPTURE_ARGS"\nprintf "%s" "$SUBSHELL_SETUP_KEY" > "$CAPTURE_KEY"\n',
      { mode: 0o700 },
    );
    const child = Bun.spawn(["/bin/bash"], {
      stdin: new TextEncoder().encode(`${setupCommandFor("https://server.example", key)}\n`),
      stdout: "pipe",
      stderr: "pipe",
      env: { PATH: `${directory}:/usr/bin:/bin`, CAPTURE_ARGS: argsFile, CAPTURE_KEY: keyFile },
    });
    expect(await child.exited).toBe(0);
    expect(await readFile(argsFile, "utf8")).toBe("setup\n--server\nhttps://server.example\n");
    expect(await readFile(keyFile, "utf8")).toBe(key);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});
