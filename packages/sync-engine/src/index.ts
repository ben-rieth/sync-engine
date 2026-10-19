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
  type CreateError,
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
} from "./core/delta";
export { objectKey, type ObjectKey, type ObjectRef } from "./core/object";

export type { MetaKey, StorageAdapter, StorageTx, TransactionMode } from "./core/storage";
export {
  ServerProtocolError,
  type PullRequest,
  type PullResult,
  type ServerDatabaseAdapter,
} from "./core/server/server";
export type { Transport } from "./core/server/transport";
