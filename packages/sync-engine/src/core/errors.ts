import type { ErrorBody, ProtocolErrorCode } from "./protocol";

const messageOf = (cause: unknown): string =>
  cause instanceof Error ? cause.message : String(cause);

/** A failure public calls return as `{ error }`. Switch on `code` to narrow. */
export abstract class SyncError extends Error {
  abstract readonly code: string;
}

/** The library is set up or called wrongly. Always thrown. */
export class ConfigError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ConfigError";
  }
}

export type RowErrorCode = "row-exists" | "row-deleted" | "row-not-found" | "no-columns";

const rowErrorMessages: Record<RowErrorCode, (table: string, objectId: string) => string> = {
  "row-exists": (table, objectId) => `Row ${objectId} already exists in ${table}`,
  "row-deleted": (table, objectId) =>
    `Row ${objectId} in ${table} was deleted and its id cannot be reused`,
  "no-columns": (table) => `Cannot insert a row with no columns into ${table}`,
  "row-not-found": (table, objectId) => `Row ${objectId} not found in ${table}`,
};

export class RowError<C extends RowErrorCode = RowErrorCode> extends SyncError {
  readonly code: C;
  readonly table: string;
  readonly objectId: string;

  constructor(code: C, table: string, objectId: string) {
    super(rowErrorMessages[code](table, objectId));
    this.name = "RowError";
    this.code = code;
    this.table = table;
    this.objectId = objectId;
  }
}

export class TransportError extends SyncError {
  readonly code = "transport" as const;

  constructor(cause: unknown) {
    super(`Transport failed: ${messageOf(cause)}`, { cause });
    this.name = "TransportError";
  }
}

export class CorruptStorageError extends SyncError {
  readonly code = "corrupt-storage" as const;

  constructor(message: string) {
    super(message);
    this.name = "CorruptStorageError";
  }
}

/** Wraps any error the library did not anticipate, such as a storage adapter failure. */
export class UnexpectedError extends SyncError {
  readonly code = "unexpected" as const;

  constructor(cause: unknown) {
    super(`Unexpected error: ${messageOf(cause)}`, { cause });
    this.name = "UnexpectedError";
  }
}

const isRetryableStatus = (status: number): boolean =>
  status === 408 || status === 429 || status >= 500;

/** `httpTransport` throws this; the client returns it as a `TransportError` cause. */
export class HttpError extends SyncError {
  readonly code = "http" as const;
  /** `null` when no response arrived: a network error or timeout. */
  readonly status: number | null;
  readonly retryable: boolean;
  readonly serverCode: ProtocolErrorCode | null;

  private constructor(status: number | null, body: ErrorBody | null = null, cause?: unknown) {
    const detail = body === null ? "" : `: ${body.message}`;
    super(status === null ? `Request failed: ${messageOf(cause)}` : `HTTP ${status}${detail}`, {
      cause,
    });
    this.name = "HttpError";
    this.status = status;
    this.retryable = status === null || isRetryableStatus(status);
    this.serverCode = body?.code ?? null;
  }

  static network(cause: unknown): HttpError {
    return new HttpError(null, null, cause);
  }

  static response(status: number, body: ErrorBody | null): HttpError {
    return new HttpError(status, body);
  }
}

/** The server refused a push because another device owns the node id. Transports throw this. */
export class NodeClaimedError extends SyncError {
  readonly code = "node-claimed" as const;
  readonly nodeId: string;

  constructor(nodeId: string) {
    super(`Node ${nodeId} belongs to another device`);
    this.name = "NodeClaimedError";
    this.nodeId = nodeId;
  }
}
