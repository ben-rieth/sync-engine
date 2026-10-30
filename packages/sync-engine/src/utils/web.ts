// Fetch-standard globals ES2024 doesn't declare, typed structurally and looked up at runtime
import { ConfigError } from "#core/errors";

export type WebHeaders = { get(name: string): string | null };

export type WebResponse = {
  readonly status: number;
  readonly headers: WebHeaders;
  text(): Promise<string>;
};

/** `aborted` is declared only so tests can observe it. */
export type WebAbortSignal = { readonly aborted: boolean };

export type WebCredentials = "include" | "same-origin" | "omit";

export type WebRequestInit = {
  method: "GET" | "POST";
  headers: Record<string, string>;
  body?: string;
  credentials?: WebCredentials;
  redirect?: "error" | "manual" | "follow";
  signal: WebAbortSignal;
};

export type WebFetch = (url: string, init: WebRequestInit) => Promise<WebResponse>;

export type WebFetchGlobals = {
  fetch: WebFetch;
  AbortController: new () => { readonly signal: WebAbortSignal; abort(): void };
  setTimeout: (callback: () => void, ms: number) => unknown;
  clearTimeout: (id: unknown) => void;
};

export type WebGlobals = {
  URL: new (url: string) => { readonly pathname: string; readonly searchParams: WebHeaders };
  Response: new (
    body: string | null,
    init: { status: number; headers: Record<string, string> },
  ) => WebResponse;
  TextDecoder: new (
    label: string,
    options: { fatal: boolean },
  ) => { decode(bytes: Uint8Array): string };
};

export const webGlobals = (): WebGlobals => {
  // oxlint-disable-next-line typescript/no-unsafe-type-assertion -- checked for presence below
  const { URL, Response, TextDecoder } = globalThis as unknown as Partial<WebGlobals>;
  if (URL === undefined || Response === undefined || TextDecoder === undefined) {
    throw missingGlobals({ URL, Response, TextDecoder });
  }

  return { URL, Response, TextDecoder };
};

/** An injected `fetch` is used instead of the global one, which then needn't exist. */
export const webFetchGlobals = (injected?: WebFetch): WebFetchGlobals => {
  const { fetch, AbortController, setTimeout, clearTimeout } =
    // oxlint-disable-next-line typescript/no-unsafe-type-assertion -- checked for presence below
    globalThis as unknown as Partial<WebFetchGlobals>;
  const resolved = injected ?? fetch;
  if (
    resolved === undefined ||
    AbortController === undefined ||
    setTimeout === undefined ||
    clearTimeout === undefined
  ) {
    throw missingGlobals({ fetch: resolved, AbortController, setTimeout, clearTimeout });
  }

  // Unbound: browsers throw "Illegal invocation" when these are called on another object
  return {
    fetch: (url, init) => resolved(url, init),
    AbortController,
    setTimeout: (callback, ms) => setTimeout(callback, ms),
    clearTimeout: (id) => clearTimeout(id),
  };
};

const missingGlobals = (found: Record<string, unknown>): ConfigError => {
  const missing = Object.entries(found)
    .filter(([, value]) => value === undefined)
    .map(([name]) => name);
  return new ConfigError(`Missing fetch-standard globals: ${missing.join(", ")}`);
};
