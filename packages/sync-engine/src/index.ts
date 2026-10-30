export { HLCTimestamp } from "./core/hlc/timestamp";
export {
  HybridLogicalClock,
  ClockDriftError,
  LocalClockAheadError,
  DEFAULT_MAX_DRIFT_MS,
  assertMaxDriftMs,
  assertWithinDrift,
  type HybridLogicalClockOptions,
} from "./core/hlc/clock";

export {
  createSyncClient,
  type DeleteError,
  type InsertError,
  type InsertOptions,
  type SyncClient,
  type SyncClientOptions,
  type SyncNowError,
  type UpdateError,
} from "./core/client/client";

export {
  ConfigError,
  CorruptStorageError,
  HttpError,
  NodeClaimedError,
  RowError,
  SyncError,
  TransportError,
  UnexpectedError,
  type RowErrorCode,
} from "./core/errors";
export type { Result } from "./core/result";

export {
  deltaKey,
  type CellRef,
  type DeleteDelta,
  type Delta,
  type DeltaKey,
  type SetDelta,
  type WireDelta,
} from "./core/delta";
export {
  PROTOCOL_HEADER,
  PROTOCOL_VERSION,
  type ErrorBody,
  type ProtocolErrorCode,
  type PushBody,
} from "./core/protocol";
export { objectKey, type ObjectKey, type ObjectRef } from "./core/object";

export type { MetaKey, StorageAdapter, StorageTx, TransactionMode } from "./core/storage";
export {
  InvalidCursorError,
  ServerProtocolError,
  type PullRequest,
  type PullResult,
  type ServerDatabaseAdapter,
} from "./core/server/server";
export {
  createSyncServer,
  type SyncRequest,
  type SyncResponse,
  type SyncServer,
  type SyncServerHooks,
  type SyncServerLimits,
  type SyncServerOptions,
  type SyncSession,
} from "./core/server/sync-server";
export type { Transport } from "./core/server/transport";
