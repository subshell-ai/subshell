import { expect, it } from "bun:test";
import { Route } from "../settings_.ssh";

it("redirects the old settings page to SSH presets", () => {
  // The throw is the redirect (TanStack's `redirect` throws its descriptor).
  // Capture it into a variable: a `throw` inside the `try` would be caught by
  // the same `catch`, so a missing redirect would fail as a confusing match on
  // `undefined` instead of naming the real problem.
  let redirect: unknown = null;
  try {
    (Route.options.beforeLoad as () => void)();
  } catch (thrown) {
    redirect = thrown;
  }
  expect(redirect).not.toBeNull();
  expect((redirect as { options: unknown }).options).toMatchObject({
    to: "/presets",
    search: { type: "ssh" },
    replace: true,
  });
});
