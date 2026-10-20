import { describe, expect, it } from "vitest";
import { parseDelta, type WireDelta } from "#core/delta";

const TIMESTAMP = "000000000000001.0000.node-a";

const set = {
  kind: "set",
  timestamp: TIMESTAMP,
  table: "items",
  objectId: "obj-1",
  column: "title",
};

describe("parseDelta", () => {
  it("accepts a set delta", () => {
    const wire = { ...set, value: "hello" };

    const parsed = parseDelta(wire);

    expect(parsed).toEqual({ ok: true, value: wire });
  });

  it("accepts a null value", () => {
    const parsed = parseDelta({ ...set, value: null });

    expect(parsed.ok && parsed.value).toMatchObject({ value: null });
  });

  it("accepts a delete delta", () => {
    const wire = { kind: "delete", timestamp: TIMESTAMP, table: "items", objectId: "obj-1" };

    const parsed = parseDelta(wire);

    expect(parsed).toEqual({ ok: true, value: wire });
  });

  it("drops fields it does not know", () => {
    const parsed = parseDelta({ ...set, value: 1, extra: "junk" });

    expect(parsed.ok && parsed.value).toEqual({ ...set, value: 1 });
  });

  it.each<{ name: string; wire: WireDelta }>([
    { name: "an unknown kind", wire: { ...set, kind: "upsert", value: 1 } },
    { name: "a missing kind", wire: { ...set, kind: undefined, value: 1 } },
    { name: "a non-string table", wire: { ...set, table: 1, value: 1 } },
    { name: "a missing objectId", wire: { ...set, objectId: undefined, value: 1 } },
    { name: "a set without a column", wire: { ...set, column: undefined, value: 1 } },
    { name: "a set without a value", wire: set },
  ])("rejects $name", ({ wire }) => {
    const parsed = parseDelta(wire);

    expect(parsed.ok).toBe(false);
  });
});
