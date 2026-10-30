import { afterEach, describe, expect, it, vi } from "vitest";
import { clientMemoryStorage } from "#adapters/client-memory";
import { httpTransport, type HttpTransportOptions } from "#adapters/transport-http";
import type { WireDelta } from "#core/delta";
import { ConfigError, HttpError, NodeClaimedError } from "#core/errors";
import { LocalClockAheadError } from "#core/hlc/clock";
import { PROTOCOL_HEADER } from "#core/protocol";
import { ServerProtocolError } from "#core/server/server";
import type { WebFetch, WebRequestInit, WebResponse } from "#utils/web";
import { delta, elementAt, failed, openClient, timestamps } from "../helpers";

const BASE = "http://localhost/api/sync";
const EMPTY_PAGE = { deltas: [], cursor: null, hasMore: false };

const reply = (status: number, body?: unknown): WebResponse => ({
  status,
  headers: { get: () => null },
  text: async () => (typeof body === "string" ? body : (JSON.stringify(body) ?? "")),
});

// Like a fetch that ignores its signal
const neverReply = (): Promise<WebResponse> => new Promise(() => {});

const rejection = async (promise: Promise<unknown>): Promise<unknown> =>
  promise.catch((error: unknown) => error);

const setup = (
  respond: (url: string, init: WebRequestInit) => WebResponse | Promise<WebResponse>,
  options: Partial<HttpTransportOptions> = {},
) => {
  const fetch = vi.fn<WebFetch>(async (url, init) => respond(url, init));
  const transport = httpTransport({ baseURL: BASE, fetch, ...options });
  const call = (index: number) => {
    const [url, init] = elementAt(fetch.mock.calls, index);
    return { url, init };
  };
  return { transport, fetch, call };
};

const pushedDeltas = (init: WebRequestInit): WireDelta[] => {
  const body: { deltas: WireDelta[] } = JSON.parse(init.body ?? "");
  return body.deltas;
};

const firstPull = { cursor: null, nodeId: "node-a", limit: 10 };

describe("httpTransport", () => {
  describe("requests", () => {
    it("pulls with GET, leaving out the cursor on the first pull", async () => {
      const page = { deltas: [delta(1, "node-b")], cursor: "1", hasMore: false };
      const { transport, call } = setup(() => reply(200, page));

      const result = await transport.pull(firstPull);

      expect(result).toEqual(page);
      expect(call(0).url).toBe(`${BASE}/pull?nodeId=node-a&limit=10`);
      expect(call(0).init.method).toBe("GET");
      expect(call(0).init.body).toBeUndefined();
    });

    it("encodes the cursor", async () => {
      const { transport, call } = setup(() => reply(200, EMPTY_PAGE));

      await transport.pull({ cursor: "a b&c/=", nodeId: "node-a", limit: 10 });

      expect(call(0).url).toBe(`${BASE}/pull?nodeId=node-a&limit=10&cursor=a%20b%26c%2F%3D`);
    });

    it("ignores trailing slashes on baseURL", async () => {
      const { transport, call } = setup(() => reply(200, EMPTY_PAGE), { baseURL: `${BASE}//` });

      await transport.pull(firstPull);

      expect(call(0).url).toBe(`${BASE}/pull?nodeId=node-a&limit=10`);
    });

    it("pushes JSON with POST", async () => {
      const deltas = [delta(1), delta(2)];
      const { transport, call } = setup(() => reply(204));

      await transport.push({ nodeId: "node-a", deltas });

      expect(call(0).url).toBe(`${BASE}/push`);
      expect(call(0).init.method).toBe("POST");
      expect(call(0).init.headers["content-type"]).toBe("application/json");
      expect(JSON.parse(call(0).init.body ?? "")).toEqual({ nodeId: "node-a", deltas });
    });

    it("sends the protocol header, awaited custom headers and credentials", async () => {
      const headers = vi.fn<NonNullable<HttpTransportOptions["headers"]>>(async () => ({
        authorization: "Bearer t",
        [PROTOCOL_HEADER]: "2",
      }));
      const { transport, call } = setup(() => reply(200, EMPTY_PAGE), {
        headers,
        credentials: "include",
      });

      await transport.pull(firstPull);
      await transport.pull(firstPull);

      expect(headers).toHaveBeenCalledTimes(2);
      expect(call(0).init.headers).toEqual({ authorization: "Bearer t", [PROTOCOL_HEADER]: "1" });
      expect(call(0).init.credentials).toBe("include");
    });

    it("lets the built-in headers override custom ones in any letter case", async () => {
      const { transport, call } = setup(() => reply(204), {
        headers: () => ({ "X-Sync-Protocol": "999", "Content-Type": "text/plain" }),
      });

      await transport.push({ nodeId: "node-a", deltas: [delta(1)] });

      expect(call(0).init.headers).toEqual({
        "content-type": "application/json",
        [PROTOCOL_HEADER]: "1",
      });
    });

    it("refuses to follow redirects", async () => {
      const { transport, call } = setup(() => reply(200, EMPTY_PAGE));

      await transport.pull(firstPull);

      expect(call(0).init.redirect).toBe("error");
    });
  });

  describe("errors", () => {
    it.each([
      [400, "bad-request", false],
      [401, "unauthorized", false],
      [403, "bad-request", false],
      [404, "not-found", false],
      [409, "protocol", false],
      [413, "too-large", false],
      [408, null, true],
      [429, null, true],
      [500, "internal", true],
      [503, null, true],
    ])("turns %i (%s) into an HttpError, retryable: %s", async (status, code, retryable) => {
      const body = code === null ? "" : { code, message: "Refused" };
      const { transport } = setup(() => reply(status, body));

      const error = await rejection(transport.pull(firstPull));

      expect(error).toBeInstanceOf(HttpError);
      expect(error).toMatchObject({ status, retryable, serverCode: code });
    });

    it("includes the server's message when the body is an error body", async () => {
      const { transport } = setup(() => reply(400, { code: "bad-request", message: "Bad" }));

      const error = await rejection(transport.pull(firstPull));

      expect(error).toBeInstanceOf(HttpError);
      expect(error).toMatchObject({ message: "HTTP 400: Bad" });
    });

    it("reports only the status when the body isn't an error body", async () => {
      const { transport } = setup(() => reply(502, "<html>"));

      const error = await rejection(transport.pull(firstPull));

      expect(error).toMatchObject({ message: "HTTP 502", serverCode: null });
    });

    it("doesn't treat a push answered with 200 as accepted", async () => {
      const { transport } = setup(() => reply(200));

      const error = await rejection(transport.push({ nodeId: "node-a", deltas: [delta(1)] }));

      expect(error).toBeInstanceOf(HttpError);
      expect(error).toMatchObject({ status: 200 });
    });

    it("turns a rejecting headers callback into an HttpError without a status", async () => {
      const cause = new Error("Token expired");
      const { transport, fetch } = setup(() => reply(200, EMPTY_PAGE), {
        headers: () => Promise.reject(cause),
      });

      const error = await rejection(transport.pull(firstPull));

      expect(error).toBeInstanceOf(HttpError);
      expect(error).toMatchObject({ status: null, cause });
      expect(fetch).not.toHaveBeenCalled();
    });

    it("turns clock-ahead into LocalClockAheadError", async () => {
      const body = { code: "clock-ahead", message: "Ahead", skewMs: 600_000 };
      const { transport } = setup(() => reply(409, body));

      const error = await rejection(transport.push({ nodeId: "node-a", deltas: [delta(1)] }));

      expect(error).toBeInstanceOf(LocalClockAheadError);
      expect(error).toMatchObject({ skewMs: 600_000 });
    });

    it("turns node-claimed into NodeClaimedError for the pushed node id", async () => {
      const { transport } = setup(() => reply(403, { code: "node-claimed", message: "Claimed" }));

      const error = await rejection(
        transport.push({ nodeId: "node-b", deltas: [delta(1, "node-b")] }),
      );

      expect(error).toBeInstanceOf(NodeClaimedError);
      expect(error).toMatchObject({ nodeId: "node-b" });
    });

    it("turns a network failure into a retryable HttpError without a status", async () => {
      const cause = new Error("Connection refused");
      const { transport } = setup(() => Promise.reject(cause));

      const error = await rejection(transport.pull(firstPull));

      expect(error).toBeInstanceOf(HttpError);
      expect(error).toMatchObject({ status: null, retryable: true, cause });
    });

    it.each([
      ["isn't JSON", "<html>"],
      ["has the wrong shape", { deltas: [], cursor: null }],
    ])("rejects a pull response that %s with ServerProtocolError", async (_name, body) => {
      const { transport } = setup(() => reply(200, body));

      const error = await rejection(transport.pull(firstPull));

      expect(error).toBeInstanceOf(ServerProtocolError);
    });

    it("reaches syncNow as a server-protocol error, not a transport error", async () => {
      const { transport } = setup(() => reply(200, "<html>"));
      const client = openClient({ storage: clientMemoryStorage(), transport });

      const error = await failed(client.raw.syncNow(), "server-protocol");

      expect(error).toBeInstanceOf(ServerProtocolError);
    });

    it("reaches syncNow as a transport error caused by the HttpError", async () => {
      const { transport } = setup(() => reply(503));
      const client = openClient({ storage: clientMemoryStorage(), transport });

      const error = await failed(client.raw.syncNow(), "transport");

      expect(error.cause).toMatchObject({ status: 503, retryable: true });
    });
  });

  describe("timeout", () => {
    afterEach(() => {
      vi.useRealTimers();
    });

    it("aborts the signal and fails at timeoutMs even if fetch ignores the signal", async () => {
      vi.useFakeTimers();
      const { transport, call } = setup(neverReply, { timeoutMs: 1000 });

      const pulled = rejection(transport.pull(firstPull));
      await vi.advanceTimersByTimeAsync(999);
      const abortedEarly = call(0).init.signal.aborted;
      await vi.advanceTimersByTimeAsync(1);

      const error = await pulled;
      expect(error).toBeInstanceOf(HttpError);
      expect(error).toMatchObject({
        message: "Request failed: Timed out after 1000ms",
        status: null,
        retryable: true,
      });
      expect(abortedEarly).toBe(false);
      expect(call(0).init.signal.aborted).toBe(true);
    });

    it("times out a headers callback that never settles", async () => {
      vi.useFakeTimers();
      const { transport, fetch } = setup(() => reply(200, EMPTY_PAGE), {
        headers: () => new Promise<Record<string, string>>(() => {}),
        timeoutMs: 1000,
      });

      const pulled = rejection(transport.pull(firstPull));
      await vi.advanceTimersByTimeAsync(1000);

      const error = await pulled;
      expect(error).toBeInstanceOf(HttpError);
      expect(error).toMatchObject({ status: null, retryable: true });
      expect(fetch).not.toHaveBeenCalled();
    });

    it("clears its timer once the response arrives", async () => {
      vi.useFakeTimers();
      const { transport } = setup(() => reply(200, EMPTY_PAGE));

      await transport.pull(firstPull);

      expect(vi.getTimerCount()).toBe(0);
    });
  });

  describe("push splitting on 413", () => {
    it("splits in half until each batch fits, keeping the order", async () => {
      const deltas = [delta(1), delta(2), delta(3), delta(4)];
      const { transport, fetch } = setup((_url, init) =>
        pushedDeltas(init).length > 1
          ? reply(413, { code: "too-large", message: "Big" })
          : reply(204),
      );

      await transport.push({ nodeId: "node-a", deltas });

      const batches = fetch.mock.calls.map(([, init]) => pushedDeltas(init));
      const sizes = batches.map((batch) => batch.length);
      const accepted = batches.filter((batch) => batch.length === 1).flat();
      expect(sizes).toEqual([4, 2, 1, 1, 2, 1, 1]);
      expect(timestamps(accepted)).toEqual(timestamps(deltas));
    });

    it("fails without retry when a single delta is too large", async () => {
      const { transport, fetch } = setup(() => reply(413, { code: "too-large", message: "Big" }));

      const error = await rejection(transport.push({ nodeId: "node-a", deltas: [delta(1)] }));

      expect(error).toMatchObject({ status: 413, retryable: false });
      expect(fetch).toHaveBeenCalledTimes(1);
    });

    it("stops at the first half that fails", async () => {
      const { transport, fetch } = setup((_url, init) =>
        pushedDeltas(init).length > 1
          ? reply(413, { code: "too-large", message: "Big" })
          : reply(500),
      );

      const error = await rejection(
        transport.push({ nodeId: "node-a", deltas: [delta(1), delta(2)] }),
      );

      expect(error).toMatchObject({ status: 500 });
      expect(fetch).toHaveBeenCalledTimes(2);
    });
  });

  describe("configuration", () => {
    it.each([0, -1, Number.NaN, Infinity, 2_147_483_648])(
      "throws a ConfigError for timeoutMs %s",
      (timeoutMs) => {
        const create = () => httpTransport({ baseURL: BASE, fetch: vi.fn<WebFetch>(), timeoutMs });

        expect(create).toThrow(ConfigError);
      },
    );
  });
});
