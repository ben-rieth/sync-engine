import type { CellRef, Delta, DeltaKey } from "./delta";
import type { ObjectKey, ObjectRef } from "./object";

export type { CellRef } from "./delta";
export type { ObjectRef } from "./object";

/** Engine metadata keys. Values are opaque to the adapter. */
export type MetaKey = "nodeId" | "cursor" | "clock" | "userId";

/**
 * Operations bound to one transaction: reads see its earlier writes, and writes commit or roll
 * back together. Methods must not be called after the transaction finishes.
 */
export type StorageTx = {
  /** The application's own synced tables. Rows are keyed by an `id` field equal to `objectId`. */
  rows: {
    /** Returns a copy of the row: mutating it must not change stored data. */
    get(table: string, objectId: string): Promise<Record<string, unknown> | undefined>;
    /**
     * Merges `patch` into the row, or creates `{ id: objectId, ...patch }` if missing.
     * The row's `id` must stay `objectId` even if `patch` contains an `id`.
     */
    upsert(table: string, objectId: string, patch: Record<string, unknown>): Promise<void>;
    /** Does nothing if the row does not exist. */
    delete(table: string, objectId: string): Promise<void>;
  };

  /** Local deltas that have not yet been pushed to the server. */
  outbox: {
    /** Adding a timestamp already in the outbox is a bug and may throw. */
    add(deltas: Delta[]): Promise<void>;
    /** Oldest timestamp first. */
    list(limit?: number): Promise<Delta[]>;
    count(): Promise<number>;
    /** Called after a successful push. Timestamps not in the outbox are ignored. */
    moveToHistory(timestamps: string[]): Promise<void>;
  };

  /** Every delta this device has applied or pushed, for last-writer-wins and deduplication. */
  history: {
    /** Idempotent: deltas whose timestamp is already in history are skipped, not overwritten. */
    add(deltas: Delta[]): Promise<void>;
    /** Returns the subset of `timestamps` already in history. */
    has(timestamps: string[]): Promise<Set<string>>;
  };

  /**
   * Newest `set` timestamp per cell across history and the outbox, keyed by `deltaKey`. Cells
   * with no deltas are omitted. The outbox stops older remote deltas overwriting unpushed edits.
   */
  latest(cells: CellRef[]): Promise<Map<DeltaKey, string>>;

  /**
   * Keys (from `objectKey`) of `objects` with a delete delta in history or the outbox. The outbox
   * keeps remote deltas from reviving an unpushed local delete.
   */
  deleted(objects: ObjectRef[]): Promise<Set<ObjectKey>>;

  meta: {
    get(key: MetaKey): Promise<string | undefined>;
    set(key: MetaKey, value: string): Promise<void>;
  };
};

export type TransactionMode = "read" | "readwrite";

export type StorageAdapter = {
  /**
   * - Atomic: if `fn` throws, its writes roll back and the error is rethrown.
   * - Isolated: `readwrite` transactions must not interleave.
   * - In `read` mode, write methods may throw.
   * - Not reentrant: calling it inside `fn` may deadlock.
   *
   * `fn` should only await `tx` methods: awaiting other work (network, crypto, timers) can
   * commit the transaction early in some databases, such as IndexedDB.
   *
   * Adapters that declare scope up front (IndexedDB) configure it at creation. Treating every
   * transaction as `readwrite` is always correct, just less concurrent.
   */
  transaction<T>(mode: TransactionMode, fn: (tx: StorageTx) => Promise<T>): Promise<T>;
};
