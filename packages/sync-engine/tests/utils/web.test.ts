import { afterEach, describe, expect, it, vi } from "vitest";
import { ConfigError } from "#core/errors";
import {
  webFetchGlobals,
  webGlobals,
  type WebFetch,
  type WebRequestInit,
  type WebResponse,
} from "#utils/web";

describe("webGlobals", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("returns the runtime's fetch-standard globals", () => {
    const globals = webGlobals();

    expect(globals).toEqual({
      URL: Reflect.get(globalThis, "URL"),
      Response: Reflect.get(globalThis, "Response"),
      TextDecoder: Reflect.get(globalThis, "TextDecoder"),
    });
  });

  it("throws a ConfigError when a global is missing", () => {
    vi.stubGlobal("Response", undefined);

    expect(webGlobals).toThrow(ConfigError);
  });

  it("names every missing global", () => {
    vi.stubGlobal("URL", undefined);
    vi.stubGlobal("TextDecoder", undefined);

    expect(webGlobals).toThrow("Missing fetch-standard globals: URL, TextDecoder");
  });
});

describe("webFetchGlobals", () => {
  const response: WebResponse = { status: 204, headers: { get: () => null }, text: async () => "" };

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("returns the runtime's AbortController", () => {
    const globals = webFetchGlobals();

    expect(globals.AbortController).toBe(Reflect.get(globalThis, "AbortController"));
  });

  it("calls the global timers unbound", () => {
    const setTimeout = vi.fn<(this: unknown) => unknown>(function () {
      return this === undefined ? 7 : null;
    });
    const clearTimeout = vi.fn<(this: unknown, id: unknown) => void>();
    vi.stubGlobal("setTimeout", setTimeout);
    vi.stubGlobal("clearTimeout", clearTimeout);
    const globals = webFetchGlobals(vi.fn<WebFetch>());

    const id = globals.setTimeout(() => {}, 10);
    globals.clearTimeout(id);

    expect(id).toBe(7);
    expect(clearTimeout).toHaveBeenCalledWith(7);
    expect(clearTimeout.mock.contexts).toEqual([undefined]);
  });

  it("uses an injected fetch when there is no global one", async () => {
    vi.stubGlobal("fetch", undefined);
    const fetch = vi.fn<WebFetch>(async () => response);
    const init: WebRequestInit = { method: "GET", headers: {}, signal: { aborted: false } };

    await webFetchGlobals(fetch).fetch("http://localhost/api/sync/pull", init);

    expect(fetch).toHaveBeenCalledWith("http://localhost/api/sync/pull", init);
  });

  it("calls the global fetch, unbound, with the same arguments", async () => {
    const fetch = vi.fn<(this: unknown, ...args: Parameters<WebFetch>) => Promise<WebResponse>>(
      function () {
        return this === undefined ? Promise.resolve(response) : Promise.reject(new Error("bound"));
      },
    );
    vi.stubGlobal("fetch", fetch);
    const init: WebRequestInit = { method: "GET", headers: {}, signal: { aborted: false } };

    const result = await webFetchGlobals().fetch("http://localhost/api/sync/pull", init);

    expect(result).toBe(response);
    expect(fetch).toHaveBeenCalledWith("http://localhost/api/sync/pull", init);
  });

  it("throws a ConfigError when fetch is missing", () => {
    vi.stubGlobal("fetch", undefined);

    expect(webFetchGlobals).toThrow(ConfigError);
  });

  it("names every missing global", () => {
    vi.stubGlobal("fetch", undefined);
    vi.stubGlobal("AbortController", undefined);
    vi.stubGlobal("clearTimeout", undefined);

    expect(webFetchGlobals).toThrow(
      "Missing fetch-standard globals: fetch, AbortController, clearTimeout",
    );
  });
});
