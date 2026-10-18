/** Deep-copies a JSON-compatible value. `undefined` is returned as is, since JSON cannot encode it. */
export const cloneJson = <T>(value: T): T =>
  value === undefined ? value : JSON.parse(JSON.stringify(value));

/** Compares two JSON-compatible values by their encoding, so key order matters. */
export const jsonEqual = (a: unknown, b: unknown): boolean =>
  a === b || JSON.stringify(a) === JSON.stringify(b);
