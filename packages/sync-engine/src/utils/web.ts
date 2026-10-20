// Fetch-standard globals ES2024 doesn't declare, typed structurally and looked up at runtime
import { ConfigError } from "#core/errors";

export type WebHeaders = { get(name: string): string | null };

export type WebResponse = {
  readonly status: number;
  readonly headers: WebHeaders;
  text(): Promise<string>;
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
    const missing = Object.entries({ URL, Response, TextDecoder })
      .filter(([, value]) => value === undefined)
      .map(([name]) => name);
    throw new ConfigError(`Missing fetch-standard globals: ${missing.join(", ")}`);
  }

  return { URL, Response, TextDecoder };
};
