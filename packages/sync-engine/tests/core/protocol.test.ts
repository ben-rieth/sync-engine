import { describe, expect, it } from "vitest";
import { HLCTimestamp } from "#core/hlc/timestamp";
import { parseErrorBody, parsePullQuery, parsePullResponse, parsePushBody } from "#core/protocol";
import { delta } from "../helpers";

const encrypted = {
  timestamp: new HLCTimestamp(1, 0, "node-a").toString(),
  payload: "ciphertext",
};

// URLSearchParams stand-in; the ES2024 lib doesn't declare it
const query = (params: Partial<Record<string, string>>) => ({
  get: (name: string) => params[name] ?? null,
});

const malformedDeltas = [
  { name: "deltas that are not an array", deltas: { 0: delta(1) } },
  { name: "a delta that is an array", deltas: [[delta(1)]] },
  { name: "a null delta", deltas: [null] },
  { name: "a delta without a timestamp", deltas: [{ payload: "x" }] },
  { name: "a numeric timestamp", deltas: [{ timestamp: 1 }] },
  { name: "a timestamp not in HLC format", deltas: [{ timestamp: "garbage" }] },
  { name: "a timestamp with an invalid node", deltas: [{ timestamp: "000000000000001.0000.a b" }] },
];

describe("parsePushBody", () => {
  it("accepts a body and returns each delta's parsed timestamp", () => {
    const deltas = [delta(1), delta(2)];

    const parsed = parsePushBody({ nodeId: "node-a", deltas });

    expect(parsed).toEqual({
      ok: true,
      value: {
        nodeId: "node-a",
        deltas,
        timestamps: [new HLCTimestamp(1, 0, "node-a"), new HLCTimestamp(2, 0, "node-a")],
      },
    });
  });

  it("passes fields it cannot read through unchanged, as a codec would send them", () => {
    const parsed = parsePushBody({ nodeId: "node-a", deltas: [encrypted] });

    expect(parsed.ok && parsed.value.deltas).toEqual([encrypted]);
  });

  it.each([
    { name: "a body that is not an object", body: [] },
    { name: "a null body", body: null },
    { name: "a missing nodeId", body: { deltas: [] } },
    { name: "an invalid nodeId", body: { nodeId: "a b", deltas: [] } },
    { name: "a missing deltas field", body: { nodeId: "node-a" } },
    ...malformedDeltas.map(({ name, deltas }) => ({ name, body: { nodeId: "node-a", deltas } })),
  ])("rejects $name", ({ body }) => {
    const parsed = parsePushBody(body);

    expect(parsed.ok).toBe(false);
  });

  it("quotes a bad timestamp cut to 64 characters", () => {
    const timestamp = "x".repeat(10_000);

    const parsed = parsePushBody({ nodeId: "node-a", deltas: [{ timestamp }] });

    expect(parsed).toEqual({ ok: false, reason: `Invalid timestamp: "${"x".repeat(64)}"` });
  });
});

describe("parsePullQuery", () => {
  it("reads nodeId, cursor and limit", () => {
    const parsed = parsePullQuery(query({ nodeId: "node-a", cursor: "42", limit: "100" }));

    expect(parsed).toEqual({ ok: true, value: { nodeId: "node-a", cursor: "42", limit: 100 } });
  });

  it("returns null for an omitted cursor and limit", () => {
    const parsed = parsePullQuery(query({ nodeId: "node-a" }));

    expect(parsed).toEqual({ ok: true, value: { nodeId: "node-a", cursor: null, limit: null } });
  });

  it.each([
    { name: "a missing nodeId", params: {} },
    { name: "an invalid nodeId", params: { nodeId: "a b" } },
    { name: "an empty cursor", params: { nodeId: "node-a", cursor: "" } },
    ...["0", "-1", "1.5", "abc", "", "1e3"].map((limit) => ({
      name: `limit ${JSON.stringify(limit)}`,
      params: { nodeId: "node-a", limit },
    })),
  ])("rejects $name", ({ params }) => {
    const parsed = parsePullQuery(query(params));

    expect(parsed.ok).toBe(false);
  });

  it.each(["99999999999999999999", "9".repeat(10_000)])(
    "clamps a limit beyond the safe integer range (%#)",
    (limit) => {
      const parsed = parsePullQuery(query({ nodeId: "node-a", limit }));

      expect(parsed).toEqual({
        ok: true,
        value: { nodeId: "node-a", cursor: null, limit: Number.MAX_SAFE_INTEGER },
      });
    },
  );

  it("quotes a bad limit cut to 64 characters", () => {
    const limit = "x".repeat(10_000);

    const parsed = parsePullQuery(query({ nodeId: "node-a", limit }));

    expect(parsed).toEqual({
      ok: false,
      reason: `limit must be a positive integer: "${"x".repeat(64)}"`,
    });
  });
});

describe("parsePullResponse", () => {
  it("accepts a page", () => {
    const page = { deltas: [delta(1)], cursor: "1", hasMore: true };

    const parsed = parsePullResponse(page);

    expect(parsed).toEqual({ ok: true, value: page });
  });

  it("accepts a null cursor when there is nothing more", () => {
    const parsed = parsePullResponse({ deltas: [], cursor: null, hasMore: false });

    expect(parsed.ok).toBe(true);
  });

  it("passes fields it cannot read through unchanged, as a codec would send them", () => {
    const parsed = parsePullResponse({ deltas: [encrypted], cursor: "1", hasMore: false });

    expect(parsed.ok && parsed.value.deltas).toEqual([encrypted]);
  });

  it.each([
    { name: "a response that is not an object", response: "page" },
    { name: "a numeric cursor", response: { deltas: [], cursor: 1, hasMore: false } },
    { name: "a missing cursor", response: { deltas: [], hasMore: false } },
    { name: "a non-boolean hasMore", response: { deltas: [], cursor: "1", hasMore: "no" } },
    { name: "hasMore with a null cursor", response: { deltas: [], cursor: null, hasMore: true } },
    ...malformedDeltas.map(({ name, deltas }) => ({
      name,
      response: { deltas, cursor: "1", hasMore: false },
    })),
  ])("rejects $name", ({ response }) => {
    const parsed = parsePullResponse(response);

    expect(parsed.ok).toBe(false);
  });
});

describe("parseErrorBody", () => {
  it("reads code and message", () => {
    const body = parseErrorBody({ code: "bad-request", message: "nope" });

    expect(body).toEqual({ code: "bad-request", message: "nope" });
  });

  it("reads skewMs", () => {
    const body = parseErrorBody({ code: "clock-ahead", message: "ahead", skewMs: 3000 });

    expect(body).toEqual({ code: "clock-ahead", message: "ahead", skewMs: 3000 });
  });

  it.each([
    { name: "a body that is not an object", json: "error" },
    { name: "an unknown code", json: { code: "teapot", message: "x" } },
    { name: "a missing message", json: { code: "internal" } },
    { name: "a string skewMs", json: { code: "clock-ahead", message: "x", skewMs: "3000" } },
  ])("returns null for $name", ({ json }) => {
    const body = parseErrorBody(json);

    expect(body).toBeNull();
  });
});
