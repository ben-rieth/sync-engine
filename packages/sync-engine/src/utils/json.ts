/** Deep-copies a JSON-compatible value. */
export const cloneJson = <T>(value: T): T =>
  value === undefined ? value : JSON.parse(JSON.stringify(value));

export const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

/** Iterative, so hostile nesting can't overflow the stack. */
export const depthExceeds = (value: unknown, max: number): boolean => {
  let level: object[] = typeof value === "object" && value !== null ? [value] : [];
  for (let depth = 0; level.length > 0; depth++) {
    if (depth >= max) {
      return true;
    }
    const next: object[] = [];
    for (const node of level) {
      for (const child of Array.isArray(node) ? node : Object.values(node)) {
        if (typeof child === "object" && child !== null) {
          next.push(child);
        }
      }
    }
    level = next;
  }
  return false;
};

/** Truncated so client input can't flood an error response or log. */
export const quote = (input: string): string => JSON.stringify(input.slice(0, 64));

/** Compares JSON-compatible values by encoding, so key order matters. */
export const jsonEqual = (a: unknown, b: unknown): boolean =>
  a === b || JSON.stringify(a) === JSON.stringify(b);
