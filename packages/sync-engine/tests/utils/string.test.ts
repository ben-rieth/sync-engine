import { describe, expect, it } from "vitest";
import { isNonEmptyString } from "#utils/string";

describe("isNonEmptyString", () => {
  it("accepts a non-empty string", () => {
    expect(isNonEmptyString("a")).toBe(true);
  });

  it.each([
    { name: "an empty string", value: "" },
    { name: "a number", value: 7 },
    { name: "null", value: null },
    { name: "undefined", value: undefined },
    { name: "a String object", value: new String("a") },
  ])("rejects $name", ({ value }) => {
    expect(isNonEmptyString(value)).toBe(false);
  });
});
