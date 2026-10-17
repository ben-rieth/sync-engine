import type { CellRef, Delta, DeltaKey } from "./delta";
import type { ObjectKey, ObjectRef } from "./object";

export type { CellRef } from "./delta";
export type { ObjectRef } from "./object";

/** Keys the engine stores in adapter-owned metadata. Values are opaque strings to the adapter. */
export type MetaKey = "nodeId" | "cursor" | "clock" | "userId";

/**
 * Operations available inside a single storage transaction.
 *
 * Every method must run against the transaction it was created for, so all reads see the
 * transaction's own earlier writes and all writes commit or roll back together.
 * Methods must not be called after the transaction has finished.
 */
export type StorageTx = {
  /** The application's own synced tables. Rows are keyed by an `id` field equal to `objectId`. */
  rows: {
    /**
     * Returns the row with this id, or `undefined` if it does not exist.
     * The returned object must be a copy: mutating it must not change stored data.
     */
    get(table: string, objectId: string): Promise<Record<string, unknown> | undefined>;
    /**
     * Merges `patch` into the row with this id, leaving columns not in `patch` unchanged.
     * Creates the row as `{ id: objectId, ...patch }` if it does not exist.
     * The row's `id` must always equal `objectId`, even if `patch` contains an `id`.
     */
    upsert(table: string, objectId: string, patch: Record<string, unknown>): Promise<void>;
    /** Deletes the row with this id. Does nothing if it does not exist. */
    delete(table: string, objectId: string): Promise<void>;
  };

  /** Local deltas that have not yet been pushed to the server. */
  outbox: {
    /**
     * Stores newly created local deltas. Timestamps are unique per delta;
     * adding a timestamp that already exists in the outbox is a bug and may throw.
     */
    add(deltas: Delta[]): Promise<void>;
    /** Returns pending deltas ordered by timestamp, oldest first, up to `limit` if given. */
    list(limit?: number): Promise<Delta[]>;
    /** Returns the number of pending deltas. */
    count(): Promise<number>;
    /**
     * Called after a successful push. Removes the deltas with these timestamps from the outbox
     * and adds them to history. Timestamps not in the outbox are ignored.
     */
    moveToHistory(timestamps: string[]): Promise<void>;
  };

  /** Every delta this device has applied or pushed. Used for last-writer-wins decisions and deduplication. */
  history: {
    /**
     * Stores deltas received from the server. Must be idempotent: deltas whose timestamp is
     * already in history are skipped, not overwritten and not an error.
     */
    add(deltas: Delta[]): Promise<void>;
    /** Returns the subset of `timestamps` that are already stored in history. */
    has(timestamps: string[]): Promise<Set<string>>;
  };

  /**
   * Returns the newest timestamp for each requested cell, looking at both history and the outbox.
   * Only `set` deltas count; deletes are reported by `deleted`.
   * Map keys must be built with `deltaKey`. Cells with no deltas are omitted from the map.
   * Including the outbox is required: it stops older remote deltas from overwriting newer
   * local edits that have not been pushed yet.
   */
  latest(cells: CellRef[]): Promise<Map<DeltaKey, string>>;

  /**
   * Returns the subset of `objects` that have a delete delta in history or the outbox.
   * Set entries must be built with `objectKey`.
   * Including the outbox is required: a local delete that has not been pushed yet is still final,
   * so remote deltas for that object must not bring it back.
   */
  deleted(objects: ObjectRef[]): Promise<Set<ObjectKey>>;

  /** Small key-value store for engine state (node id, pull cursor, clock, current user). */
  meta: {
    /** Returns the stored value, or `undefined` if the key has never been set. */
    get(key: MetaKey): Promise<string | undefined>;
    /** Stores the value, replacing any existing value for the key. */
    set(key: MetaKey, value: string): Promise<void>;
  };
};

/** `read` transactions may not write; `readwrite` transactions may read and write. */
export type TransactionMode = "read" | "readwrite";

export type StorageAdapter = {
  /**
   * Runs `fn` inside a transaction and returns its result.
   *
   * - Atomic: if `fn` throws, every write it made is rolled back and the error is rethrown.
   * - Isolated: `readwrite` transactions must not interleave with each other.
   * - In `read` mode, write methods may throw.
   * - Must not be called from inside `fn`: nested transactions are not supported and may deadlock.
   *
   * `fn` should only await `tx` methods. Awaiting other async work (network, crypto, timers)
   * can commit the transaction early in some databases, such as IndexedDB.
   *
   * Adapters that must declare a transaction's scope up front (such as IndexedDB) must configure
   * it when the adapter is created. Adapters may treat every transaction as `readwrite`: that is
   * always correct, just less concurrent.
   */
  transaction<T>(mode: TransactionMode, fn: (tx: StorageTx) => Promise<T>): Promise<T>;
};
