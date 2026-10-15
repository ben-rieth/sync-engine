import { describe, expect, it } from "vitest";
import { HLCTimestamp, MAX_LOGICAL, MAX_PHYSICAL } from "#core/hlc/timestamp";

const ts = (physical: number, logical: number, nodeId: string) =>
  new HLCTimestamp(physical, logical, nodeId);

// Hand-picked timestamps covering boundaries and tie-breaking edge cases.
const samples = [
  ts(0, 0, "a"),
  ts(0, 0, "b"),
  ts(0, 0, "ab"),
  ts(0, 0, "-"),
  ts(0, 0, "_"),
  ts(0, 0, "A"),
  ts(0, 0, "0"),
  ts(0, 1, "a"),
  ts(0, MAX_LOGICAL, "a"),
  ts(1, 0, "a"),
  ts(1, 0, "a-b_c"),
  ts(9, MAX_LOGICAL, "a"),
  ts(10, 0, "a"),
  ts(1_700_000_000_000, 42, "123e4567-e89b-12d3-a456-426614174000"),
  ts(MAX_PHYSICAL, 0, "z"),
  ts(MAX_PHYSICAL, MAX_LOGICAL, "a"),
  ts(MAX_PHYSICAL, MAX_LOGICAL, "_"),
];

const sampleCases = samples.map((t) => ({ name: t.toString(), t }));

// Every ordered pair of samples, labelled so a failing assertion names its pair.
const pairs = samples.flatMap((a) =>
  samples.map((b) => ({ label: `${a.toString()} vs ${b.toString()}`, a, b })),
);

const expectSameTimestamp = (actual: HLCTimestamp | null, expected: HLCTimestamp) => {
  expect(actual).not.toBeNull();
  expect(actual!.physicalTime).toBe(expected.physicalTime);
  expect(actual!.logicalTime).toBe(expected.logicalTime);
  expect(actual!.nodeId).toBe(expected.nodeId);
};

describe("HLCTimestamp", () => {
  describe("constructor", () => {
    const validCases = [
      { name: "all minimums", physical: 0, logical: 0, nodeId: "a" },
      {
        name: "all maximums",
        physical: MAX_PHYSICAL,
        logical: MAX_LOGICAL,
        nodeId: "node",
      },
      {
        name: "uuid node id",
        physical: 1_700_000_000_000,
        logical: 42,
        nodeId: "123e4567-e89b-12d3-a456-426614174000",
      },
      {
        name: "node id with dashes, underscores and mixed case",
        physical: 1,
        logical: 1,
        nodeId: "Node_01-a",
      },
    ];

    it.each(validCases)("accepts $name", ({ physical, logical, nodeId }) => {
      const t = ts(physical, logical, nodeId);

      expect(t.physicalTime).toBe(physical);
      expect(t.logicalTime).toBe(logical);
      expect(t.nodeId).toBe(nodeId);
    });

    const invalidCases = [
      { name: "negative physical time", physical: -1, logical: 0, nodeId: "a" },
      {
        name: "physical time above max",
        physical: MAX_PHYSICAL + 1,
        logical: 0,
        nodeId: "a",
      },
      {
        name: "non-integer physical time",
        physical: 1.5,
        logical: 0,
        nodeId: "a",
      },
      {
        name: "NaN physical time",
        physical: Number.NaN,
        logical: 0,
        nodeId: "a",
      },
      {
        name: "infinite physical time",
        physical: Number.POSITIVE_INFINITY,
        logical: 0,
        nodeId: "a",
      },
      { name: "logical time 10000", physical: 0, logical: 10_000, nodeId: "a" },
      { name: "negative logical time", physical: 0, logical: -1, nodeId: "a" },
      {
        name: "non-integer logical time",
        physical: 0,
        logical: 0.5,
        nodeId: "a",
      },
      {
        name: "NaN logical time",
        physical: 0,
        logical: Number.NaN,
        nodeId: "a",
      },
      { name: "empty nodeId", physical: 0, logical: 0, nodeId: "" },
      { name: "nodeId with dots", physical: 0, logical: 0, nodeId: "a.b" },
      { name: "nodeId with spaces", physical: 0, logical: 0, nodeId: "a b" },
      { name: "nodeId with newline", physical: 0, logical: 0, nodeId: "a\nb" },
      { name: "non-ASCII nodeId", physical: 0, logical: 0, nodeId: "café" },
    ];

    it.each(invalidCases)("rejects $name", ({ physical, logical, nodeId }) => {
      expect(() => ts(physical, logical, nodeId)).toThrow(RangeError);
    });
  });

  describe("compare", () => {
    const cases = [
      {
        name: "identical timestamps",
        a: ts(1, 1, "a"),
        b: ts(1, 1, "a"),
        expected: 0,
      },
      {
        name: "lower physical time",
        a: ts(1, 9999, "z"),
        b: ts(2, 0, "a"),
        expected: -1,
      },
      {
        name: "higher physical time",
        a: ts(2, 0, "a"),
        b: ts(1, 9999, "z"),
        expected: 1,
      },
      {
        name: "lower logical time on physical tie",
        a: ts(1, 1, "z"),
        b: ts(1, 2, "a"),
        expected: -1,
      },
      {
        name: "higher logical time on physical tie",
        a: ts(1, 2, "a"),
        b: ts(1, 1, "z"),
        expected: 1,
      },
      {
        name: "lower nodeId on full time tie",
        a: ts(1, 1, "a"),
        b: ts(1, 1, "b"),
        expected: -1,
      },
      {
        name: "higher nodeId on full time tie",
        a: ts(1, 1, "b"),
        b: ts(1, 1, "a"),
        expected: 1,
      },
      {
        name: "nodeId prefix sorts first",
        a: ts(1, 1, "a"),
        b: ts(1, 1, "ab"),
        expected: -1,
      },
    ];

    it.each(cases)("static: $name", ({ a, b, expected }) => {
      expect(HLCTimestamp.compare(a, b)).toBe(expected);
    });

    it.each(cases)("instance: $name", ({ a, b, expected }) => {
      expect(a.compare(b)).toBe(expected);
    });
  });

  describe("toString", () => {
    const cases = [
      {
        name: "zero times",
        t: ts(0, 0, "a"),
        expected: "000000000000000.0000.a",
      },
      {
        name: "small times are zero padded",
        t: ts(1, 2, "node"),
        expected: "000000000000001.0002.node",
      },
      {
        name: "max times",
        t: ts(MAX_PHYSICAL, MAX_LOGICAL, "n"),
        expected: "922337203685477.9999.n",
      },
      {
        name: "uuid node id",
        t: ts(1_700_000_000_000, 42, "123e4567-e89b-12d3-a456-426614174000"),
        expected: "001700000000000.0042.123e4567-e89b-12d3-a456-426614174000",
      },
    ];

    it.each(cases)("formats $name", ({ t, expected }) => {
      expect(t.toString()).toBe(expected);
    });
  });

  describe("toBigInt", () => {
    const cases = [
      { name: "zero", t: ts(0, 0, "a"), expected: 0n },
      { name: "logical only", t: ts(0, 9999, "a"), expected: 9999n },
      { name: "physical only", t: ts(1, 0, "a"), expected: 10_000n },
      { name: "both parts", t: ts(123, 45, "a"), expected: 1_230_045n },
      {
        name: "max values",
        t: ts(MAX_PHYSICAL, MAX_LOGICAL, "a"),
        expected: 9_223_372_036_854_779_999n,
      },
    ];

    it.each(cases)("encodes $name", ({ t, expected }) => {
      expect(t.toBigInt()).toBe(expected);
    });
  });

  describe("fromBigInt", () => {
    const validCases = [
      { name: "zero", value: 0n, expected: ts(0, 0, "a") },
      { name: "logical only", value: 9999n, expected: ts(0, 9999, "a") },
      { name: "physical only", value: 10_000n, expected: ts(1, 0, "a") },
      { name: "both parts", value: 1_230_045n, expected: ts(123, 45, "a") },
      {
        name: "max values",
        value: 9_223_372_036_854_779_999n,
        expected: ts(MAX_PHYSICAL, MAX_LOGICAL, "a"),
      },
    ];

    it.each(validCases)("decodes $name", ({ value, expected }) => {
      expectSameTimestamp(HLCTimestamp.fromBigInt(value, expected.nodeId), expected);
    });

    const invalidCases = [
      { name: "negative value", value: -1n, nodeId: "a" },
      {
        name: "physical part above max",
        value: BigInt(MAX_PHYSICAL + 1) * 10_000n,
        nodeId: "a",
      },
      { name: "empty nodeId", value: 0n, nodeId: "" },
    ];

    it.each(invalidCases)("rejects $name", ({ value, nodeId }) => {
      expect(() => HLCTimestamp.fromBigInt(value, nodeId)).toThrow(RangeError);
    });
  });

  const validParseCases = [
    {
      name: "zero times",
      input: "000000000000000.0000.a",
      expected: ts(0, 0, "a"),
    },
    {
      name: "padded times",
      input: "000000000000001.0002.node",
      expected: ts(1, 2, "node"),
    },
    {
      name: "max times",
      input: "922337203685477.9999.n",
      expected: ts(MAX_PHYSICAL, MAX_LOGICAL, "n"),
    },
  ];

  const invalidParseCases = [
    { name: "garbage", input: "abc" },
    { name: "empty string", input: "" },
    { name: "3-digit logical part", input: "000000000000001.001.node" },
    { name: "5-digit logical part", input: "000000000000001.00001.node" },
    { name: "14-digit physical part", input: "00000000000001.0001.node" },
    { name: "16-digit physical part", input: "0000000000000001.0001.node" },
    { name: "missing nodeId", input: "000000000000001.0001." },
    { name: "missing nodeId and separator", input: "000000000000001.0001" },
    { name: "non-digit physical part", input: "00000000000000x.0001.node" },
    { name: "non-digit logical part", input: "000000000000001.000x.node" },
    { name: "negative logical part", input: "000000000000001.-001.node" },
    { name: "physical part above max", input: "922337203685478.0000.node" },
    { name: "nodeId with dots", input: "000000000000001.0001.a.b.c" },
    {
      name: "nodeId with trailing newline",
      input: "000000000000001.0001.node\n",
    },
    { name: "non-ASCII nodeId", input: "000000000000001.0001.café" },
    {
      name: "15-digit logical part (legacy padding)",
      input: "000000000000001.000000000000001.node",
    },
  ];

  describe("tryParse", () => {
    it.each(validParseCases)("parses $name", ({ input, expected }) => {
      expectSameTimestamp(HLCTimestamp.tryParse(input), expected);
    });

    it.each(invalidParseCases)("returns null for $name", ({ input }) => {
      expect(HLCTimestamp.tryParse(input)).toBeNull();
    });
  });

  describe("parse", () => {
    it.each(validParseCases)("parses $name", ({ input, expected }) => {
      expectSameTimestamp(HLCTimestamp.parse(input), expected);
    });

    it.each(invalidParseCases)("throws TypeError for $name", ({ input }) => {
      expect(() => HLCTimestamp.parse(input)).toThrow(TypeError);
    });

    it("includes the invalid input in the error message", () => {
      expect(() => HLCTimestamp.parse("abc")).toThrow("Invalid HLC timestamp: abc");
    });
  });

  describe("properties", () => {
    it.each(sampleCases)("round trips through toString/tryParse: $name", ({ t }) => {
      expectSameTimestamp(HLCTimestamp.tryParse(t.toString()), t);
    });

    it.each(sampleCases)("round trips through toString/parse: $name", ({ t }) => {
      expectSameTimestamp(HLCTimestamp.parse(t.toString()), t);
    });

    it.each(sampleCases)("round trips through toBigInt/fromBigInt: $name", ({ t }) => {
      expectSameTimestamp(HLCTimestamp.fromBigInt(t.toBigInt(), t.nodeId), t);
    });

    it("string ordering agrees with compare", () => {
      for (const { label, a, b } of pairs) {
        expect(a.toString() < b.toString(), label).toBe(HLCTimestamp.compare(a, b) < 0);
      }
    });

    it("numeric ordering agrees with compare when nodeIds match", () => {
      for (const { label, a, b } of pairs) {
        const bSameNode = ts(b.physicalTime, b.logicalTime, a.nodeId);
        const numeric =
          a.toBigInt() < bSameNode.toBigInt() ? -1 : a.toBigInt() > bSameNode.toBigInt() ? 1 : 0;
        expect(numeric, label).toBe(HLCTimestamp.compare(a, bSameNode));
      }
    });

    it("compare is antisymmetric", () => {
      for (const { label, a, b } of pairs) {
        expect(HLCTimestamp.compare(a, b), label).toBe(-HLCTimestamp.compare(b, a) || 0);
      }
    });

    it("compare returns 0 only for equal components", () => {
      for (const { label, a, b } of pairs) {
        const equal =
          a.physicalTime === b.physicalTime &&
          a.logicalTime === b.logicalTime &&
          a.nodeId === b.nodeId;
        expect(HLCTimestamp.compare(a, b) === 0, label).toBe(equal);
      }
    });
  });
});
