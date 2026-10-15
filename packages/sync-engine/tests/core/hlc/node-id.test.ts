import { describe, expect, it } from "vitest";
import { assertNodeId, isValidNodeId } from "#core/hlc/node-id";

const validCases = [
  { name: "single letter", nodeId: "a" },
  { name: "single digit", nodeId: "0" },
  { name: "mixed case", nodeId: "NodeA" },
  { name: "dashes and underscores", nodeId: "node_01-a" },
  { name: "uuid", nodeId: "123e4567-e89b-12d3-a456-426614174000" },
];

const invalidCases = [
  { name: "empty", nodeId: "" },
  { name: "dots", nodeId: "a.b" },
  { name: "spaces", nodeId: "a b" },
  { name: "newline", nodeId: "a\nb" },
  { name: "trailing newline", nodeId: "node\n" },
  { name: "non-ASCII", nodeId: "café" },
];

describe("isValidNodeId", () => {
  it.each(validCases)("accepts $name", ({ nodeId }) => {
    expect(isValidNodeId(nodeId)).toBe(true);
  });

  it.each(invalidCases)("rejects $name", ({ nodeId }) => {
    expect(isValidNodeId(nodeId)).toBe(false);
  });
});

describe("assertNodeId", () => {
  it.each(validCases)("accepts $name", ({ nodeId }) => {
    expect(() => assertNodeId(nodeId)).not.toThrow();
  });

  it.each(invalidCases)("throws RangeError for $name", ({ nodeId }) => {
    expect(() => assertNodeId(nodeId)).toThrow(RangeError);
  });
});
