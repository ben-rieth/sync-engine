/** Deep-copies a JSON-compatible value. */
export const cloneJson = <T>(value: T): T =>
  value === undefined ? value : JSON.parse(JSON.stringify(value));

/** Compares JSON-compatible values by encoding, so key order matters. */
export const jsonEqual = (a: unknown, b: unknown): boolean =>
  a === b || JSON.stringify(a) === JSON.stringify(b);
