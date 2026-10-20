import { describe, expect, it } from "vitest";
import { fail, ok } from "#utils/parsed";

describe("ok", () => {
  it("wraps a value as a success", () => {
    const parsed = ok(42);

    expect(parsed).toEqual({ ok: true, value: 42 });
  });
});

describe("fail", () => {
  it("wraps a reason as a failure", () => {
    const parsed = fail("bad input");

    expect(parsed).toEqual({ ok: false, reason: "bad input" });
  });
});
