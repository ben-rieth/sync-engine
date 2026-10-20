import { describe, expect, it } from "vitest";
import { depthExceeds, isRecord, quote } from "#utils/json";

const nest = (depth: number): unknown => {
  let value: unknown = "leaf";
  for (let i = 0; i < depth; i++) {
    value = { child: value };
  }
  return value;
};

describe("isRecord", () => {
  it("accepts a plain object", () => {
    const result = isRecord({ a: 1 });

    expect(result).toBe(true);
  });

  it.each([
    { name: "null", value: null },
    { name: "an array", value: [1, 2] },
    { name: "a string", value: "text" },
    { name: "a number", value: 1 },
    { name: "undefined", value: undefined },
  ])("rejects $name", ({ value }) => {
    const result = isRecord(value);

    expect(result).toBe(false);
  });
});

describe("depthExceeds", () => {
  it.each([
    { name: "a primitive", value: "text", max: 0 },
    { name: "null", value: null, max: 0 },
    { name: "an empty object at max 1", value: {}, max: 1 },
    { name: "an object nested to exactly max", value: nest(3), max: 3 },
    { name: "arrays nested to exactly max", value: [[[]]], max: 3 },
  ])("allows $name", ({ value, max }) => {
    const result = depthExceeds(value, max);

    expect(result).toBe(false);
  });

  it.each([
    { name: "an empty object at max 0", value: {}, max: 0 },
    { name: "an object nested past max", value: nest(4), max: 3 },
    { name: "arrays nested past max", value: [[[[]]]], max: 3 },
    { name: "mixed arrays and objects past max", value: { a: [{ b: [] }] }, max: 3 },
  ])("rejects $name", ({ value, max }) => {
    const result = depthExceeds(value, max);

    expect(result).toBe(true);
  });

  it("measures the deepest branch, not the first", () => {
    const value = { shallow: 1, deep: { a: { b: {} } } };

    const atDepth = depthExceeds(value, 4);
    const belowDepth = depthExceeds(value, 3);

    expect(atDepth).toBe(false);
    expect(belowDepth).toBe(true);
  });

  it("handles hostile nesting without overflowing the stack", () => {
    const value = nest(100_000);

    const result = depthExceeds(value, 100_000);

    expect(result).toBe(false);
  });
});

describe("quote", () => {
  it("wraps input as a JSON string literal", () => {
    const quoted = quote('say "hi"\n');

    expect(quoted).toBe(String.raw`"say \"hi\"\n"`);
  });

  it("keeps input of exactly 64 characters whole", () => {
    const input = "a".repeat(64);

    const quoted = quote(input);

    expect(quoted).toBe(`"${input}"`);
  });

  it("truncates input longer than 64 characters", () => {
    const input = "a".repeat(64) + "b".repeat(1000);

    const quoted = quote(input);

    expect(quoted).toBe(`"${"a".repeat(64)}"`);
  });
});
