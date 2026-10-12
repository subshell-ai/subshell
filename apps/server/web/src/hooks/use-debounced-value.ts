import { useEffect, useState } from "react";

/** Keep typing immediate while waiting for a pause before requesting results. */
export function useDebouncedValue(value: string, delay = 300): string {
  const [settled, setSettled] = useState(value);
  useEffect(() => {
    const timer = setTimeout(() => setSettled(value), delay);
    return () => clearTimeout(timer);
  }, [value, delay]);
  return value === "" ? "" : settled;
}
