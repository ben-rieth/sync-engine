import { type DeltaKey, deltaKey, type Delta } from "#core/delta";
import { compareTimestamps } from "#core/hlc/timestamp";
import { objectKey, type ObjectKey } from "#core/object";
import type { MetaKey, StorageAdapter, StorageTx, TransactionMode } from "#core/storage";
import { cloneJson } from "#utils/json";

type MemoryState = {
  rows: Map<string, Map<string, Record<string, unknown>>>;
  outbox: Map<string, Delta>;
  // History: newest set timestamp per object and column, and deleted objects
  cells: Map<ObjectKey, Map<string, string>>;
  tombstones: Set<ObjectKey>;
  meta: Map<MetaKey, string>;
};

const snapshotState = (s: MemoryState): MemoryState => ({
  rows: new Map([...s.rows].map(([table, rows]) => [table, new Map(rows)])),
  outbox: new Map(s.outbox),
  cells: new Map([...s.cells].map(([object, columns]) => [object, new Map(columns)])),
  tombstones: new Set(s.tombstones),
  meta: new Map(s.meta),
});

const tableRows = (state: MemoryState, table: string) => {
  let rows = state.rows.get(table);
  if (!rows) {
    rows = new Map();
    state.rows.set(table, rows);
  }

  return rows;
};

const recordHistory = (state: MemoryState, delta: Delta) => {
  const object = objectKey(delta);
  if (state.tombstones.has(object)) {
    return;
  }

  if (delta.kind === "delete") {
    state.tombstones.add(object);
    state.cells.delete(object);
    return;
  }

  let columns = state.cells.get(object);
  if (!columns) {
    columns = new Map();
    state.cells.set(object, columns);
  }

  const current = columns.get(delta.column);
  if (current === undefined || delta.timestamp > current) {
    columns.set(delta.column, delta.timestamp);
  }
};

const createTx = (getState: () => MemoryState, mode: TransactionMode): StorageTx => {
  const writable = () => {
    if (mode !== "readwrite") {
      throw new Error("Cannot write in read transaction");
    }

    return getState();
  };

  return {
    rows: {
      get: async (table, objectId) => {
        const row = getState().rows.get(table)?.get(objectId);
        return row ? cloneJson(row) : undefined;
      },
      upsert: async (table, objectId, patch) => {
        const rows = tableRows(writable(), table);
        const existing = rows.get(objectId);

        rows.set(objectId, { ...existing, ...cloneJson(patch), id: objectId });
      },
      delete: async (table, objectId) => {
        writable().rows.get(table)?.delete(objectId);
      },
    },
    outbox: {
      add: async (deltas) => {
        const { outbox } = writable();
        for (const delta of deltas) {
          outbox.set(delta.timestamp, cloneJson(delta));
        }
      },
      list: async (limit) => {
        const sorted = [...getState().outbox.values()].toSorted((a, b) =>
          compareTimestamps(a.timestamp, b.timestamp),
        );

        return cloneJson(sorted.slice(0, limit));
      },
      count: async () => getState().outbox.size,
      moveToHistory: async (timestamps) => {
        const state = writable();
        for (const timestamp of timestamps) {
          const delta = state.outbox.get(timestamp);
          if (delta) {
            recordHistory(state, delta);
            state.outbox.delete(timestamp);
          }
        }
      },
      delete: async (timestamps) => {
        const { outbox } = writable();
        for (const timestamp of timestamps) {
          outbox.delete(timestamp);
        }
      },
    },
    history: {
      add: async (deltas) => {
        const state = writable();
        for (const delta of deltas) {
          recordHistory(state, delta);
        }
      },
    },
    latest: async (cells) => {
      const state = getState();
      const result = new Map<DeltaKey, string>();

      const wanted = new Set(cells.map((cell) => deltaKey(cell)));

      for (const cell of cells) {
        const timestamp = state.cells.get(objectKey(cell))?.get(cell.column);
        if (timestamp !== undefined) {
          result.set(deltaKey(cell), timestamp);
        }
      }

      for (const delta of state.outbox.values()) {
        if (delta.kind === "delete") {
          continue;
        }

        const key = deltaKey(delta);
        const current = result.get(key);
        if (wanted.has(key) && (current === undefined || delta.timestamp > current)) {
          result.set(key, delta.timestamp);
        }
      }

      return result;
    },
    deleted: async (objects) => {
      const state = getState();

      const wanted = new Set(objects.map((object) => objectKey(object)));
      const result = new Set([...wanted].filter((key) => state.tombstones.has(key)));

      for (const delta of state.outbox.values()) {
        if (delta.kind !== "delete") {
          continue;
        }

        const key = objectKey(delta);
        if (wanted.has(key)) {
          result.add(key);
        }
      }

      return result;
    },
    meta: {
      get: async (key) => getState().meta.get(key),
      set: async (key, value) => {
        writable().meta.set(key, value);
      },
    },
  };
};

export const clientMemoryStorage = (): StorageAdapter & { state: MemoryState } => {
  let state: MemoryState = {
    rows: new Map(),
    outbox: new Map(),
    cells: new Map(),
    tombstones: new Set(),
    meta: new Map(),
  };
  let queue: Promise<unknown> = Promise.resolve();

  const transaction = <T>(mode: TransactionMode, fn: (tx: StorageTx) => Promise<T>) => {
    const run = async () => {
      const snapshot = mode === "readwrite" ? snapshotState(state) : null;
      let active = true;

      const tx = createTx(() => {
        if (!active) {
          throw new Error("Transaction used after it finished");
        }
        return state;
      }, mode);

      try {
        return await fn(tx);
      } catch (error) {
        if (snapshot) {
          state = snapshot; // rollback
        }
        throw error;
      } finally {
        active = false;
      }
    };

    const result = queue.then(run, run); // serialize; a failed tx doesn't block the next
    queue = result.catch(() => {});
    return result;
  };

  return {
    transaction,
    get state() {
      return state;
    },
  };
};
