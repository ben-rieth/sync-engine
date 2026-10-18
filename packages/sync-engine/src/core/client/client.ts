import type { Delta } from "../delta";
import { HybridLogicalClock } from "../hlc/clock";
import { assertNodeId } from "../hlc/node-id";
import { HLCTimestamp } from "../hlc/timestamp";
import { ServerProtocolError } from "../server/server";
import type { Transport } from "../server/transport";
import { applyRemoteDeltas } from "./apply";
import { defaultGenerateId } from "./id";
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
};

export type InsertOptions = {
  /** Use this id instead of generating one. Must not belong to an existing or deleted row. */
  id?: string;
};

export type SyncClient = {
  nodeId: string;
  /**
   * Creates a row and records one delta per column. `id` and `undefined` values are ignored;
   * use `null` to store an empty value. Throws if no columns remain, if the id belongs to
   * an existing row, or if `options.id` belongs to a deleted row. Returns the row's id.
   */
  insert(table: string, values: Record<string, unknown>, options?: InsertOptions): Promise<string>;
  /**
   * Records one delta per column whose value changed. `id` and `undefined` values are ignored;
   * use `null` to clear a column. Throws if the row does not exist. Does nothing if no column changed.
   */
  update(table: string, objectId: string, patch: Record<string, unknown>): Promise<void>;
  /** Deletes the row and records a delete delta. Does nothing if the row does not exist. */
  delete(table: string, objectId: string): Promise<void>;
  /**
   * Pulls deltas from other nodes until the server has no more. Each page and its cursor commit
   * together, so an interrupted sync resumes where it stopped.
   *
   * Throws without a transport, on transport errors, with `ClockDriftError` if a delta is too far
   * in the future, and with `ServerProtocolError` if the server breaks the paging contract. Earlier
   * pages stay merged; the failing page does not.
   */
  syncNow(): Promise<void>;
};

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

export const createSyncClient = async (options: SyncClientOptions): Promise<SyncClient> => {
  const { storage } = options;
  const generateId = options.generateId ?? defaultGenerateId;
  const generateNodeId = options.generateNodeId ?? defaultGenerateId;
  const pullLimit = options.pullLimit ?? 1000;
  if (!Number.isSafeInteger(pullLimit) || pullLimit < 1) {
    throw new RangeError(`Invalid pullLimit: ${pullLimit}`);
  }

  // readwrite so two tabs starting at once agree on a single node id
  const nodeId = await storage.transaction("readwrite", async (tx) => {
    let saved = await tx.meta.get("nodeId");
    if (saved === undefined) {
      saved = generateNodeId();
      assertNodeId(saved);
      await tx.meta.set("nodeId", saved);
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
      throw new Error(`Stored clock is corrupt: ${stored}`);
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

  /** Fetches and merges one page. Returns whether to keep pulling. */
  const pullPage = async (transport: Transport): Promise<boolean> => {
    // Fetch outside any transaction: awaiting the network inside one can commit it early (IndexedDB)
    const storedCursor = await storage.transaction("read", (tx) => tx.meta.get("cursor"));
    const page = await transport.pull({ cursor: storedCursor ?? null, nodeId, limit: pullLimit });
    if (page.hasMore && (page.cursor === null || page.cursor === storedCursor)) {
      throw new ServerProtocolError("Server reported more changes without advancing the cursor");
    }

    return write(async ({ tx, receive }) => {
      // Another tab moved the cursor mid-fetch. Saving this page's cursor could move it backwards,
      // so skip the page and refetch.
      const currentCursor = await tx.meta.get("cursor");
      if (currentCursor !== storedCursor) {
        return true;
      }

      await applyRemoteDeltas(tx, page.deltas, receive);
      if (page.cursor !== null) {
        await tx.meta.set("cursor", page.cursor);
      }

      return page.hasMore;
    });
  };

  return {
    nodeId,
    insert: (table, values, insertOptions) =>
      write(async ({ tx, tick }) => {
        const suppliedId = insertOptions?.id;
        const objectId = suppliedId ?? generateId();

        const current = await tx.rows.get(table, objectId);
        if (current) {
          throw new Error(`Row ${objectId} already exists in ${table}`);
        }

        if (suppliedId !== undefined) {
          const deletedKeys = await tx.deleted([{ table, objectId }]);
          if (deletedKeys.size > 0) {
            throw new Error(`Row ${objectId} in ${table} was deleted and its id cannot be reused`);
          }
        }

        const columns = columnsOf(values);
        if (Object.keys(columns).length === 0) {
          throw new Error(`Cannot insert a row with no columns into ${table}`);
        }

        await tx.rows.upsert(table, objectId, columns);
        await tx.outbox.add(setDeltas(table, objectId, columns, tick));

        return objectId;
      }),
    update: (table, objectId, patch) =>
      write(async ({ tx, tick }) => {
        const current = await tx.rows.get(table, objectId);
        if (!current) {
          throw new Error(`Row ${objectId} not found in ${table}`);
        }

        const columns = changedColumns(current, patch);
        if (Object.keys(columns).length === 0) {
          return;
        }

        await tx.rows.upsert(table, objectId, columns);
        await tx.outbox.add(setDeltas(table, objectId, columns, tick));
      }),
    delete: (table, objectId) =>
      write(async ({ tx, tick }) => {
        const current = await tx.rows.get(table, objectId);
        if (!current) {
          return;
        }

        await tx.rows.delete(table, objectId);
        await tx.outbox.add([{ kind: "delete", timestamp: tick(), table, objectId }]);
      }),
    syncNow: async () => {
      const { transport } = options;
      if (!transport) {
        throw new Error("Cannot sync without a transport");
      }

      let hasMore = true;
      while (hasMore) {
        // oxlint-disable-next-line no-await-in-loop -- each page starts from the cursor the last one saved
        hasMore = await pullPage(transport);
      }
    },
  };
};
