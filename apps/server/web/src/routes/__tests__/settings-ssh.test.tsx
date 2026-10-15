import { expect, it } from "bun:test";
import { Route } from "../settings_.ssh";

it("redirects the old settings page to SSH presets", () => {
  try {
    (Route.options.beforeLoad as () => void)();
    throw new Error("Expected redirect");
  } catch (redirect) {
    expect((redirect as { options: unknown }).options).toMatchObject({
      to: "/presets",
      search: { type: "ssh" },
      replace: true,
    });
  }
});
