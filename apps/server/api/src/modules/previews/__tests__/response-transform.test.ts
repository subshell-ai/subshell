import { describe, expect, it } from "bun:test";
import { brotliCompressSync, gzipSync } from "node:zlib";
import { previewSrcset, previewUrl } from "../preview-url.js";
import { rewriteCss, rewriteModule, transformPreviewResponse } from "../response-transform.js";

const target = "http://127.0.0.1:3401";
const proxy = "https://plane.test/pv/secret/";
const map = (value: string) => previewUrl(value, `${target}/nested/page`, target, proxy);

describe("preview resource compatibility", () => {
  it("maps only this app and preserves external URLs, query and fragments", () => {
    expect(map("/style.css?v=1#x")).toBe(`${proxy}style.css?v=1#x`);
    expect(map("../a")).toBe(`${proxy}a`);
    expect(map(`${target}/a`)).toBe(`${proxy}a`);
    expect(map("https://cdn.test/a")).toBe("https://cdn.test/a");
    expect(map("data:image/png;base64,aa")).toBe("data:image/png;base64,aa");
    expect(map("#x")).toBe("#x");
    expect(map(`${proxy}a`)).toBe(`${proxy}a`);
    expect(map("/pv/secret/a?v=1#x")).toBe(`${proxy}a?v=1#x`);
    expect(map("/pv/secret/../../api/auth")).toBe(`${proxy}api/auth`);
    expect(map("ws://127.0.0.1:3401/hmr")).toBe("wss://plane.test/pv/secret/hmr");
    expect(map("/../../api/auth")).toBe(`${proxy}api/auth`);
    expect(map("https://foreign.test/pv/secret/a")).toBe("https://foreign.test/pv/secret/a");
    expect(previewUrl("child", `${proxy}nested/page`, target, proxy)).toBe(`${proxy}nested/child`);
  });
  it("preserves srcset data URLs and rewrites candidates", () => {
    expect(previewSrcset("data:image/png;base64,aa 1x, /large.png 2x", map)).toBe(
      `data:image/png;base64,aa 1x, ${proxy}large.png 2x`,
    );
  });
  it("parses CSS url and import syntax without touching comments or ordinary strings", () => {
    const result = rewriteCss(
      '/* url(/private) */ @import "/a.css"; p { background:url( /image.png ); content:"url(/text)";src:url(https://cdn.test/font)}',
      map,
    );
    expect(result).toContain(`@import "${proxy}a.css"`);
    expect(result).toContain(`url( "${proxy}image.png" )`);
    expect(result).toContain("/* url(/private) */");
    expect(result).toContain('content:"url(/text)"');
    expect(result).toContain("url(https://cdn.test/font)");
  });
  it("rewrites static and literal dynamic imports, retaining computed imports and unrelated strings", async () => {
    const result = await rewriteModule(
      `import x from '/x.js'; export * from '/e.js'; import('/lazy.js'); import(\`/parts/\${name}.js\`); const text="/x.js";`,
      map,
    );
    expect(result).toContain(`from "${proxy}x.js"`);
    expect(result).toContain(`from "${proxy}e.js"`);
    expect(result).toContain(`import("${proxy}lazy.js")`);
    expect(result).toContain(`import(\`/parts/\${name}.js\`)`);
    expect(result).toContain('const text="/x.js"');
  });
  it("keeps computed imports single-evaluation and maps import-map addresses", async () => {
    const module = await rewriteModule('import(getName(), {with:{type:"json"}})', map, `${target}/main.js`);
    expect(module.match(/getName\(\)/g)).toHaveLength(1);
    expect(module).toContain("__subshellPreviewMap");
    expect(module).toContain('{with:{type:"json"}}');
    const response = await transformPreviewResponse(
      new Response(
        '<head><script type="importmap">{"imports":{"react":"/react.js"},"scopes":{"/nested/":{"lib":"./lib.js"}}}</script></head>',
        { headers: { "content-type": "text/html" } },
      ),
      target,
      proxy,
      "/",
    );
    const text = await response.text();
    expect(text).toContain(`"react":"${proxy}react.js"`);
    expect(text).toContain(`"${proxy}nested/":{"lib":"${proxy}lib.js"}`);
  });
  it("rewrites HTML attributes/styles/module scripts and injects before app scripts", async () => {
    const response = await transformPreviewResponse(
      new Response(
        '<!doctype html><html><head><link href="/a.css" integrity="old"><style>p{background:url(/a.png)}</style></head><body><img src="/img.png" srcset="/img.png 1x, /big.png 2x"><form action="/submit"></form><script type="module">import "/mod.js";</script></body></html>',
        { headers: { "content-type": "text/html", etag: "old" } },
      ),
      target,
      proxy,
      "/",
    );
    const text = await response.text();
    expect(text).toContain(`<head><script>`);
    expect(text).toContain(`href="${proxy}a.css"`);
    expect(text).not.toContain('integrity="old"');
    expect(text).toContain(`action="${proxy}submit"`);
    expect(text).toContain(`import "${proxy}mod.js"`);
    expect(text).toContain(`url("${proxy}a.png")`);
    expect(response.headers.get("etag")).toBeNull();
  });
  it("aligns Turbopack's chunk registry with rewritten script URLs before its first script", async () => {
    const response = await transformPreviewResponse(
      new Response(
        '<head><script async src="/app/_next/static/chunks/runtime.js"></script><script async src="/app/_next/static/chunks/page.js"></script></head>',
        { headers: { "content-type": "text/html" } },
      ),
      target,
      proxy,
      "/app/",
    );
    const text = await response.text();
    const bootstrap = `globalThis.TURBOPACK_CHUNK_BASE_PATH="${proxy}app/_next/";`;
    expect(text.split(bootstrap)).toHaveLength(2);
    expect(text.indexOf(bootstrap)).toBeLessThan(text.indexOf(`src="${proxy}app/_next/static/chunks/runtime.js"`));
  });

  it("resolves a relative base once for static and runtime resources", async () => {
    const response = await transformPreviewResponse(
      new Response('<head><base href="assets/"></head><img src="a.png">', { headers: { "content-type": "text/html" } }),
      target,
      proxy,
      "/index.html",
    );
    const text = await response.text();
    expect(text).toContain(`href="${proxy}assets/"`);
    expect(text).toContain(`src="${proxy}assets/a.png"`);
    expect(text).not.toContain("assets/assets");
  });
  it("propagates compressed upstream errors and cancels oversized input", async () => {
    const bad = new ReadableStream<Uint8Array>({
      pull(controller) {
        controller.error(new Error("upstream died"));
      },
    });
    await expect(
      transformPreviewResponse(
        new Response(bad, { headers: { "content-type": "text/css", "content-encoding": "gzip" } }),
        target,
        proxy,
        "/bad",
      ),
    ).rejects.toThrow("upstream died");
    let cancelled = false;
    const large = new ReadableStream<Uint8Array>({
      pull(c) {
        c.enqueue(new Uint8Array(1024 * 1024));
      },
      cancel() {
        cancelled = true;
      },
    });
    await expect(
      transformPreviewResponse(
        new Response(large, { headers: { "content-type": "text/css" } }),
        target,
        proxy,
        "/large",
      ),
    ).rejects.toThrow("too large");
    expect(cancelled).toBe(true);
  });
  it("decodes gzip and brotli before rewriting and removes encoding", async () => {
    for (const [encoding, compress] of [
      ["gzip", gzipSync],
      ["br", brotliCompressSync],
    ] as const) {
      const res = await transformPreviewResponse(
        new Response(compress("p{background:url(/a)}"), {
          headers: { "content-type": "text/css", "content-encoding": encoding },
        }),
        target,
        proxy,
        "/a.css",
      );
      expect(await res.text()).toContain(proxy);
      expect(res.headers.get("content-encoding")).toBeNull();
    }
  });
  it("leaves event and binary streams untouched and bounds decompressed content", async () => {
    const sse = new Response("data: first\n\n", { headers: { "content-type": "text/event-stream" } });
    expect(await transformPreviewResponse(sse, target, proxy, "/events")).toBe(sse);
    await expect(
      transformPreviewResponse(
        new Response(gzipSync("x".repeat(16 * 1024 * 1024 + 1)), {
          headers: { "content-type": "text/css", "content-encoding": "gzip" },
        }),
        target,
        proxy,
        "/huge",
      ),
    ).rejects.toThrow("too large");
  });
});

it("preserves malformed JavaScript for the browser to diagnose", async () => {
  const source = 'import "\\u{invalid}";';
  expect(await rewriteModule(source, map)).toBe(source);
});
it("quotes injected import literals for both JavaScript and HTML", async () => {
  const source = 'import "/app.js";';
  const output = await rewriteModule(source, () => '</script><script>alert("x")</script>');
  expect(output).not.toContain("</script>");
  expect(output).toContain("\\u003c/script\\u003e");
});
it("lets a cold-start burst wait on small upstream bodies without refusing imports", async () => {
  const streams = Array.from({ length: 20 }, () => {
    let controller!: ReadableStreamDefaultController<Uint8Array>;
    const body = new ReadableStream<Uint8Array>({
      start(value) {
        controller = value;
      },
    });
    const result = transformPreviewResponse(
      new Response(body, { headers: { "content-type": "text/javascript" } }),
      target,
      proxy,
      "/app.js",
    );
    return { controller, result };
  });
  for (const { controller } of streams) {
    controller.enqueue(new TextEncoder().encode('import "/app.js";'));
    controller.close();
  }
  const responses = await Promise.all(streams.map(({ result }) => result));
  for (const response of responses) expect(await response.text()).toContain(proxy);
});

it("bounds aggregate decoded input and releases its budget after cancellation", async () => {
  const pending: Array<Promise<Response>> = [];
  const controllers: ReadableStreamDefaultController<Uint8Array>[] = [];
  for (let i = 0; i < 8; i++) {
    const body = new ReadableStream<Uint8Array>({
      start(controller) {
        controllers.push(controller);
      },
    });
    pending.push(
      transformPreviewResponse(
        new Response(body, { headers: { "content-type": "text/javascript" } }),
        target,
        proxy,
        "/app.js",
      ),
    );
  }
  // Keep each stream just below the per-resource cap; none has finished, so
  // their decoded bytes remain charged while a ninth resource arrives.
  const chunk = new Uint8Array(16 * 1024 * 1024).fill(32);
  for (const controller of controllers) controller.enqueue(chunk);
  await new Promise((resolve) => setTimeout(resolve, 0));
  const excess = transformPreviewResponse(
    new Response("x", { headers: { "content-type": "text/javascript" } }),
    target,
    proxy,
    "/app.js",
  );
  await expect(excess).rejects.toThrow("Too much app content");
  for (const controller of controllers) controller.error(new Error("cancel fixture"));
  await Promise.allSettled(pending);
  const recovered = await transformPreviewResponse(
    new Response('import "/app.js";', { headers: { "content-type": "text/javascript" } }),
    target,
    proxy,
    "/app.js",
  );
  expect(await recovered.text()).toContain(proxy);
});
