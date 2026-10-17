import { describe, expect, it } from "vitest";
import { clientMemoryStorage } from "#adapters/client-memory";
import { createSyncClient, type SyncClientOptions } from "#core/client/client";
import type { Delta } from "#core/delta";
import { HLCTimestamp } from "#core/hlc/timestamp";
import type { StorageAdapter, StorageTx } from "#core/storage";

const TABLE = "items";
const START = 1_700_000_000_000;

// Deterministic ids: "id-1", "id-2", ...
const sequentialIds = (prefix = "id") => {
  let next = 0;
  return () => {
    next++;
    return `${prefix}-${next}`;
  };
};

// Storage plus a wall clock the test controls through `setTime`.
const setup = (overrides: Partial<SyncClientOptions> = {}) => {
  const storage = clientMemoryStorage();
  let time = START;
  const options: SyncClientOptions = {
    storage,
    generateId: sequentialIds(),
    generateNodeId: () => "node-a",
    now: () => time,
    ...overrides,
  };
  return {
    storage,
    options,
    create: (extra: Partial<SyncClientOptions> = {}) => createSyncClient({ ...options, ...extra }),
    setTime: (value: number) => {
      time = value;
    },
  };
};

const read = <T>(storage: StorageAdapter, fn: (tx: StorageTx) => Promise<T>): Promise<T> =>
  storage.transaction("read", fn);

const outbox = (storage: StorageAdapter): Promise<Delta[]> =>
  read(storage, (tx) => tx.outbox.list());

const row = (storage: StorageAdapter, objectId: string, table = TABLE) =>
  read(storage, (tx) => tx.rows.get(table, objectId));

const storedClock = (storage: StorageAdapter) => read(storage, (tx) => tx.meta.get("clock"));

const columns = (deltas: Delta[]) =>
  deltas.map((delta) => (delta.kind === "set" ? delta.column : "<delete>"));

const timestamps = (deltas: Delta[]) => deltas.map((delta) => delta.timestamp);

const expectUniqueAndIncreasing = (values: string[]) => {
  expect(new Set(values).size).toBe(values.length);
  for (let i = 1; i < values.length; i++) {
    const previous = values[i - 1] ?? "";
    const current = values[i] ?? "";
    expect(current > previous, `${current} should be greater than ${previous}`).toBe(true);
  }
};

type FailingMethod = "rows.upsert" | "outbox.add" | "meta.set";

// Wraps an adapter so a chosen StorageTx method throws while `active()` is true, to test rollback.
const failing = (
  inner: StorageAdapter,
  method: FailingMethod,
  active: () => boolean = () => true,
): StorageAdapter => ({
  transaction: (mode, fn) =>
    inner.transaction(mode, (tx) => {
      if (!active()) {
        return fn(tx);
      }

      const fail = async () => {
        throw new Error(`${method} failed`);
      };
      return fn({
        ...tx,
        rows: method === "rows.upsert" ? { ...tx.rows, upsert: fail } : tx.rows,
        outbox: method === "outbox.add" ? { ...tx.outbox, add: fail } : tx.outbox,
        meta: method === "meta.set" ? { ...tx.meta, set: fail } : tx.meta,
      });
    }),
});

describe("createSyncClient", () => {
  describe("node id", () => {
    it("generates and saves a node id on first start", async () => {
      const { storage, create } = setup();

      const client = await create();

      expect(client.nodeId).toBe("node-a");
      expect(await read(storage, (tx) => tx.meta.get("nodeId"))).toBe("node-a");
    });

    it("reuses the saved node id on later starts", async () => {
      const { create } = setup();
      await create();

      const restarted = await create({ generateNodeId: () => "node-b" });

      expect(restarted.nodeId).toBe("node-a");
    });

    it("agrees on one node id when two clients start at the same time", async () => {
      const { create } = setup();
      const ids = sequentialIds("node");

      const [first, second] = await Promise.all([
        create({ generateNodeId: ids }),
        create({ generateNodeId: ids }),
      ]);

      expect(first.nodeId).toBe(second.nodeId);
    });

    it("rejects an invalid generated node id and saves nothing", async () => {
      const { storage, create } = setup({ generateNodeId: () => "not valid!" });

      await expect(create()).rejects.toThrow("Invalid HLC nodeId");
      expect(await read(storage, (tx) => tx.meta.get("nodeId"))).toBeUndefined();
    });

    it("uses crypto.randomUUID by default", async () => {
      const client = await createSyncClient({ storage: clientMemoryStorage() });

      expect(client.nodeId).toMatch(/^[0-9a-f-]{36}$/);
    });
  });

  describe("insert", () => {
    it("creates the row and returns its generated id", async () => {
      const { storage, create } = setup();
      const client = await create();

      const id = await client.insert(TABLE, { name: "milk", price: 3 });

      expect(id).toBe("id-1");
      expect(await row(storage, id)).toEqual({ id, name: "milk", price: 3 });
    });

    it("records one set delta per column", async () => {
      const { storage, create } = setup();
      const client = await create();

      const id = await client.insert(TABLE, { name: "milk", price: 3 });

      const deltas = await outbox(storage);
      expect(deltas).toEqual([
        expect.objectContaining({
          kind: "set",
          table: TABLE,
          objectId: id,
          column: "name",
          value: "milk",
        }),
        expect.objectContaining({
          kind: "set",
          table: TABLE,
          objectId: id,
          column: "price",
          value: 3,
        }),
      ]);
      expectUniqueAndIncreasing(timestamps(deltas));
    });

    it("ignores id and undefined values but keeps null", async () => {
      const { storage, create } = setup();
      const client = await create();

      const id = await client.insert(TABLE, {
        id: "ignored",
        name: "milk",
        note: undefined,
        tag: null,
      });

      expect(id).toBe("id-1");
      expect(await row(storage, id)).toEqual({ id, name: "milk", tag: null });
      expect(columns(await outbox(storage))).toEqual(["name", "tag"]);
    });

    it("stores nested JSON values", async () => {
      const { storage, create } = setup();
      const client = await create();

      const id = await client.insert(TABLE, { tags: ["a", "b"], meta: { color: "red" } });

      expect(await row(storage, id)).toEqual({ id, tags: ["a", "b"], meta: { color: "red" } });
    });

    it("uses a custom id when given", async () => {
      const { storage, create } = setup();
      const client = await create();

      const id = await client.insert(TABLE, { value: "USD" }, { id: "currency" });

      expect(id).toBe("currency");
      expect(await row(storage, "currency")).toEqual({ id: "currency", value: "USD" });
    });

    it("allows the same id in two tables", async () => {
      const { storage, create } = setup();
      const client = await create();

      await client.insert("a", { name: "first" }, { id: "shared" });
      await client.insert("b", { name: "second" }, { id: "shared" });

      expect(await row(storage, "shared", "a")).toEqual({ id: "shared", name: "first" });
      expect(await row(storage, "shared", "b")).toEqual({ id: "shared", name: "second" });
    });

    it("throws when the id belongs to an existing row", async () => {
      const { storage, create } = setup();
      const client = await create();
      await client.insert(TABLE, { name: "milk" }, { id: "x" });

      await expect(client.insert(TABLE, { name: "bread" }, { id: "x" })).rejects.toThrow(
        /already exists/,
      );
      expect(await row(storage, "x")).toEqual({ id: "x", name: "milk" });
      expect(await outbox(storage)).toHaveLength(1);
    });

    it("throws when the id belongs to a deleted row", async () => {
      const { storage, create } = setup();
      const client = await create();
      await client.insert(TABLE, { name: "milk" }, { id: "x" });
      await client.delete(TABLE, "x");

      await expect(client.insert(TABLE, { name: "bread" }, { id: "x" })).rejects.toThrow(/deleted/);
      expect(await row(storage, "x")).toBeUndefined();
    });

    it("only checks for deleted rows when the id is passed in", async () => {
      const { storage, create } = setup();
      let deletedCalls = 0;
      const counting: StorageAdapter = {
        transaction: (mode, fn) =>
          storage.transaction(mode, (tx) =>
            fn({
              ...tx,
              deleted: (objects) => {
                deletedCalls++;
                return tx.deleted(objects);
              },
            }),
          ),
      };
      const client = await create({ storage: counting });

      await client.insert(TABLE, { name: "milk" });
      expect(deletedCalls).toBe(0);

      await client.insert(TABLE, { name: "bread" }, { id: "x" });
      expect(deletedCalls).toBe(1);
    });

    it("throws for a row with no columns", async () => {
      const { storage, create } = setup();
      const client = await create();

      await expect(client.insert(TABLE, {})).rejects.toThrow(/no columns/);
      await expect(client.insert(TABLE, { id: "x", note: undefined })).rejects.toThrow(
        /no columns/,
      );
      expect(await outbox(storage)).toEqual([]);
      expect(await storedClock(storage)).toBeUndefined();
    });
  });

  describe("column names", () => {
    it("stores a __proto__ column as an own property", async () => {
      const { storage, create } = setup();
      const client = await create();

      const id = await client.insert(TABLE, JSON.parse('{"__proto__": "x", "a": 1}'));

      const stored = await row(storage, id);
      expect(Object.hasOwn(stored ?? {}, "__proto__")).toBe(true);
      expect(Object.getOwnPropertyDescriptor(stored, "__proto__")?.value).toBe("x");
      expect(columns(await outbox(storage))).toContain("__proto__");
    });

    it("updates a __proto__ column the row did not have", async () => {
      const { storage, create } = setup();
      const client = await create();
      const id = await client.insert(TABLE, { a: 1 });

      await client.update(TABLE, id, JSON.parse('{"__proto__": {}}'));

      const stored = await row(storage, id);
      expect(Object.getOwnPropertyDescriptor(stored, "__proto__")?.value).toEqual({});
      expect(columns(await outbox(storage))).toEqual(["a", "__proto__"]);
    });
  });

  describe("update", () => {
    it("records deltas only for columns that changed", async () => {
      const { storage, create } = setup();
      const client = await create();
      const id = await client.insert(TABLE, { name: "milk", price: 3 });

      await client.update(TABLE, id, { name: "milk", price: 4 });

      const deltas = await outbox(storage);
      expect(columns(deltas)).toEqual(["name", "price", "price"]);
      expect(deltas.at(-1)).toEqual(expect.objectContaining({ column: "price", value: 4 }));
      expect(await row(storage, id)).toEqual({ id, name: "milk", price: 4 });
    });

    it("treats equal nested values as unchanged", async () => {
      const { storage, create } = setup();
      const client = await create();
      const id = await client.insert(TABLE, { tags: ["a"], meta: { color: "red" } });

      await client.update(TABLE, id, { tags: ["a"], meta: { color: "red" } });

      expect(await outbox(storage)).toHaveLength(2);
    });

    it("keeps columns that are not in the patch", async () => {
      const { storage, create } = setup();
      const client = await create();
      const id = await client.insert(TABLE, { name: "milk", price: 3 });

      await client.update(TABLE, id, { price: 4 });

      expect(await row(storage, id)).toEqual({ id, name: "milk", price: 4 });
    });

    it("adds a column that the row did not have", async () => {
      const { storage, create } = setup();
      const client = await create();
      const id = await client.insert(TABLE, { name: "milk" });

      await client.update(TABLE, id, { note: "fresh" });

      expect(await row(storage, id)).toEqual({ id, name: "milk", note: "fresh" });
      expect(columns(await outbox(storage))).toEqual(["name", "note"]);
    });

    it("ignores id and undefined values but clears with null", async () => {
      const { storage, create } = setup();
      const client = await create();
      const id = await client.insert(TABLE, { name: "milk", note: "fresh" });

      await client.update(TABLE, id, { id: "other", name: undefined, note: null });

      expect(await row(storage, id)).toEqual({ id, name: "milk", note: null });
      expect(columns(await outbox(storage))).toEqual(["name", "note", "note"]);
    });

    it("does nothing when no column changed", async () => {
      const { storage, create } = setup();
      const client = await create();
      const id = await client.insert(TABLE, { name: "milk" });
      const clockBefore = await storedClock(storage);

      await client.update(TABLE, id, { name: "milk" });
      await client.update(TABLE, id, {});

      expect(await outbox(storage)).toHaveLength(1);
      expect(await storedClock(storage)).toBe(clockBefore);
    });

    it("throws when the row does not exist", async () => {
      const { storage, create } = setup();
      const client = await create();

      await expect(client.update(TABLE, "missing", { name: "milk" })).rejects.toThrow(/not found/);
      expect(await row(storage, "missing")).toBeUndefined();
      expect(await outbox(storage)).toEqual([]);
    });

    it("throws for a deleted row and does not recreate it", async () => {
      const { storage, create } = setup();
      const client = await create();
      const id = await client.insert(TABLE, { name: "milk" });
      await client.delete(TABLE, id);

      await expect(client.update(TABLE, id, { name: "bread" })).rejects.toThrow(/not found/);
      expect(await row(storage, id)).toBeUndefined();
    });

    it("throws when another client deleted the row first", async () => {
      const { storage, create } = setup();
      const first = await create();
      const second = await create();
      const id = await first.insert(TABLE, { name: "milk" });

      await second.delete(TABLE, id);

      await expect(first.update(TABLE, id, { name: "bread" })).rejects.toThrow(/not found/);
      expect(await row(storage, id)).toBeUndefined();
    });
  });

  describe("delete", () => {
    it("removes the row and records a delete delta", async () => {
      const { storage, create } = setup();
      const client = await create();
      const id = await client.insert(TABLE, { name: "milk" });

      await client.delete(TABLE, id);

      expect(await row(storage, id)).toBeUndefined();
      const deltas = await outbox(storage);
      expect(deltas.at(-1)).toEqual(
        expect.objectContaining({ kind: "delete", table: TABLE, objectId: id }),
      );
      expectUniqueAndIncreasing(timestamps(deltas));
    });

    it("records only one delete when called twice", async () => {
      const { storage, create } = setup();
      const client = await create();
      const id = await client.insert(TABLE, { name: "milk" });

      await client.delete(TABLE, id);
      await client.delete(TABLE, id);

      expect(columns(await outbox(storage))).toEqual(["name", "<delete>"]);
    });

    it("does nothing for a row that does not exist", async () => {
      const { storage, create } = setup();
      const client = await create();

      await client.delete(TABLE, "missing");

      expect(await outbox(storage)).toEqual([]);
      expect(await storedClock(storage)).toBeUndefined();
    });

    it("only deletes the row in the given table", async () => {
      const { storage, create } = setup();
      const client = await create();
      await client.insert("a", { name: "first" }, { id: "shared" });
      await client.insert("b", { name: "second" }, { id: "shared" });

      await client.delete("a", "shared");

      expect(await row(storage, "shared", "a")).toBeUndefined();
      expect(await row(storage, "shared", "b")).toEqual({ id: "shared", name: "second" });
    });
  });

  describe("clock", () => {
    it("stamps deltas with this node's id and the wall clock", async () => {
      const { storage, create } = setup();
      const client = await create();

      await client.insert(TABLE, { name: "milk" });

      const [delta] = await outbox(storage);
      const timestamp = HLCTimestamp.parse(delta?.timestamp ?? "");
      expect(timestamp.nodeId).toBe("node-a");
      expect(timestamp.physicalTime).toBe(START);
    });

    it("saves the clock after every write", async () => {
      const { storage, create } = setup();
      const client = await create();

      const id = await client.insert(TABLE, { name: "milk" });
      expect(await storedClock(storage)).toBe((await outbox(storage)).at(-1)?.timestamp);

      await client.update(TABLE, id, { name: "bread" });
      expect(await storedClock(storage)).toBe((await outbox(storage)).at(-1)?.timestamp);

      await client.delete(TABLE, id);
      expect(await storedClock(storage)).toBe((await outbox(storage)).at(-1)?.timestamp);
    });

    it("keeps increasing after a restart with the wall clock moved backwards", async () => {
      const { storage, create, setTime } = setup();
      const client = await create();
      const id = await client.insert(TABLE, { name: "milk" });
      await client.update(TABLE, id, { name: "bread" });

      setTime(START - 60_000);
      const restarted = await create();
      await restarted.update(TABLE, id, { name: "eggs" });
      await restarted.delete(TABLE, id);

      expectUniqueAndIncreasing(timestamps(await outbox(storage)));
    });

    it("rejects writes when the stored clock is corrupt", async () => {
      const { storage, create } = setup();
      const client = await create();
      await storage.transaction("readwrite", (tx) => tx.meta.set("clock", "garbage"));

      await expect(client.insert(TABLE, { name: "milk" })).rejects.toThrow(/corrupt/);

      expect(await outbox(storage)).toEqual([]);
      expect(await row(storage, "id-1")).toBeUndefined();
    });

    it("orders interleaved writes from two clients on the same storage", async () => {
      const { storage, create } = setup();
      // Separate id sequences so the two clients never pick the same row id
      const first = await create({ generateId: sequentialIds("a") });
      const second = await create({ generateId: sequentialIds("b") });

      // Sequential on purpose: each write must see the one before it
      /* oxlint-disable no-await-in-loop */
      const issued: string[] = [];
      for (let i = 0; i < 20; i++) {
        const client = i % 3 === 0 ? second : first;
        await client.insert(TABLE, { n: i });
        issued.push((await outbox(storage)).at(-1)?.timestamp ?? "");
      }
      /* oxlint-enable no-await-in-loop */

      expectUniqueAndIncreasing(issued);
    });

    it("gives concurrent writes from two clients unique timestamps", async () => {
      const { storage, create } = setup();
      const first = await create({ generateId: sequentialIds("a") });
      const second = await create({ generateId: sequentialIds("b") });

      const writes: Promise<string>[] = [];
      for (let i = 0; i < 20; i++) {
        writes.push((i % 2 === 0 ? first : second).insert(TABLE, { n: i, m: i }));
      }
      await Promise.all(writes);

      const all = timestamps(await outbox(storage));
      expect(all).toHaveLength(40);
      expect(new Set(all).size).toBe(40);
    });
  });

  describe("rollback", () => {
    it.each<FailingMethod>(["outbox.add", "meta.set"])(
      "rows, deltas, and clocks return to original state when %s fails",
      async (method) => {
        const { storage, create } = setup();
        const client = await create();
        const id = await client.insert(TABLE, { name: "milk" });
        const clockBefore = await storedClock(storage);

        const broken = await create({ storage: failing(storage, method) });

        await expect(broken.insert(TABLE, { name: "bread" }, { id: "y" })).rejects.toThrow(
          `${method} failed`,
        );
        await expect(broken.update(TABLE, id, { name: "bread" })).rejects.toThrow(
          `${method} failed`,
        );
        await expect(broken.delete(TABLE, id)).rejects.toThrow(`${method} failed`);

        expect(await row(storage, "y")).toBeUndefined();
        expect(await row(storage, id)).toEqual({ id, name: "milk" });
        expect(await outbox(storage)).toHaveLength(1);
        expect(await storedClock(storage)).toBe(clockBefore);
      },
    );

    it("rows, deltas, and clocks return to original state when rows.upsert fails", async () => {
      const { storage, create } = setup();
      const client = await create();
      const id = await client.insert(TABLE, { name: "milk" });
      const clockBefore = await storedClock(storage);

      const broken = await create({ storage: failing(storage, "rows.upsert") });

      await expect(broken.insert(TABLE, { name: "bread" }, { id: "y" })).rejects.toThrow(
        "rows.upsert failed",
      );
      await expect(broken.update(TABLE, id, { name: "bread" })).rejects.toThrow(
        "rows.upsert failed",
      );

      expect(await row(storage, "y")).toBeUndefined();
      expect(await row(storage, id)).toEqual({ id, name: "milk" });
      expect(await outbox(storage)).toHaveLength(1);
      expect(await storedClock(storage)).toBe(clockBefore);
    });

    it("keeps working after a failed write", async () => {
      const { storage, create } = setup();
      const broken = await create({ storage: failing(storage, "outbox.add") });
      await expect(broken.insert(TABLE, { name: "bread" })).rejects.toThrow("outbox.add failed");

      const client = await create();
      const id = await client.insert(TABLE, { name: "milk" });

      expect(await row(storage, id)).toEqual({ id, name: "milk" });
    });

    it("keeps timestamps increasing on the same client after a failed write", async () => {
      const { storage, create } = setup();
      let fail = false;
      const client = await create({ storage: failing(storage, "meta.set", () => fail) });

      await client.insert(TABLE, { name: "milk" });
      fail = true;
      await expect(client.insert(TABLE, { name: "bread" })).rejects.toThrow("meta.set failed");
      fail = false;
      await client.insert(TABLE, { name: "eggs" });

      const deltas = await outbox(storage);
      expect(deltas).toHaveLength(2);
      expectUniqueAndIncreasing(timestamps(deltas));
      expect(await storedClock(storage)).toBe(deltas.at(-1)?.timestamp);
    });
  });
});
