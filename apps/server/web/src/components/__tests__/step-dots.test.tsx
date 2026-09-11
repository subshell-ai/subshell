import { afterEach, describe, expect, it } from "bun:test";
import { cleanup, render, screen } from "@testing-library/react";
import { StepDots } from "@/components/setup/step-dots";

afterEach(cleanup);

describe("StepDots", () => {
  it("draws total dots, marks the current, and names the step for screen readers", () => {
    render(<StepDots total={6} done={3} current={3} />);
    const dots = document.querySelectorAll("[data-dot]");
    expect(dots).toHaveLength(6);
    expect(dots[3]?.getAttribute("data-dot")).toBe("current");
    expect(dots[0]?.getAttribute("data-dot")).toBe("done");
    expect(dots[5]?.getAttribute("data-dot")).toBe("upcoming");
    expect(screen.getByText("Step 4 of 6")).toBeTruthy();
  });
  it("is not navigation", () => {
    render(<StepDots total={3} done={0} current={0} />);
    expect(document.querySelectorAll("button, a")).toHaveLength(0);
  });
});
