import { ProductDemo } from "./product-demo";

export function PhoneCard() {
  return (
    <div>
      <ProductDemo
        name="mobile-workspace"
        webm={false}
        width={390}
        height={844}
        label="An agent builds a feature, then tests run in another tab of the same workspace"
      />
      <p className="mt-2.5 text-center text-[12px] text-[var(--dimmer)]">Your workspace in a mobile browser</p>
    </div>
  );
}
