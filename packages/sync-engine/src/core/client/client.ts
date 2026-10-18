import type { Delta } from "../delta";
import { HybridLogicalClock } from "../hlc/clock";
import { assertNodeId } from "../hlc/node-id";
import { HLCTimestamp } from "../hlc/timestamp";
import { defaultGenerateId } from "./id";
import type { StorageAdapter, StorageTx } from "../storage";
import { jsonEqual } from "#utils/json";

export type SyncClientOptions = {
  storage: StorageAdapter;
  /**
   * Generates ids for new rows. Defaults to `crypto.randomUUID()`.
   * Must never return the id of a deleted row: generated ids are not checked against deletes.
   */
  generateId?: () => string;
  /** Generates this device's node id on first start. Defaults to `crypto.randomUUID()`. */
  generateNodeId?: () => string;
  now?: () => number;
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
};

type WriteContext = {
  tx: StorageTx;
  tick: () => string;
};

const columnsOf = (values: Record<string, unknown>): Record<string, unknown> =>
  Object.fromEntries(
    Object.entries(values).filter(([column, value]) => column !== "id" && value !== undefined),
  );

// Columns from `patch` whose values differ from what `current` already holds
const changedColumns = (
  current: Record<string, unknown>,
  patch: Record<string, unknown>,
): Record<string, unknown> => {
  // hasOwn guard keeps inherited props like `toString` from counting as existing values
  const isChanged = ([column, value]: [string, unknown]) => {
    const existing = Object.hasOwn(current, column) ? current[column] : undefined;
    return !jsonEqual(value, existing);
  };

  return Object.fromEntries(Object.entries(columnsOf(patch)).filter(isChanged));
};

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

  const clock = new HybridLogicalClock(nodeId, { now: options.now });
  // Last stored clock string this client has observed or written; lets writes skip re-parsing it
  let knownClock: string | undefined;

  /**
   * Runs `fn` in a readwrite transaction with the clock synced to storage.
   *
   * Before `fn`: merges the stored clock so writes from other tabs/workers on the same
   * storage are ordered before ours. After `fn`: saves the clock if `fn` ticked, in the
   * same transaction, so the row, the deltas and the clock commit or roll back together.
   * `tick` must only be called inside `fn`.
   */
  const write = <T>(fn: (ctx: WriteContext) => Promise<T>): Promise<T> =>
    storage.transaction("readwrite", async (tx) => {
      const stored = await tx.meta.get("clock");
      if (stored !== undefined && stored !== knownClock) {
        const storedClock = HLCTimestamp.tryParse(stored);
        if (!storedClock) {
          throw new Error(`Stored clock is corrupt: ${stored}`);
        }

        clock.observe(storedClock);
        knownClock = stored;
      }

      let ticked = false;
      const tick = () => {
        ticked = true;
        return clock.tick().toString();
      };

      const result = await fn({ tx, tick });

      if (ticked) {
        const next = clock.last().toString();
        await tx.meta.set("clock", next);
        knownClock = next;
      }

      return result;
    });

  return {
    nodeId,
    insert: (table, values, insertOptions) =>
      write(async ({ tx, tick }) => {
        const objectId = insertOptions?.id ?? generateId();

        const current = await tx.rows.get(table, objectId);
        if (current) {
          throw new Error(`Row ${objectId} already exists in ${table}`);
        }

        // Generated ids are fresh, so only caller-supplied ids can belong to a deleted row
        if (insertOptions?.id !== undefined) {
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
  };
};
