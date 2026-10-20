import { afterEach, describe, expect, it, vi } from "vitest";
import { serverMemoryDatabase } from "#adapters/server-memory";
import type { WireDelta } from "#core/delta";
import { ConfigError } from "#core/errors";
import { PROTOCOL_HEADER } from "#core/protocol";
import {
  createSyncServer,
  type SyncRequest,
  type SyncServer,
  type SyncServerHooks,
  type SyncServerOptions,
} from "#core/server/sync-server";
import { delta, serverDeltas } from "../../helpers";

// Node's global Request; the ES2024 lib doesn't declare it
declare const Request: new (
  url: string,
  init?: { method?: string; headers?: Record<string, string>; body?: string },
) => SyncRequest;

const ORIGIN = "http://localhost";
const BASE = `${ORIGIN}/api/sync`;
const START = 1_700_000_000_000;
const HEADERS: Record<string, string> = { [PROTOCOL_HEADER]: "1" };

const setup = (options: Partial<SyncServerOptions> = {}) => {
  const database = serverMemoryDatabase();
  const getUserId = vi.fn<SyncServerOptions["getUserId"]>(() => "user-1");
  const onError = vi.fn<NonNullable<SyncServerHooks["onError"]>>();
  const sync = createSyncServer({
    database,
    getUserId,
    hooks: { onError },
    now: () => START,
    ...options,
  });
  return { sync, database, getUserId, onError };
};

const pushRequest = (
  deltas: WireDelta[],
  { nodeId = "node-a", headers = HEADERS, url = `${BASE}/push` } = {},
) => new Request(url, { method: "POST", headers, body: JSON.stringify({ nodeId, deltas }) });

const nestedDelta = (depth: number): WireDelta => {
  let value: unknown = 1;
  for (let level = 0; level < depth; level++) {
    value = [value];
  }
  return { ...delta(1), value };
};

const postRaw = (body: string, headers: Record<string, string> = HEADERS) =>
  new Request(`${BASE}/push`, { method: "POST", headers, body });

const pullRequest = (query = "nodeId=node-b", { headers = HEADERS, url = `${BASE}/pull` } = {}) =>
  new Request(`${url}?${query}`, { headers });

const streamedPush = (chunks: Uint8Array[]) => {
  const read = vi.fn<() => Promise<{ done: boolean; value?: Uint8Array }>>(async () => {
    const value = chunks.shift();
    return value ? { done: false, value } : { done: true };
  });
  const cancel = vi.fn<() => Promise<void>>(async () => {});
  const request: SyncRequest = {
    method: "POST",
    url: `${BASE}/push`,
    headers: { get: (name) => (name === PROTOCOL_HEADER ? "1" : null) },
    body: { getReader: () => ({ read, cancel }) },
  };
  return { request, read, cancel };
};

const send = async (sync: SyncServer, request: SyncRequest) => {
  const response = await sync.handler(request);
  const text = await response.text();
  const body: unknown = text === "" ? null : JSON.parse(text);
  return { status: response.status, body, headers: response.headers };
};

describe("createSyncServer", () => {
  describe("routing", () => {
    it.each([
      { name: "an unknown path", request: pullRequest("nodeId=node-b", { url: `${BASE}/other` }) },
      { name: "GET on push", request: new Request(`${BASE}/push`, { headers: HEADERS }) },
      {
        name: "POST on pull",
        request: new Request(`${BASE}/pull`, { method: "POST", headers: HEADERS, body: "{}" }),
      },
      { name: "a path outside basePath", request: pushRequest([], { url: `${ORIGIN}/push` }) },
      { name: "a path below a route", request: pushRequest([], { url: `${BASE}/push/extra` }) },
      { name: "an unknown path without the protocol header", request: new Request(`${BASE}/x`) },
    ])("answers 404 for $name", async ({ request }) => {
      const { sync } = setup();

      const response = await send(sync, request);

      expect(response).toMatchObject({ status: 404, body: { code: "not-found" } });
    });

    it("accepts a basePath with a trailing slash", async () => {
      const { sync } = setup({ basePath: "/sync/" });

      const response = await send(
        sync,
        pullRequest("nodeId=node-b", { url: `${ORIGIN}/sync/pull` }),
      );

      expect(response.status).toBe(200);
    });
  });

  describe("protocol and auth", () => {
    it.each<{ name: string; headers: Record<string, string> }>([
      { name: "missing", headers: {} },
      { name: "a different version", headers: { [PROTOCOL_HEADER]: "2" } },
    ])(
      "answers 409 when the protocol header is $name, before asking for the user",
      async ({ headers }) => {
        const { sync, getUserId } = setup();

        const response = await send(sync, pushRequest([delta(1)], { headers }));

        expect(response).toMatchObject({ status: 409, body: { code: "protocol" } });
        expect(getUserId).not.toHaveBeenCalled();
      },
    );

    it("answers 401 without reading the body or touching the database", async () => {
      const { sync, database } = setup({ getUserId: () => null });
      const push = vi.spyOn(database, "push");
      const { request, read } = streamedPush([]);

      const response = await send(sync, request);

      expect(response).toMatchObject({ status: 401, body: { code: "unauthorized" } });
      expect(read).not.toHaveBeenCalled();
      expect(push).not.toHaveBeenCalled();
    });

    it("passes the request to getUserId and stores under the returned user", async () => {
      const { sync, database, getUserId } = setup();
      getUserId.mockReturnValue("user-2");
      const request = pushRequest([delta(1)]);

      await send(sync, request);
      const stored = await serverDeltas(database, "user-2");

      expect(getUserId).toHaveBeenCalledWith(request);
      expect(stored).toEqual([delta(1)]);
    });
  });

  describe("push", () => {
    it("stores the deltas and answers 204 with no body", async () => {
      const { sync, database } = setup();

      const response = await send(sync, pushRequest([delta(1), delta(2)]));
      const stored = await serverDeltas(database);

      expect(response).toMatchObject({ status: 204, body: null });
      expect(stored).toEqual([delta(1), delta(2)]);
    });

    it("answers 204 to an empty push without calling the database", async () => {
      const { sync, database } = setup();
      const push = vi.spyOn(database, "push");

      const response = await send(sync, pushRequest([]));

      expect(response.status).toBe(204);
      expect(push).not.toHaveBeenCalled();
    });

    it("stores a retried push once", async () => {
      const { sync, database } = setup();

      await send(sync, pushRequest([delta(1)]));
      const retry = await send(sync, pushRequest([delta(1)]));
      const stored = await serverDeltas(database);

      expect(retry.status).toBe(204);
      expect(stored).toEqual([delta(1)]);
    });

    it("answers 413 when content-length is over maxBodyBytes", async () => {
      const { sync } = setup({ limits: { maxBodyBytes: 10 } });
      const { request, read } = streamedPush([]);
      const headers = {
        get: (name: string) => (name === "content-length" ? "11" : request.headers.get(name)),
      };

      const response = await send(sync, { ...request, headers });

      expect(response).toMatchObject({ status: 413, body: { code: "too-large" } });
      expect(read).not.toHaveBeenCalled();
    });

    it("stops reading a streamed body once it passes maxBodyBytes", async () => {
      const { sync } = setup({ limits: { maxBodyBytes: 10 } });
      const { request, read, cancel } = streamedPush([
        new Uint8Array(6),
        new Uint8Array(6),
        new Uint8Array(6),
      ]);

      const response = await send(sync, request);

      expect(response).toMatchObject({ status: 413, body: { code: "too-large" } });
      expect(read).toHaveBeenCalledTimes(2);
      expect(cancel).toHaveBeenCalledOnce();
    });

    it("reads a body split across chunks", async () => {
      const { sync, database } = setup();
      const json = JSON.stringify({ nodeId: "node-a", deltas: [delta(1)] });
      const bytes = Uint8Array.from(json, (char) => char.charCodeAt(0));
      const { request } = streamedPush([bytes.slice(0, 10), bytes.slice(10)]);

      const response = await send(sync, request);
      const stored = await serverDeltas(database);

      expect(response.status).toBe(204);
      expect(stored).toEqual([delta(1)]);
    });

    it.each([
      { name: "invalid JSON", request: () => postRaw("{") },
      { name: "an empty body", request: () => postRaw("") },
      { name: "invalid UTF-8", request: () => streamedPush([new Uint8Array([0xff])]).request },
      { name: "a body that isn't a push", request: () => postRaw(JSON.stringify({ deltas: [] })) },
      {
        name: "a malformed timestamp",
        request: () => pushRequest([{ ...delta(1), timestamp: "garbage" }]),
      },
      { name: "a value nested too deeply", request: () => pushRequest([nestedDelta(126)]) },
    ])("answers 400 for $name", async ({ request }) => {
      const { sync } = setup();

      const response = await send(sync, request());

      expect(response).toMatchObject({ status: 400, body: { code: "bad-request" } });
    });

    it("says why a value nested too deeply was rejected", async () => {
      const { sync } = setup();

      const response = await send(sync, pushRequest([nestedDelta(126)]));

      expect(response.body).toMatchObject({ message: "Body is nested too deeply" });
    });

    it("accepts a value nested right up to the depth limit", async () => {
      const { sync } = setup();
      const nested = nestedDelta(125);

      const push = await send(sync, pushRequest([nested]));
      const pull = await send(sync, pullRequest("nodeId=node-b"));

      expect(push.status).toBe(204);
      expect(pull.body).toMatchObject({ deltas: [nested] });
    });

    it("answers 413 for more deltas than maxPushDeltas", async () => {
      const { sync } = setup({ limits: { maxPushDeltas: 2 } });

      const atLimit = await send(sync, pushRequest([delta(1), delta(2)]));
      const overLimit = await send(sync, pushRequest([delta(3), delta(4), delta(5)]));

      expect(atLimit.status).toBe(204);
      expect(overLimit).toMatchObject({ status: 413, body: { code: "too-large" } });
    });

    it("answers 400 node-mismatch and stores nothing when a timestamp is from another node", async () => {
      const { sync, database } = setup();

      const response = await send(sync, pushRequest([delta(1, "node-a"), delta(2, "node-b")]));
      const stored = await serverDeltas(database);

      expect(response).toMatchObject({ status: 400, body: { code: "node-mismatch" } });
      expect(stored).toEqual([]);
    });

    it("accepts a timestamp exactly at the drift limit", async () => {
      const { sync } = setup({ limits: { maxDriftMs: 100 } });

      const response = await send(sync, pushRequest([delta(START + 100)]));

      expect(response.status).toBe(204);
    });

    it("answers 409 clock-ahead with the newest timestamp's skew and stores nothing", async () => {
      const { sync, database } = setup({ limits: { maxDriftMs: 100 } });

      const response = await send(
        sync,
        pushRequest([delta(1), delta(START + 500), delta(START + 101)]),
      );
      const stored = await serverDeltas(database);

      expect(response).toMatchObject({
        status: 409,
        body: { code: "clock-ahead", skewMs: 500 },
      });
      expect(stored).toEqual([]);
    });

    it("skips the drift check when maxDriftMs is Infinity", async () => {
      const { sync } = setup({ limits: { maxDriftMs: Infinity } });

      const response = await send(sync, pushRequest([delta(START * 2)]));

      expect(response.status).toBe(204);
    });

    it("cuts client input short in error messages", async () => {
      const { sync } = setup();
      const timestamp = "x".repeat(10_000);

      const response = await send(sync, pushRequest([{ ...delta(1), timestamp }]));

      expect(response.status).toBe(400);
      expect(JSON.stringify(response.body).length).toBeLessThan(200);
    });
  });

  describe("pull", () => {
    it("answers 200 with the page", async () => {
      const { sync } = setup();
      await send(sync, pushRequest([delta(1)]));

      const response = await send(sync, pullRequest("nodeId=node-b"));

      expect(response).toMatchObject({
        status: 200,
        body: { deltas: [delta(1)], cursor: "1", hasMore: false },
      });
    });

    it("leaves out the caller's own deltas", async () => {
      const { sync } = setup();
      await send(sync, pushRequest([delta(1)]));

      const response = await send(sync, pullRequest("nodeId=node-a"));

      expect(response.body).toMatchObject({ deltas: [] });
    });

    it("continues from the cursor", async () => {
      const { sync } = setup();
      await send(sync, pushRequest([delta(1), delta(2)]));

      const response = await send(sync, pullRequest("nodeId=node-b&cursor=1"));

      expect(response.body).toMatchObject({ deltas: [delta(2)] });
    });

    it.each([
      { name: "an omitted limit", query: "nodeId=node-b", limit: 5 },
      { name: "a limit above the max", query: "nodeId=node-b&limit=50", limit: 5 },
      { name: "a limit below the max", query: "nodeId=node-b&limit=3", limit: 3 },
    ])("asks the database for at most maxPullLimit for $name", async ({ query, limit }) => {
      const { sync, database } = setup({ limits: { maxPullLimit: 5 } });
      const pull = vi.spyOn(database, "pull");

      await send(sync, pullRequest(query));

      expect(pull).toHaveBeenCalledWith("user-1", {
        cursor: null,
        excludeNodeId: "node-b",
        limit,
      });
    });

    it.each([
      { name: "a missing nodeId", query: "" },
      { name: "a malformed limit", query: "nodeId=node-b&limit=0" },
      { name: "an empty cursor", query: "nodeId=node-b&cursor=" },
    ])("answers 400 for $name", async ({ query }) => {
      const { sync } = setup();

      const response = await send(sync, pullRequest(query));

      expect(response).toMatchObject({ status: 400, body: { code: "bad-request" } });
    });

    it("answers 400 for a cursor the database didn't issue, without echoing it", async () => {
      const { sync, onError } = setup();

      const response = await send(sync, pullRequest("nodeId=node-b&cursor=abc"));

      expect(response).toMatchObject({
        status: 400,
        body: { code: "bad-request", message: "Invalid cursor" },
      });
      expect(onError).not.toHaveBeenCalled();
    });
  });

  describe("responses", () => {
    it("sends JSON that is never cached", async () => {
      const { sync } = setup();

      const response = await send(sync, pullRequest());

      expect(response.headers.get("content-type")).toBe("application/json");
      expect(response.headers.get("cache-control")).toBe("no-store");
    });

    it("never caches a 204", async () => {
      const { sync } = setup();

      const response = await send(sync, pushRequest([]));

      expect(response.headers.get("cache-control")).toBe("no-store");
    });
  });

  describe("unexpected failures", () => {
    it("answers a generic 500 and reports the error when the database fails", async () => {
      const { sync, database, onError } = setup();
      const failure = new Error("database down");
      vi.spyOn(database, "push").mockRejectedValue(failure);
      const request = pushRequest([delta(1)]);

      const response = await send(sync, request);

      expect(response).toMatchObject({
        status: 500,
        body: { code: "internal", message: "Internal error" },
      });
      expect(onError).toHaveBeenCalledWith(failure, request);
    });

    it("answers 500 when getUserId throws", async () => {
      const failure = new Error("session store down");
      const { sync, onError } = setup({
        getUserId: () => {
          throw failure;
        },
      });

      const response = await send(sync, pullRequest());

      expect(response.status).toBe(500);
      expect(onError).toHaveBeenCalledWith(failure, expect.anything());
    });

    it("still answers 500 when onError throws", async () => {
      const { sync, database } = setup({
        hooks: {
          onError: () => {
            throw new Error("reporter down");
          },
        },
      });
      vi.spyOn(database, "pull").mockRejectedValue(new Error("database down"));

      const response = await send(sync, pullRequest());

      expect(response).toMatchObject({ status: 500, body: { code: "internal" } });
    });

    it("answers 500 without hooks", async () => {
      const { sync, database } = setup({ hooks: {} });
      vi.spyOn(database, "pull").mockRejectedValue(new Error("database down"));

      const response = await send(sync, pullRequest());

      expect(response.status).toBe(500);
    });
  });

  describe("config", () => {
    afterEach(() => {
      vi.unstubAllGlobals();
    });

    it.each([
      { maxPullLimit: 0 },
      { maxPushDeltas: -1 },
      { maxBodyBytes: 1.5 },
      { maxPullLimit: Number.NaN },
      { maxDriftMs: -1 },
    ])("throws ConfigError for limits %o", (limits) => {
      expect(() => setup({ limits })).toThrow(ConfigError);
    });

    it("throws ConfigError for a basePath without a leading slash", () => {
      expect(() => setup({ basePath: "api/sync" })).toThrow(ConfigError);
    });

    it("throws ConfigError naming missing fetch-standard globals", () => {
      vi.stubGlobal("Response", undefined);

      expect(() => setup()).toThrow(new ConfigError("Missing fetch-standard globals: Response"));
    });
  });

  it("round-trips deltas between two devices", async () => {
    const { sync } = setup();
    await send(sync, pushRequest([delta(1, "node-a")]));
    await send(sync, pushRequest([delta(2, "node-b")], { nodeId: "node-b" }));

    const forA = await send(sync, pullRequest("nodeId=node-a"));
    const forB = await send(sync, pullRequest("nodeId=node-b"));

    expect(forA.body).toMatchObject({ deltas: [delta(2, "node-b")] });
    expect(forB.body).toMatchObject({ deltas: [delta(1, "node-a")] });
  });
});
