import type { WireDelta } from "./delta";
import { isValidNodeId } from "./hlc/node-id";
import { HLCTimestamp } from "./hlc/timestamp";
import type { PullResult } from "./server/server";
import { isRecord, quote } from "#utils/json";
import { fail, ok, type Parsed } from "#utils/parsed";

export const PROTOCOL_VERSION = 1;
export const PROTOCOL_HEADER = "x-sync-protocol";

export type PushBody = { nodeId: string; deltas: WireDelta[] };
export type PullQuery = { nodeId: string; cursor: string | null; limit: number | null };

export const ERROR_STATUS = {
  "not-found": 404,
  protocol: 409,
  unauthorized: 401,
  "too-large": 413,
  "bad-request": 400,
  "node-mismatch": 400,
  "clock-ahead": 409,
  internal: 500,
} as const;

export type ProtocolErrorCode = keyof typeof ERROR_STATUS;
export type ErrorBody = { code: ProtocolErrorCode; message: string; skewMs?: number };

const DIGITS = /^\d+$/;

const isErrorCode = (value: unknown): value is ProtocolErrorCode =>
  typeof value === "string" && Object.hasOwn(ERROR_STATUS, value);

const isWireDelta = (value: unknown): value is WireDelta =>
  isRecord(value) && typeof value.timestamp === "string";

const parseWireDeltas = (
  value: unknown,
): Parsed<{ deltas: WireDelta[]; timestamps: HLCTimestamp[] }> => {
  if (!Array.isArray(value)) {
    return fail("deltas must be an array");
  }

  const deltas: WireDelta[] = [];
  const timestamps: HLCTimestamp[] = [];
  for (const delta of value) {
    if (!isWireDelta(delta)) {
      return fail("Each delta must be an object with a string timestamp");
    }
    const timestamp = HLCTimestamp.tryParse(delta.timestamp);
    if (!timestamp) {
      return fail(`Invalid timestamp: ${quote(delta.timestamp)}`);
    }
    deltas.push(delta);
    timestamps.push(timestamp);
  }

  return ok({ deltas, timestamps });
};

export const parsePushBody = (json: unknown): Parsed<PushBody & { timestamps: HLCTimestamp[] }> => {
  if (!isRecord(json)) {
    return fail("Body must be an object");
  }
  const { nodeId } = json;
  if (typeof nodeId !== "string" || !isValidNodeId(nodeId)) {
    return fail("nodeId must be a valid node id");
  }

  const parsed = parseWireDeltas(json.deltas);
  if (!parsed.ok) {
    return parsed;
  }
  return ok({ nodeId, ...parsed.value });
};

const parseLimit = (raw: string | null): Parsed<number | null> => {
  if (raw === null) {
    return ok(null);
  }

  const limit = Math.min(Number(raw), Number.MAX_SAFE_INTEGER);
  if (!DIGITS.test(raw) || limit < 1) {
    return fail(`limit must be a positive integer: ${quote(raw)}`);
  }
  return ok(limit);
};

export const parsePullQuery = (params: { get(name: string): string | null }): Parsed<PullQuery> => {
  const nodeId = params.get("nodeId");
  if (nodeId === null || !isValidNodeId(nodeId)) {
    return fail("nodeId must be a valid node id");
  }

  const cursor = params.get("cursor");
  if (cursor === "") {
    return fail("cursor must not be empty");
  }

  const limit = parseLimit(params.get("limit"));
  if (!limit.ok) {
    return limit;
  }
  return ok({ nodeId, cursor, limit: limit.value });
};

export const parsePullResponse = (json: unknown): Parsed<PullResult> => {
  if (!isRecord(json)) {
    return fail("Pull response must be an object");
  }
  const { cursor, hasMore } = json;
  if (cursor !== null && typeof cursor !== "string") {
    return fail("cursor must be a string or null");
  }
  if (typeof hasMore !== "boolean") {
    return fail("hasMore must be a boolean");
  }
  if (hasMore && cursor === null) {
    return fail("hasMore needs a cursor to continue from");
  }

  const parsed = parseWireDeltas(json.deltas);
  if (!parsed.ok) {
    return parsed;
  }
  return ok({ deltas: parsed.value.deltas, cursor, hasMore });
};

export const parseErrorBody = (json: unknown): ErrorBody | null => {
  if (!isRecord(json)) {
    return null;
  }
  const { code, message, skewMs } = json;
  if (!isErrorCode(code) || typeof message !== "string") {
    return null;
  }

  if (skewMs === undefined) {
    return { code, message };
  }
  return typeof skewMs === "number" ? { code, message, skewMs } : null;
};
