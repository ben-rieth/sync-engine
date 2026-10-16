import { type DeltaKey, deltaKey, type Delta } from "#core/delta";
import { objectKey, type ObjectKey } from "#core/object";
import type { MetaKey, StorageAdapter, StorageTx } from "#core/storage";

type MemoryState = {
  rows: Map<string, Map<string, Record<string, unknown>>>;
  outbox: Map<string, Delta>;
  history: Map<string, Delta>;
  meta: Map<MetaKey, string>;
};

const compareStrings = (a: string, b: string): -1 | 0 | 1 => (a < b ? -1 : a > b ? 1 : 0);

const snapshotState = (s: MemoryState): MemoryState => ({
  rows: new Map([...s.rows].map(([table, rows]) => [table, new Map(rows)])),
  outbox: new Map(s.outbox),
  history: new Map(s.history),
  meta: new Map(s.meta),
});

const cloneJson = <T>(value: T): T =>
  value === undefined ? value : JSON.parse(JSON.stringify(value));

const tableRows = (state: MemoryState, table: string) => {
  let rows = state.rows.get(table);
  if (!rows) {
    rows = new Map();
    state.rows.set(table, rows);
  }

  return rows;
};

const createTx = (getState: () => MemoryState, mode: "read" | "readwrite"): StorageTx => {
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
          compareStrings(a.timestamp, b.timestamp),
        );

        return cloneJson(sorted.slice(0, limit));
      },
      count: async () => getState().outbox.size,
      moveToHistory: async (timestamps) => {
        const { outbox, history } = writable();
        for (const timestamp of timestamps) {
          const delta = outbox.get(timestamp);
          if (delta) {
            history.set(timestamp, delta);
            outbox.delete(timestamp);
          }
        }
      },
    },
    history: {
      add: async (deltas) => {
        const { history } = writable();
        for (const delta of deltas) {
          if (!history.has(delta.timestamp)) {
            history.set(delta.timestamp, cloneJson(delta));
          }
        }
      },
      has: async (timestamps) => {
        const { history } = getState();
        return new Set(timestamps.filter((timestamp) => history.has(timestamp)));
      },
    },
    latest: async (cells) => {
      const state = getState();

      const wanted = new Set(cells.map((cell) => deltaKey(cell)));
      const result = new Map<DeltaKey, string>();

      for (const source of [state.history, state.outbox]) {
        for (const delta of source.values()) {
          if (delta.kind === "delete") {
            continue;
          }

          const key = deltaKey(delta);
          if (!wanted.has(key)) {
            continue;
          }

          const current = result.get(key);
          if (current === undefined || delta.timestamp > current) {
            result.set(key, delta.timestamp);
          }
        }
      }

      return result;
    },
    deleted: async (objects) => {
      const state = getState();

      const wanted = new Set(objects.map((object) => objectKey(object)));
      const result = new Set<ObjectKey>();

      for (const source of [state.history, state.outbox]) {
        for (const delta of source.values()) {
          if (delta.kind !== "delete") {
            continue;
          }

          const key = objectKey(delta);
          if (wanted.has(key)) {
            result.add(key);
          }
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
    history: new Map(),
    meta: new Map(),
  };
  let queue: Promise<unknown> = Promise.resolve();

  const transaction = <T>(
    mode: "read" | "readwrite",
    _tables: string[],
    fn: (tx: StorageTx) => Promise<T>,
  ) => {
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
