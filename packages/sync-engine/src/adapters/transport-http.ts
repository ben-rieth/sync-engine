import type { WireDelta } from "#core/delta";
import { ConfigError, HttpError, NodeClaimedError } from "#core/errors";
import { LocalClockAheadError } from "#core/hlc/clock";
import {
  parseErrorBody,
  PROTOCOL_HEADER,
  PROTOCOL_VERSION,
  requirePullResponse,
} from "#core/protocol";
import type { Transport } from "#core/server/transport";
import {
  webFetchGlobals,
  type WebCredentials,
  type WebFetch,
  type WebRequestInit,
} from "#utils/web";

export type HttpTransportOptions = {
  /** The server's URL including its `basePath`, e.g. `https://app.test/api/sync`. */
  baseURL: string;
  /** Called before every request, e.g. for an `Authorization` header. */
  headers?: () => Record<string, string> | Promise<Record<string, string>>;
  credentials?: WebCredentials;
  /** Per request, including reading the response. Default 30 seconds. */
  timeoutMs?: number;
  fetch?: WebFetch;
};

type Reply = { status: number; text: string };

const DEFAULT_TIMEOUT_MS = 30_000;
const MAX_TIMEOUT_MS = 2_147_483_647;

/** Makes one attempt per call; retrying belongs to the caller. */
export const httpTransport = (options: HttpTransportOptions): Transport => {
  const { headers, credentials, timeoutMs = DEFAULT_TIMEOUT_MS } = options;
  if (!(Number.isFinite(timeoutMs) && timeoutMs > 0 && timeoutMs <= MAX_TIMEOUT_MS)) {
    throw new ConfigError(`Invalid timeoutMs: ${timeoutMs}`);
  }
  const { fetch, AbortController, setTimeout, clearTimeout } = webFetchGlobals(options.fetch);
  const base = options.baseURL.replace(/\/+$/, "");

  const startTimeout = () => {
    const controller = new AbortController();
    let timer: unknown;
    // Rejects on its own too, in case a runtime's fetch ignores the signal
    const expired = new Promise<never>((_resolve, reject) => {
      timer = setTimeout(() => {
        controller.abort();
        reject(new Error(`Timed out after ${timeoutMs}ms`));
      }, timeoutMs);
    });
    return { signal: controller.signal, expired, cancel: () => clearTimeout(timer) };
  };

  const send = async (
    method: WebRequestInit["method"],
    path: string,
    body?: string,
  ): Promise<Reply> => {
    const timeout = startTimeout();
    const attempt = async (): Promise<Reply> => {
      const extra = await headers?.();
      if (timeout.signal.aborted) {
        throw new Error("Aborted");
      }
      const init: WebRequestInit = {
        method,
        headers: {
          ...lowerCaseKeys(extra ?? {}),
          ...(body === undefined ? {} : { "content-type": "application/json" }),
          [PROTOCOL_HEADER]: String(PROTOCOL_VERSION),
        },
        body,
        credentials,
        redirect: "error",
        signal: timeout.signal,
      };

      const url = `${base}${path}`;
      const response = await fetch(url, init);
      const text = await response.text();
      return { status: response.status, text };
    };

    try {
      const reply = await Promise.race([attempt(), timeout.expired]);
      return reply;
    } catch (error) {
      throw HttpError.network(error);
    } finally {
      timeout.cancel();
    }
  };

  const pushDeltas = async (nodeId: string, deltas: WireDelta[]): Promise<void> => {
    const reply = await send("POST", "/push", JSON.stringify({ nodeId, deltas }));
    if (reply.status === 204) {
      return;
    }
    if (reply.status === 413 && deltas.length > 1) {
      const middle = Math.ceil(deltas.length / 2);
      await pushDeltas(nodeId, deltas.slice(0, middle));
      await pushDeltas(nodeId, deltas.slice(middle));
      return;
    }
    throw refusal(reply, nodeId);
  };

  const transport: Transport = {
    pull: async ({ cursor, nodeId, limit }) => {
      const query = [`nodeId=${encodeURIComponent(nodeId)}`, `limit=${limit}`];
      if (cursor !== null) {
        query.push(`cursor=${encodeURIComponent(cursor)}`);
      }

      const reply = await send("GET", `/pull?${query.join("&")}`);
      if (!isSuccess(reply.status)) {
        throw refusal(reply, null);
      }
      return requirePullResponse(parseJson(reply.text));
    },

    push: ({ nodeId, deltas }) => pushDeltas(nodeId, deltas),
  };

  return transport;
};

const lowerCaseKeys = (headers: Record<string, string>): Record<string, string> =>
  Object.fromEntries(Object.entries(headers).map(([name, value]) => [name.toLowerCase(), value]));

const isSuccess = (status: number): boolean => status >= 200 && status < 300;

const parseJson = (text: string): unknown => {
  try {
    return JSON.parse(text);
  } catch {
    return undefined;
  }
};

const refusal = ({ status, text }: Reply, pushedNodeId: string | null): Error => {
  const body = parseErrorBody(parseJson(text));
  if (body?.code === "clock-ahead" && body.skewMs !== undefined) {
    return new LocalClockAheadError(body.skewMs);
  }
  if (body?.code === "node-claimed" && pushedNodeId !== null) {
    return new NodeClaimedError(pushedNodeId);
  }
  return HttpError.response(status, body);
};
