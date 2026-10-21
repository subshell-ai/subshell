import { afterEach, expect, it } from "bun:test";
import { cleanup, render, screen } from "@testing-library/react";
import { FormSectionTitle } from "../form-section-title";

afterEach(cleanup);

it("preserves the accessible fieldset name and keeps the decorative rule out of it", () => {
  render(
    <fieldset>
      <FormSectionTitle as="legend" id="authentication">
        Authentication
      </FormSectionTitle>
      <input aria-label="Username" />
    </fieldset>,
  );
  const group = screen.getByRole("group", { name: "Authentication" });
  expect(group.querySelector("legend")?.id).toBe("authentication");
  expect(group.querySelector('[aria-hidden="true"]')).not.toBeNull();
});

it("supports heading levels without replacing field labels", () => {
  render(<FormSectionTitle as="h2">Launch defaults</FormSectionTitle>);
  expect(screen.getByRole("heading", { level: 2, name: "Launch defaults" })).toBeDefined();
});
