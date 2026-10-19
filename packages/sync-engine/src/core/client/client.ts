import type { Delta } from "../delta";
import {
  ConfigError,
  CorruptStorageError,
  RowError,
  TransportError,
  type UnexpectedError,
} from "../errors";
import {
  assertMaxDriftMs,
  ClockDriftError,
  HybridLogicalClock,
  LocalClockAheadError,
} from "../hlc/clock";
import { isValidNodeId } from "../hlc/node-id";
import { HLCTimestamp } from "../hlc/timestamp";
import { toResult, type Result } from "../result";
import { ServerProtocolError, type PullResult } from "../server/server";
import type { Transport } from "../server/transport";
import { applyRemoteDeltas } from "./apply";
import { requireRandomUUID } from "./id";
import type { StorageAdapter, StorageTx } from "../storage";
import { jsonEqual } from "#utils/json";

export type SyncClientOptions = {
  storage: StorageAdapter;
  /**
   * Generates ids for new rows. Defaults to `crypto.randomUUID()`.
   * Must never return a deleted row's id: generated ids are not checked against deletes.
   */
  generateId?: () => string;
  /** Generates this device's node id on first start. Defaults to `crypto.randomUUID()`. */
  generateNodeId?: () => string;
  now?: () => number;
  /** How far ahead of local time a remote timestamp may be before pulling stops. Default 5 minutes. */
  maxDriftMs?: number;
  /** Connection to the sync server. Without one the client works offline only. */
  transport?: Transport;
  /** Maximum deltas requested per pull. Default 1000. */
  pullLimit?: number;
  /** Maximum deltas sent per push. Default 500. */
  pushBatchSize?: number;
};

export type InsertOptions = {
  /** Use this id instead of generating one. Must not belong to an existing or deleted row. */
  id?: string;
};

type WriteError = CorruptStorageError | UnexpectedError;

export type CreateError = CorruptStorageError | UnexpectedError;
export type InsertError = RowError<"row-exists" | "row-deleted" | "no-columns"> | WriteError;
export type UpdateError = RowError<"row-not-found"> | WriteError;
export type DeleteError = WriteError;
export type SyncNowError =
  | TransportError
  | LocalClockAheadError
  | ClockDriftError
  | ServerProtocolError
  | WriteError;

/** Methods return failures as `{ error }` and reject only with `ConfigError`. */
export type SyncClient = {
  nodeId: string;
  /**
   * Creates a row and records one delta per column. `id` and `undefined` values are ignored;
   * use `null` to store an empty value. Returns the row's id.
   */
  insert(
    table: string,
    values: Record<string, unknown>,
    options?: InsertOptions,
  ): Promise<Result<string, InsertError>>;
  /**
   * Records one delta per column whose value changed. `id` and `undefined` values are ignored;
   * use `null` to clear a column. Does nothing if no column changed.
   */
  update(
    table: string,
    objectId: string,
    patch: Record<string, unknown>,
  ): Promise<Result<void, UpdateError>>;
  /** Deletes the row and records a delete delta. Does nothing if the row does not exist. */
  delete(table: string, objectId: string): Promise<Result<void, DeleteError>>;
  /**
   * Pulls deltas from other nodes until the server has no more, then pushes the outbox until it is
   * empty. Each pulled page and its cursor commit together, so an interrupted sync resumes where it
   * stopped. Pushed deltas move to history only after the server accepts them; a push that fails or
   * loses its reply is sent again by the next sync, and the server ignores the repeat.
   *
   * Earlier pages and batches stay done; the failing one does not. Nothing is pushed if the pull
   * fails. Throws `ConfigError` without a transport.
   *
   * Only one sync runs at a time. A call made while one is running waits for it, then shares a
   * single follow-up sync with every other call made meanwhile, so each call resolves only after a
   * sync that started after it. The follow-up runs even if the earlier sync failed.
   */
  syncNow(): Promise<Result<void, SyncNowError>>;
};

type Fetched = { from: string | undefined; page: PullResult };
type Saved = { applied: boolean; cursor: string | undefined };

type WriteContext = {
  tx: StorageTx;
  tick: () => string;
  receive: (timestamp: string) => void;
};

const columnsOf = (values: Record<string, unknown>): Record<string, unknown> =>
  Object.fromEntries(
    Object.entries(values).filter(([column, value]) => column !== "id" && value !== undefined),
  );

const ownValue = (record: Record<string, unknown>, key: string): unknown =>
  Object.hasOwn(record, key) ? record[key] : undefined;

const changedColumns = (
  current: Record<string, unknown>,
  patch: Record<string, unknown>,
): Record<string, unknown> =>
  Object.fromEntries(
    Object.entries(columnsOf(patch)).filter(
      ([column, value]) => !jsonEqual(value, ownValue(current, column)),
    ),
  );

const setDeltas = (
  table: string,
  objectId: string,
  columns: Record<string, unknown>,
  tick: () => string,
): Delta[] =>
  Object.entries(columns).map(([column, value]) => ({
    kind: "set",
    timestamp: tick(),
    table,
    objectId,
    column,
    value,
  }));

type ResolvedOptions = SyncClientOptions & {
  generateId: () => string;
  generateNodeId: () => string;
  pullLimit: number;
  pushBatchSize: number;
};

/** Throws `ConfigError` for invalid options; returns other failures, like storage not opening. */
export const createSyncClient = async (
  options: SyncClientOptions,
): Promise<Result<SyncClient, CreateError>> => {
  const pullLimit = options.pullLimit ?? 1000;
  if (!Number.isSafeInteger(pullLimit) || pullLimit < 1) {
    throw new ConfigError(`Invalid pullLimit: ${pullLimit}`);
  }
  const pushBatchSize = options.pushBatchSize ?? 500;
  if (!Number.isSafeInteger(pushBatchSize) || pushBatchSize < 1) {
    throw new ConfigError(`Invalid pushBatchSize: ${pushBatchSize}`);
  }
  const { maxDriftMs } = options;
  if (maxDriftMs !== undefined) {
    assertMaxDriftMs(maxDriftMs, "client");
  }
  const generateId = options.generateId ?? requireRandomUUID();
  const generateNodeId = options.generateNodeId ?? requireRandomUUID();

  return toResult(() =>
    openClient({ ...options, generateId, generateNodeId, pullLimit, pushBatchSize }),
  );
};

const openClient = async (options: ResolvedOptions): Promise<SyncClient> => {
  const { storage, generateId, generateNodeId, pullLimit, pushBatchSize } = options;

  // readwrite so two tabs starting at once agree on a single node id
  const nodeId = await storage.transaction("readwrite", async (tx) => {
    let saved = await tx.meta.get("nodeId");
    if (saved === undefined) {
      const generated = generateNodeId();
      if (!isValidNodeId(generated)) {
        throw new ConfigError(
          `generateNodeId returned an invalid nodeId: ${JSON.stringify(generated)}`,
        );
      }
      saved = generated;
      await tx.meta.set("nodeId", saved);
    } else if (!isValidNodeId(saved)) {
      throw new CorruptStorageError(`Stored nodeId is corrupt: ${saved}`);
    }

    return saved;
  });

  const clock = new HybridLogicalClock(nodeId, {
    now: options.now,
    maxDriftMs: options.maxDriftMs,
  });
  let lastSeenStoredClock: string | undefined;

  // Other tabs and workers on the same storage advance the stored clock too
  const mergeStoredClock = async (tx: StorageTx) => {
    const stored = await tx.meta.get("clock");
    if (stored === undefined || stored === lastSeenStoredClock) {
      return;
    }

    const storedClock = HLCTimestamp.tryParse(stored);
    if (!storedClock) {
      throw new CorruptStorageError(`Stored clock is corrupt: ${stored}`);
    }

    clock.observe(storedClock);
    lastSeenStoredClock = stored;
  };

  const saveClock = async (tx: StorageTx) => {
    const next = clock.last().toString();
    await tx.meta.set("clock", next);
    lastSeenStoredClock = next;
  };

  /**
   * Runs `fn` in a readwrite transaction that saves the clock alongside `fn`'s writes, so rows,
   * deltas and clock commit or roll back together. Call `tick` and `receive` only inside `fn`.
   */
  const write = <T>(fn: (ctx: WriteContext) => Promise<T>): Promise<T> =>
    storage.transaction("readwrite", async (tx) => {
      await mergeStoredClock(tx);

      let clockChanged = false;
      const tick = () => {
        clockChanged = true;
        return clock.tick().toString();
      };
      const receive = (timestamp: string) => {
        clock.receive(HLCTimestamp.parse(timestamp));
        clockChanged = true;
      };

      const result = await fn({ tx, tick, receive });

      if (clockChanged) {
        await saveClock(tx);
      }

      return result;
    });

  // Fetch outside any transaction: awaiting the network inside one can commit it early (IndexedDB)
  const fetchPage = async (transport: Transport, from: string | undefined): Promise<Fetched> => {
    let page: PullResult;
    try {
      page = await transport.pull({ cursor: from ?? null, nodeId, limit: pullLimit });
    } catch (error) {
      throw new TransportError(error);
    }
    if (page.hasMore && (page.cursor === null || page.cursor === from)) {
      throw new ServerProtocolError("Server reported more changes without advancing the cursor");
    }

    return { from, page };
  };

  /** Merges a fetched page if the stored cursor still matches the one it was fetched from. */
  const savePage = ({ from, page }: Fetched): Promise<Saved> =>
    write(async ({ tx, receive }) => {
      // Another tab moved the cursor mid-fetch. Saving this page's cursor could move it backwards,
      // so skip the page and refetch.
      const current = await tx.meta.get("cursor");
      if (current !== from) {
        return { applied: false, cursor: current };
      }

      await applyRemoteDeltas(tx, page.deltas, receive);
      if (page.cursor !== null) {
        await tx.meta.set("cursor", page.cursor);
      }

      return { applied: true, cursor: page.cursor ?? from };
    });

  const pullAll = async (transport: Transport): Promise<void> => {
    const start = await storage.transaction("read", (tx) => tx.meta.get("cursor"));
    let pending = fetchPage(transport, start);

    for (;;) {
      // oxlint-disable-next-line no-await-in-loop -- each page starts from the cursor the last one returned
      const fetched = await pending;

      // Fetch the next page while this one saves, so the network overlaps the write
      const next = fetched.page.hasMore
        ? fetchPage(transport, fetched.page.cursor ?? undefined)
        : undefined;
      // Mark as handled: if the save throws, nothing awaits `next`
      next?.catch(() => {});

      // oxlint-disable-next-line no-await-in-loop -- pages save in order so the cursor only moves forward
      const saved = await savePage(fetched);
      if (!saved.applied) {
        // `next` was fetched from the stale cursor
        pending = fetchPage(transport, saved.cursor);
        continue;
      }
      if (!next) {
        return;
      }

      pending = next;
    }
  };

  /** Pushes the oldest batch from the outbox. Returns whether there was anything to push. */
  const pushBatch = async (transport: Transport): Promise<boolean> => {
    // Read the outbox fresh each time, so writes made during an earlier batch are sent too
    const batch = await storage.transaction("read", (tx) => tx.outbox.list(pushBatchSize));
    if (batch.length === 0) {
      return false;
    }

    // If this succeeds but the move below never happens,
    // the batch stays in the outbox and is pushed again; the server ignores timestamps it has.
    try {
      await transport.push({ nodeId, deltas: batch });
    } catch (error) {
      throw error instanceof ClockDriftError
        ? new LocalClockAheadError(error)
        : new TransportError(error);
    }

    // Moving to history (not deleting) keeps these deltas counting for last-writer-wins
    const timestamps = batch.map((delta) => delta.timestamp);
    await storage.transaction("readwrite", (tx) => tx.outbox.moveToHistory(timestamps));

    return true;
  };

  const runSync = (transport: Transport): Promise<Result<void, SyncNowError>> =>
    toResult(async () => {
      await pullAll(transport);

      let pushed = true;
      while (pushed) {
        // oxlint-disable-next-line no-await-in-loop -- each batch is the oldest left after the last one moved
        pushed = await pushBatch(transport);
      }
    });

  let running: Promise<Result<void, SyncNowError>> | undefined;
  // One follow-up covers every call made during `running`: it starts after all of them
  let queued: Promise<Result<void, SyncNowError>> | undefined;

  const startSync = (transport: Transport) => {
    const run = runSync(transport).finally(() => {
      running = undefined;
    });
    running = run;
    return run;
  };

  return {
    nodeId,
    insert: (table, values, insertOptions) =>
      toResult(() =>
        write(async ({ tx, tick }) => {
          const suppliedId = insertOptions?.id;
          const objectId = suppliedId ?? generateId();

          const current = await tx.rows.get(table, objectId);
          if (current) {
            throw new RowError("row-exists", table, objectId);
          }

          if (suppliedId !== undefined) {
            const deletedKeys = await tx.deleted([{ table, objectId }]);
            if (deletedKeys.size > 0) {
              throw new RowError("row-deleted", table, objectId);
            }
          }

          const columns = columnsOf(values);
          if (Object.keys(columns).length === 0) {
            throw new RowError("no-columns", table, objectId);
          }

          await tx.rows.upsert(table, objectId, columns);
          await tx.outbox.add(setDeltas(table, objectId, columns, tick));

          return objectId;
        }),
      ),
    update: (table, objectId, patch) =>
      toResult(() =>
        write(async ({ tx, tick }) => {
          const current = await tx.rows.get(table, objectId);
          if (!current) {
            throw new RowError("row-not-found", table, objectId);
          }

          const columns = changedColumns(current, patch);
          if (Object.keys(columns).length === 0) {
            return;
          }

          await tx.rows.upsert(table, objectId, columns);
          await tx.outbox.add(setDeltas(table, objectId, columns, tick));
        }),
      ),
    delete: (table, objectId) =>
      toResult(() =>
        write(async ({ tx, tick }) => {
          const current = await tx.rows.get(table, objectId);
          if (!current) {
            return;
          }

          await tx.rows.delete(table, objectId);
          await tx.outbox.add([{ kind: "delete", timestamp: tick(), table, objectId }]);
        }),
      ),
    syncNow: async () => {
      const { transport } = options;
      if (!transport) {
        throw new ConfigError("Cannot sync without a transport");
      }

      if (queued) {
        return queued;
      }
      if (!running) {
        return startSync(transport);
      }

      // Start the follow-up whether `running` resolves or rejects, so the queue never stalls
      const startFollowUp = () => {
        queued = undefined;
        return startSync(transport);
      };
      queued = running.then(startFollowUp, startFollowUp);
      return queued;
    },
  };
};
