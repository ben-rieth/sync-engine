import { ConfigError } from "#core/errors";
import { assertMaxDriftMs, DEFAULT_MAX_DRIFT_MS } from "#core/hlc/clock";
import {
  ERROR_STATUS,
  parsePullQuery,
  parsePushBody,
  PROTOCOL_HEADER,
  PROTOCOL_VERSION,
  type ErrorBody,
  type ProtocolErrorCode,
} from "#core/protocol";
import {
  InvalidCursorError,
  type PullRequest,
  type PullResult,
  type ServerDatabaseAdapter,
} from "#core/server/server";
import { depthExceeds, isRecord, quote } from "#utils/json";
import { fail, ok, type Parsed } from "#utils/parsed";
import { isNonEmptyString } from "#utils/string";
import { webGlobals, type WebHeaders, type WebResponse } from "#utils/web";

const MAX_JSON_DEPTH = 128;

type ByteReader = {
  read(): Promise<{ done: boolean; value?: Uint8Array }>;
  cancel(reason?: unknown): Promise<void>;
};

/** A fetch-standard `Request` satisfies this. */
export type SyncRequest = {
  readonly method: string;
  readonly url: string;
  readonly headers: WebHeaders;
  readonly body: { getReader(): ByteReader } | null;
};

/** A fetch-standard `Response` at runtime. */
export type SyncResponse = WebResponse;

export type SyncServerLimits = {
  maxPullLimit: number;
  maxPushDeltas: number;
  maxBodyBytes: number;
  maxDriftMs: number;
};

export type SyncServerHooks = {
  /** Called on unexpected failures; the client gets a generic 500. */
  onError?: (error: unknown, request: SyncRequest) => void | Promise<void>;
};

export type SyncServerOptions = {
  database: ServerDatabaseAdapter;
  getSession: (request: SyncRequest) => SyncSession | null | Promise<SyncSession | null>;
  basePath?: string;
  limits?: Partial<SyncServerLimits>;
  hooks?: SyncServerHooks;
  now?: () => number;
};

export type SyncServer = { handler: (request: SyncRequest) => Promise<SyncResponse> };

export type SyncSession = {
  userId: string;
  /** Must come from the authenticated credential (e.g. the session id), never from the request, and be unique per install. */
  deviceId: string;
};

const resolveLimits = ({
  maxPullLimit = 1000,
  maxPushDeltas = 1000,
  maxBodyBytes = 2_000_000,
  maxDriftMs = DEFAULT_MAX_DRIFT_MS,
}: Partial<SyncServerLimits>): SyncServerLimits => {
  const counts = { maxPullLimit, maxPushDeltas, maxBodyBytes };
  for (const [name, value] of Object.entries(counts)) {
    if (!Number.isSafeInteger(value) || value < 1) {
      throw new ConfigError(`Invalid server ${name}: ${value}`);
    }
  }
  assertMaxDriftMs(maxDriftMs, "server");

  return { ...counts, maxDriftMs };
};

const resolveBasePath = (basePath: string): string => {
  if (!basePath.startsWith("/")) {
    throw new ConfigError(`basePath must start with "/": ${basePath}`);
  }
  return basePath.replace(/\/+$/, "");
};

// `unknown` because a JavaScript host can return anything, e.g. `undefined`
const isSession = (session: unknown): session is SyncSession =>
  isRecord(session) && isNonEmptyString(session.userId) && isNonEmptyString(session.deviceId);

// `null` once past `maxBytes`, leaving the rest unread
const readBytes = async (
  body: SyncRequest["body"],
  maxBytes: number,
): Promise<Uint8Array | null> => {
  if (body === null) {
    return new Uint8Array(0);
  }

  const reader = body.getReader();
  const chunks: Uint8Array[] = [];
  let size = 0;
  let chunk = await reader.read();
  while (!chunk.done) {
    const value = chunk.value ?? new Uint8Array(0);
    size += value.byteLength;
    if (size > maxBytes) {
      // oxlint-disable-next-line no-await-in-loop -- runs once, right before returning
      await reader.cancel();
      return null;
    }
    chunks.push(value);
    // oxlint-disable-next-line no-await-in-loop -- a stream is read chunk by chunk
    chunk = await reader.read();
  }

  const bytes = new Uint8Array(size);
  let offset = 0;
  for (const value of chunks) {
    bytes.set(value, offset);
    offset += value.byteLength;
  }
  return bytes;
};

export const createSyncServer = ({
  database,
  getSession,
  basePath = "/api/sync",
  limits: limitOptions = {},
  hooks = {},
  now = Date.now,
}: SyncServerOptions): SyncServer => {
  const web = webGlobals();
  const limits = resolveLimits(limitOptions);
  const base = resolveBasePath(basePath);
  const decoder = new web.TextDecoder("utf-8", { fatal: true });

  const reply = (status: number, body?: PullResult | ErrorBody): SyncResponse =>
    body === undefined
      ? new web.Response(null, { status, headers: { "cache-control": "no-store" } })
      : new web.Response(JSON.stringify(body), {
          status,
          headers: { "cache-control": "no-store", "content-type": "application/json" },
        });

  const refuse = (code: ProtocolErrorCode, message: string, skewMs?: number): SyncResponse =>
    reply(ERROR_STATUS[code], { code, message, skewMs });

  const parseJson = (bytes: Uint8Array): Parsed<unknown> => {
    try {
      const json: unknown = JSON.parse(decoder.decode(bytes));
      return depthExceeds(json, MAX_JSON_DEPTH) ? fail("Body is nested too deeply") : ok(json);
    } catch {
      return fail("Body must be UTF-8 JSON");
    }
  };

  const routeOf = (method: string, pathname: string): "push" | "pull" | null => {
    if (method === "POST" && pathname === `${base}/push`) {
      return "push";
    }
    if (method === "GET" && pathname === `${base}/pull`) {
      return "pull";
    }
    return null;
  };

  const push = async (request: SyncRequest, session: SyncSession): Promise<SyncResponse> => {
    const tooLarge = `Body is larger than ${limits.maxBodyBytes} bytes`;
    const length = request.headers.get("content-length");
    if (length !== null && Number(length) > limits.maxBodyBytes) {
      return refuse("too-large", tooLarge);
    }
    const bytes = await readBytes(request.body, limits.maxBodyBytes);
    if (bytes === null) {
      return refuse("too-large", tooLarge);
    }

    const json = parseJson(bytes);
    if (!json.ok) {
      return refuse("bad-request", json.reason);
    }
    const body = parsePushBody(json.value);
    if (!body.ok) {
      return refuse("bad-request", body.reason);
    }
    const { nodeId, deltas, timestamps } = body.value;

    if (deltas.length > limits.maxPushDeltas) {
      return refuse("too-large", `A push holds at most ${limits.maxPushDeltas} deltas`);
    }
    if (timestamps.some((timestamp) => timestamp.nodeId !== nodeId)) {
      return refuse("node-mismatch", `Every timestamp must come from node ${quote(nodeId)}`);
    }

    let newest = -Infinity;
    for (const timestamp of timestamps) {
      newest = Math.max(newest, timestamp.physicalTime);
    }
    const skewMs = newest - now();
    if (skewMs > limits.maxDriftMs) {
      return refuse("clock-ahead", `Timestamps are ${skewMs}ms ahead of server time`, skewMs);
    }

    if (deltas.length > 0) {
      // After every other check, so a refused push claims nothing
      const owned = await database.claimNode(session.userId, nodeId, session.deviceId);
      if (!owned) {
        return refuse("node-claimed", `Node ${quote(nodeId)} belongs to another device`);
      }

      await database.push(session.userId, deltas);
    }
    return reply(204);
  };

  const pullPage = async (userId: string, request: PullRequest): Promise<PullResult | null> => {
    try {
      return await database.pull(userId, request);
    } catch (error) {
      if (error instanceof InvalidCursorError) {
        return null;
      }
      throw error;
    }
  };

  const pull = async (params: WebHeaders, userId: string): Promise<SyncResponse> => {
    const query = parsePullQuery(params);
    if (!query.ok) {
      return refuse("bad-request", query.reason);
    }
    const { nodeId, cursor, limit } = query.value;

    const page = await pullPage(userId, {
      cursor,
      excludeNodeId: nodeId,
      limit: Math.min(limit ?? limits.maxPullLimit, limits.maxPullLimit),
    });
    if (page === null) {
      return refuse("bad-request", "Invalid cursor");
    }
    return reply(200, { deltas: page.deltas, cursor: page.cursor, hasMore: page.hasMore });
  };

  const handle = async (request: SyncRequest): Promise<SyncResponse> => {
    const url = new web.URL(request.url);
    const route = routeOf(request.method, url.pathname);
    if (route === null) {
      return refuse("not-found", "Unknown sync route");
    }
    // Before auth: the custom header forces a CORS preflight, so a cross-site form can't push
    if (request.headers.get(PROTOCOL_HEADER) !== String(PROTOCOL_VERSION)) {
      return refuse("protocol", `Expected ${PROTOCOL_HEADER}: ${PROTOCOL_VERSION}`);
    }
    const session = await getSession(request);
    if (!isSession(session)) {
      return refuse("unauthorized", "Not signed in");
    }

    return route === "push" ? push(request, session) : pull(url.searchParams, session.userId);
  };

  const report = async (error: unknown, request: SyncRequest) => {
    try {
      await hooks.onError?.(error, request);
    } catch {
      // A failing reporter must not replace the 500
    }
  };

  return {
    handler: async (request) => {
      try {
        return await handle(request);
      } catch (error) {
        await report(error, request);
        return refuse("internal", "Internal error");
      }
    },
  };
};
