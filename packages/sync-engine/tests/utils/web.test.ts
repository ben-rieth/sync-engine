import { afterEach, describe, expect, it, vi } from "vitest";
import { ConfigError } from "#core/errors";
import { webGlobals } from "#utils/web";

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
