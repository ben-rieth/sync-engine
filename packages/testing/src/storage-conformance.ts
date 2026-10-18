import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  deltaKey,
  HLCTimestamp,
  objectKey,
  type CellRef,
  type DeleteDelta,
  type SetDelta,
  type StorageAdapter,
  type StorageTx,
} from "@sync-engine/core";

export type StorageConformanceOptions = {
  /** Return a fresh, empty adapter. Called before every test. */
  create: () => StorageAdapter | Promise<StorageAdapter>;
  /** Called after each test. */
  destroy?: (adapter: StorageAdapter) => void | Promise<void>;
  /** App tables the adapter was created with, for the `tx.rows` tests. Default ["items", "other"]. */
  tables?: readonly [string, string];
};

const hlc = (physical: number, logical: number, node = "node-a"): string =>
  new HLCTimestamp(physical, logical, node).toString();

const ts = (n: number, node = "node-a"): string => hlc(n, 0, node);

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null;

/**
 * Runs the black-box `StorageAdapter` contract tests. Only `tx` methods are awaited inside
 * transactions, so the suite works for IndexedDB-backed adapters too.
 */
export const runStorageConformance = (name: string, options: StorageConformanceOptions): void => {
  const [table, otherTable] = options.tables ?? ["items", "other"];

  const setDelta = (overrides: Partial<SetDelta> = {}): SetDelta => ({
    kind: "set",
    timestamp: ts(1),
    table,
    objectId: "obj-1",
    column: "title",
    value: "hello",
    ...overrides,
  });

  const deleteDelta = (overrides: Partial<DeleteDelta> = {}): DeleteDelta => ({
    kind: "delete",
    timestamp: ts(1),
    table,
    objectId: "obj-1",
    ...overrides,
  });

  const cell = (overrides: Partial<CellRef> = {}): CellRef => ({
    table,
    objectId: "obj-1",
    column: "title",
    ...overrides,
  });

  const obj = (objectId: string, inTable = table) => ({ table: inTable, objectId });

  describe(`StorageAdapter conformance: ${name}`, () => {
    let adapter: StorageAdapter | undefined;

    const live = (): StorageAdapter => {
      if (!adapter) {
        throw new Error("adapter not created");
      }
      return adapter;
    };

    beforeEach(async () => {
      adapter = undefined;
      adapter = await options.create();
    });

    afterEach(async () => {
      if (adapter) {
        await options.destroy?.(adapter);
      }
      adapter = undefined;
    });

    const rw = <T>(fn: (tx: StorageTx) => Promise<T>): Promise<T> =>
      live().transaction("readwrite", fn);
    const ro = <T>(fn: (tx: StorageTx) => Promise<T>): Promise<T> => live().transaction("read", fn);

    describe("rows", () => {
      it("get returns undefined for a missing row", async () => {
        const row = await ro((tx) => tx.rows.get(table, "missing"));

        expect(row).toBeUndefined();
      });

      it("upsert creates the row as { id, ...patch }", async () => {
        await rw((tx) =>
          tx.rows.upsert(table, "obj-1", { title: "hello", done: false, note: null, count: 3 }),
        );

        const row = await ro((tx) => tx.rows.get(table, "obj-1"));

        expect(row).toEqual({
          id: "obj-1",
          title: "hello",
          done: false,
          note: null,
          count: 3,
        });
      });

      it("upsert keeps columns not in the patch", async () => {
        await rw((tx) => tx.rows.upsert(table, "obj-1", { title: "hello", done: false }));
        await rw((tx) => tx.rows.upsert(table, "obj-1", { done: true }));

        const row = await ro((tx) => tx.rows.get(table, "obj-1"));

        expect(row).toEqual({
          id: "obj-1",
          title: "hello",
          done: true,
        });
      });

      it("upsert ignores an id in the patch when creating", async () => {
        await rw((tx) => tx.rows.upsert(table, "obj-1", { id: "obj-2", title: "hello" }));

        const obj1 = await ro((tx) => tx.rows.get(table, "obj-1"));
        const obj2 = await ro((tx) => tx.rows.get(table, "obj-2"));

        expect(obj1).toEqual({
          id: "obj-1",
          title: "hello",
        });
        expect(obj2).toBeUndefined();
      });

      it("upsert ignores an id in the patch when updating", async () => {
        await rw((tx) => tx.rows.upsert(table, "obj-1", { title: "hello" }));
        await rw((tx) => tx.rows.upsert(table, "obj-1", { id: "obj-2", title: "bye" }));

        const obj1 = await ro((tx) => tx.rows.get(table, "obj-1"));
        const obj2 = await ro((tx) => tx.rows.get(table, "obj-2"));

        expect(obj1).toEqual({
          id: "obj-1",
          title: "bye",
        });
        expect(obj2).toBeUndefined();
      });

      it("mutating a returned row does not change stored data", async () => {
        const original = { title: "hello", tags: ["a"], info: { n: 1, deep: { ok: true } } };
        await rw((tx) => tx.rows.upsert(table, "obj-1", original));

        const row = await ro((tx) => tx.rows.get(table, "obj-1"));
        if (
          !isRecord(row) ||
          !Array.isArray(row.tags) ||
          !isRecord(row.info) ||
          !isRecord(row.info.deep)
        ) {
          throw new Error("unexpected row shape");
        }
        row.title = "changed";
        row.tags.push("b");
        row.info.n = 2;
        row.info.deep.ok = false;

        const stored = await ro((tx) => tx.rows.get(table, "obj-1"));

        expect(stored).toEqual({
          id: "obj-1",
          title: "hello",
          tags: ["a"],
          info: { n: 1, deep: { ok: true } },
        });
      });

      it("mutating a returned row inside the transaction does not change stored data", async () => {
        const stored = await rw(async (tx) => {
          await tx.rows.upsert(table, "obj-1", { info: { n: 1 } });
          const row = await tx.rows.get(table, "obj-1");
          if (!isRecord(row?.info)) {
            throw new Error("unexpected row shape");
          }
          row.info.n = 2;
          return tx.rows.get(table, "obj-1");
        });

        expect(stored).toEqual({ id: "obj-1", info: { n: 1 } });
      });

      it("delete removes the row", async () => {
        await rw((tx) => tx.rows.upsert(table, "obj-1", { title: "hello" }));
        await rw((tx) => tx.rows.delete(table, "obj-1"));

        const row = await ro((tx) => tx.rows.get(table, "obj-1"));

        expect(row).toBeUndefined();
      });

      it("delete of a missing row does nothing", async () => {
        await rw((tx) => tx.rows.upsert(table, "obj-1", { title: "hello" }));
        await rw((tx) => tx.rows.delete(table, "missing"));

        const missing = await ro((tx) => tx.rows.get(table, "missing"));
        const row = await ro((tx) => tx.rows.get(table, "obj-1"));

        expect(missing).toBeUndefined();
        expect(row).toEqual({
          id: "obj-1",
          title: "hello",
        });
      });

      it("the same id in two tables is two independent rows", async () => {
        await rw(async (tx) => {
          await tx.rows.upsert(table, "obj-1", { title: "first" });
          await tx.rows.upsert(otherTable, "obj-1", { title: "second" });
        });

        const row = await ro((tx) => tx.rows.get(table, "obj-1"));
        const otherRow = await ro((tx) => tx.rows.get(otherTable, "obj-1"));

        expect(row).toEqual({
          id: "obj-1",
          title: "first",
        });
        expect(otherRow).toEqual({
          id: "obj-1",
          title: "second",
        });

        await rw((tx) => tx.rows.delete(table, "obj-1"));

        const deletedRow = await ro((tx) => tx.rows.get(table, "obj-1"));
        const survivingRow = await ro((tx) => tx.rows.get(otherTable, "obj-1"));

        expect(deletedRow).toBeUndefined();
        expect(survivingRow).toEqual({
          id: "obj-1",
          title: "second",
        });
      });
    });

    describe("outbox", () => {
      it("list returns deltas oldest first regardless of insertion order", async () => {
        const a = setDelta({ timestamp: ts(1), value: "a" });
        const b = setDelta({ timestamp: ts(2), value: "b" });
        const c = setDelta({ timestamp: ts(3), value: "c" });
        const d = setDelta({ timestamp: ts(4), value: "d" });

        await rw((tx) => tx.outbox.add([c, a]));
        await rw((tx) => tx.outbox.add([d, b]));

        const list = await ro((tx) => tx.outbox.list());

        expect(list).toEqual([a, b, c, d]);
      });

      it("list(limit) returns the oldest `limit` deltas", async () => {
        const deltas = [5, 3, 1, 4, 2].map((n) => setDelta({ timestamp: ts(n), value: n }));
        await rw((tx) => tx.outbox.add(deltas));

        const list = await ro((tx) => tx.outbox.list(2));

        expect(list).toEqual([
          setDelta({ timestamp: ts(1), value: 1 }),
          setDelta({ timestamp: ts(2), value: 2 }),
        ]);
      });

      it("list on an empty outbox returns an empty array", async () => {
        const list = await ro((tx) => tx.outbox.list());

        expect(list).toEqual([]);
      });

      it("count returns the number of pending deltas", async () => {
        const before = await ro((tx) => tx.outbox.count());

        expect(before).toBe(0);

        await rw((tx) =>
          tx.outbox.add([
            setDelta({ timestamp: ts(1) }),
            setDelta({ timestamp: ts(2) }),
            deleteDelta({ timestamp: ts(3) }),
          ]),
        );

        const after = await ro((tx) => tx.outbox.count());

        expect(after).toBe(3);
      });

      it("moveToHistory removes deltas from the outbox and adds them to history", async () => {
        const deltas = [1, 2, 3].map((n) => setDelta({ timestamp: ts(n), value: n }));
        await rw((tx) => tx.outbox.add(deltas));

        await rw((tx) => tx.outbox.moveToHistory([ts(1), ts(3)]));

        const list = await ro((tx) => tx.outbox.list());
        const count = await ro((tx) => tx.outbox.count());
        const history = await ro((tx) => tx.history.has([ts(1), ts(2), ts(3)]));

        expect(list).toEqual([deltas[1]]);
        expect(count).toBe(1);
        expect(history).toEqual(new Set([ts(1), ts(3)]));
      });

      it("moveToHistory ignores timestamps not in the outbox", async () => {
        const delta = setDelta({ timestamp: ts(1) });
        await rw((tx) => tx.outbox.add([delta]));

        await rw((tx) => tx.outbox.moveToHistory([ts(9)]));

        const list = await ro((tx) => tx.outbox.list());
        const history = await ro((tx) => tx.history.has([ts(1), ts(9)]));

        expect(list).toEqual([delta]);
        expect(history).toEqual(new Set());
      });

      it("moved deltas still count for latest and deleted", async () => {
        await rw((tx) =>
          tx.outbox.add([
            setDelta({ timestamp: ts(1) }),
            deleteDelta({ timestamp: ts(2), objectId: "obj-2" }),
          ]),
        );
        await rw((tx) => tx.outbox.moveToHistory([ts(1), ts(2)]));

        const latest = await ro((tx) => tx.latest([cell()]));
        const deleted = await ro((tx) => tx.deleted([obj("obj-2")]));

        expect(latest).toEqual(new Map([[deltaKey(cell()), ts(1)]]));
        expect(deleted).toEqual(new Set([objectKey(obj("obj-2"))]));
      });

      it("set and delete deltas round-trip through list unchanged", async () => {
        const deltas = [
          setDelta({
            timestamp: ts(1),
            value: { a: [1, "x", null, { b: true }], n: 1.5, s: "", nested: { deep: [[]] } },
          }),
          setDelta({ timestamp: ts(2), column: "s", value: "text" }),
          setDelta({ timestamp: ts(3), column: "n", value: -42 }),
          setDelta({ timestamp: ts(4), column: "b", value: false }),
          setDelta({ timestamp: ts(5), column: "z", value: null }),
          setDelta({ timestamp: ts(6), column: "arr", value: [1, [2, { c: "d" }]] }),
          deleteDelta({ timestamp: ts(7), objectId: "obj-2", table: otherTable }),
        ];
        await rw((tx) => tx.outbox.add(deltas));

        const list = await ro((tx) => tx.outbox.list());

        expect(list).toEqual(deltas);
      });
    });

    describe("history", () => {
      it("has returns exactly the stored subset", async () => {
        await rw((tx) =>
          tx.history.add([setDelta({ timestamp: ts(1) }), deleteDelta({ timestamp: ts(2) })]),
        );

        const stored = await ro((tx) => tx.history.has([ts(1), ts(2), ts(3)]));
        const unknown = await ro((tx) => tx.history.has([ts(3)]));
        const empty = await ro((tx) => tx.history.has([]));

        expect(stored).toEqual(new Set([ts(1), ts(2)]));
        expect(unknown).toEqual(new Set());
        expect(empty).toEqual(new Set());
      });

      it("has does not see outbox deltas", async () => {
        await rw((tx) => tx.outbox.add([setDelta({ timestamp: ts(1) })]));

        const history = await ro((tx) => tx.history.has([ts(1)]));

        expect(history).toEqual(new Set());
      });

      it("add with an already-stored timestamp skips it without error or overwrite", async () => {
        const otherCell = cell({ objectId: "obj-2", column: "body" });
        await rw((tx) => tx.history.add([setDelta({ timestamp: ts(1) })]));

        await expect(
          rw((tx) =>
            tx.history.add([
              setDelta({ timestamp: ts(1), objectId: "obj-2", column: "body", value: "new" }),
              deleteDelta({ timestamp: ts(1), objectId: "obj-3" }),
            ]),
          ),
        ).resolves.toBeUndefined();

        const latest = await ro((tx) => tx.latest([cell(), otherCell]));
        const deleted = await ro((tx) => tx.deleted([obj("obj-3")]));

        expect(latest).toEqual(new Map([[deltaKey(cell()), ts(1)]]));
        expect(deleted).toEqual(new Set());
      });

      it("add skips a timestamp that was moved from the outbox", async () => {
        await rw((tx) => tx.outbox.add([setDelta({ timestamp: ts(1) })]));
        await rw((tx) => tx.outbox.moveToHistory([ts(1)]));

        await rw((tx) => tx.history.add([deleteDelta({ timestamp: ts(1), objectId: "obj-2" })]));

        const latest = await ro((tx) => tx.latest([cell()]));
        const deleted = await ro((tx) => tx.deleted([obj("obj-2")]));

        expect(latest).toEqual(new Map([[deltaKey(cell()), ts(1)]]));
        expect(deleted).toEqual(new Set());
      });
    });

    describe("latest", () => {
      it("returns the newest timestamp from history", async () => {
        await rw((tx) =>
          tx.history.add([
            setDelta({ timestamp: ts(3) }),
            setDelta({ timestamp: ts(5) }),
            setDelta({ timestamp: ts(1) }),
          ]),
        );

        const latest = await ro((tx) => tx.latest([cell()]));

        expect(latest).toEqual(new Map([[deltaKey(cell()), ts(5)]]));
      });

      it("returns the newest timestamp from the outbox", async () => {
        await rw((tx) =>
          tx.outbox.add([setDelta({ timestamp: ts(4) }), setDelta({ timestamp: ts(2) })]),
        );

        const latest = await ro((tx) => tx.latest([cell()]));

        expect(latest).toEqual(new Map([[deltaKey(cell()), ts(4)]]));
      });

      it("prefers a newer outbox delta over history", async () => {
        await rw(async (tx) => {
          await tx.history.add([setDelta({ timestamp: ts(2) })]);
          await tx.outbox.add([setDelta({ timestamp: ts(7) })]);
        });

        const latest = await ro((tx) => tx.latest([cell()]));

        expect(latest).toEqual(new Map([[deltaKey(cell()), ts(7)]]));
      });

      it("prefers a newer history delta over the outbox", async () => {
        await rw(async (tx) => {
          await tx.outbox.add([setDelta({ timestamp: ts(2) })]);
          await tx.history.add([setDelta({ timestamp: ts(7) })]);
        });

        const latest = await ro((tx) => tx.latest([cell()]));

        expect(latest).toEqual(new Map([[deltaKey(cell()), ts(7)]]));
      });

      it("orders timestamps by HLC, including logical time and node id", async () => {
        const a = cell({ column: "a" });
        const b = cell({ column: "b" });
        await rw(async (tx) => {
          await tx.history.add([
            setDelta({ ...a, timestamp: hlc(10, 9) }),
            setDelta({ ...a, timestamp: hlc(10, 10) }),
            setDelta({ ...b, timestamp: ts(10, "node-b") }),
            setDelta({ ...b, timestamp: ts(10, "node-a") }),
          ]);
        });

        const latest = await ro((tx) => tx.latest([a, b]));

        expect(latest).toEqual(
          new Map([
            [deltaKey(a), hlc(10, 10)],
            [deltaKey(b), ts(10, "node-b")],
          ]),
        );
      });

      it("omits cells with no deltas", async () => {
        await rw((tx) => tx.history.add([setDelta({ timestamp: ts(1) })]));

        const missing = cell({ column: "missing" });
        const latest = await ro((tx) => tx.latest([cell(), missing]));
        const empty = await ro((tx) => tx.latest([]));

        expect(latest).toEqual(new Map([[deltaKey(cell()), ts(1)]]));
        expect(empty).toEqual(new Map());
      });

      it("keys the map with deltaKey", async () => {
        const target = cell({ objectId: 'quote"d,[id]', column: "col/with:chars" });
        await rw((tx) => tx.history.add([setDelta({ ...target, timestamp: ts(1) })]));

        const result = await ro((tx) => tx.latest([target]));

        expect([...result.keys()]).toEqual([deltaKey(target)]);
      });

      it("keeps cells differing only by table, objectId or column separate", async () => {
        const base = cell();
        const byTable = cell({ table: otherTable });
        const byObject = cell({ objectId: "obj-2" });
        const byColumn = cell({ column: "body" });
        await rw(async (tx) => {
          await tx.history.add([
            setDelta({ ...base, timestamp: ts(1) }),
            setDelta({ ...byTable, timestamp: ts(2) }),
          ]);
          await tx.outbox.add([
            setDelta({ ...byObject, timestamp: ts(3) }),
            setDelta({ ...byColumn, timestamp: ts(4) }),
          ]);
        });

        const latest = await ro((tx) => tx.latest([base, byTable, byObject, byColumn]));
        const latestByObject = await ro((tx) => tx.latest([byObject]));

        expect(latest).toEqual(
          new Map([
            [deltaKey(base), ts(1)],
            [deltaKey(byTable), ts(2)],
            [deltaKey(byObject), ts(3)],
            [deltaKey(byColumn), ts(4)],
          ]),
        );
        expect(latestByObject).toEqual(new Map([[deltaKey(byObject), ts(3)]]));
      });

      it("accepts duplicate cells in the input", async () => {
        await rw((tx) => tx.history.add([setDelta({ timestamp: ts(1) })]));

        const latest = await ro((tx) => tx.latest([cell(), cell(), { ...cell() }]));

        expect(latest).toEqual(new Map([[deltaKey(cell()), ts(1)]]));
      });

      it("ignores delete deltas", async () => {
        const deletedOnly = cell({ objectId: "obj-2" });
        await rw(async (tx) => {
          await tx.history.add([
            setDelta({ timestamp: ts(1) }),
            deleteDelta({ timestamp: ts(5) }),
            deleteDelta({ timestamp: ts(6), objectId: "obj-2" }),
          ]);
          await tx.outbox.add([deleteDelta({ timestamp: ts(9) })]);
        });

        const latest = await ro((tx) => tx.latest([cell(), deletedOnly]));

        expect(latest).toEqual(new Map([[deltaKey(cell()), ts(1)]]));
      });

      it("handles 5,000 cells", async () => {
        const count = 5000;
        const cells = Array.from({ length: count }, (_, i) => cell({ objectId: `obj-${i}` }));
        await rw((tx) =>
          tx.history.add(cells.map((c, i) => setDelta({ ...c, timestamp: ts(i + 1) }))),
        );
        const missing = Array.from({ length: count }, (_, i) => cell({ objectId: `missing-${i}` }));

        const result = await ro((tx) => tx.latest([...cells, ...missing]));

        expect(result).toEqual(new Map(cells.map((c, i) => [deltaKey(c), ts(i + 1)])));
      }, 30_000);
    });

    describe("deleted", () => {
      it("finds deletes in history", async () => {
        await rw((tx) => tx.history.add([deleteDelta({ timestamp: ts(1) })]));

        const deleted = await ro((tx) => tx.deleted([obj("obj-1")]));

        expect(deleted).toEqual(new Set([objectKey(obj("obj-1"))]));
      });

      it("finds deletes in the outbox", async () => {
        await rw((tx) => tx.outbox.add([deleteDelta({ timestamp: ts(1) })]));

        const deleted = await ro((tx) => tx.deleted([obj("obj-1")]));

        expect(deleted).toEqual(new Set([objectKey(obj("obj-1"))]));
      });

      it("ignores set deltas", async () => {
        await rw(async (tx) => {
          await tx.history.add([setDelta({ timestamp: ts(1) })]);
          await tx.outbox.add([setDelta({ timestamp: ts(2) })]);
        });

        const deleted = await ro((tx) => tx.deleted([obj("obj-1")]));

        expect(deleted).toEqual(new Set());
      });

      it("builds entries with objectKey", async () => {
        const target = obj('quote"d,[id]');
        await rw((tx) => tx.history.add([deleteDelta({ ...target, timestamp: ts(1) })]));

        const result = await ro((tx) => tx.deleted([target]));

        expect([...result]).toEqual([objectKey(target)]);
      });

      it("does not report the same objectId in another table", async () => {
        await rw((tx) => tx.history.add([deleteDelta({ timestamp: ts(1) })]));

        const deleted = await ro((tx) => tx.deleted([obj("obj-1", otherTable)]));

        expect(deleted).toEqual(new Set());
      });

      it("omits objects without deletes", async () => {
        await rw((tx) => tx.outbox.add([deleteDelta({ timestamp: ts(1) })]));

        const deleted = await ro((tx) => tx.deleted([obj("obj-1"), obj("obj-2"), obj("obj-1")]));
        const empty = await ro((tx) => tx.deleted([]));

        expect(deleted).toEqual(new Set([objectKey(obj("obj-1"))]));
        expect(empty).toEqual(new Set());
      });

      it("handles 5,000 objects", async () => {
        const count = 5000;
        const objects = Array.from({ length: count }, (_, i) => obj(`obj-${i}`));
        await rw((tx) =>
          tx.history.add(objects.map((o, i) => deleteDelta({ ...o, timestamp: ts(i + 1) }))),
        );
        const missing = Array.from({ length: count }, (_, i) => obj(`missing-${i}`));

        const result = await ro((tx) => tx.deleted([...objects, ...missing]));

        expect(result).toEqual(new Set(objects.map((o) => objectKey(o))));
      }, 30_000);
    });

    describe("meta", () => {
      it("get returns undefined for an unset key", async () => {
        const cursor = await ro((tx) => tx.meta.get("cursor"));

        expect(cursor).toBeUndefined();
      });

      it("set then get round-trips", async () => {
        await rw((tx) => tx.meta.set("cursor", "abc"));

        const cursor = await ro((tx) => tx.meta.get("cursor"));
        const clock = await ro((tx) => tx.meta.get("clock"));

        expect(cursor).toBe("abc");
        expect(clock).toBeUndefined();
      });

      it("set overwrites the existing value", async () => {
        await rw((tx) => tx.meta.set("nodeId", "first"));
        await rw((tx) => tx.meta.set("nodeId", "second"));

        const nodeId = await ro((tx) => tx.meta.get("nodeId"));

        expect(nodeId).toBe("second");
      });
    });

    describe("transactions", () => {
      it("returns the callback's result", async () => {
        const written = await rw(async () => ({ ok: 1 }));
        const read = await ro(async (tx) => {
          const count = await tx.outbox.count();
          return count + 41;
        });

        expect(written).toEqual({ ok: 1 });
        expect(read).toBe(41);
      });

      it("reads its own writes", async () => {
        const result = await rw(async (tx) => {
          await tx.rows.upsert(table, "obj-1", { title: "hello" });
          await tx.outbox.add([
            setDelta({ timestamp: ts(1) }),
            deleteDelta({ timestamp: ts(2), objectId: "obj-2" }),
          ]);
          await tx.history.add([setDelta({ timestamp: ts(3), column: "body" })]);
          await tx.meta.set("cursor", "c1");

          const row = await tx.rows.get(table, "obj-1");
          const list = await tx.outbox.list();
          const count = await tx.outbox.count();
          const has = await tx.history.has([ts(1), ts(3)]);
          const latest = await tx.latest([cell(), cell({ column: "body" })]);
          const deleted = await tx.deleted([obj("obj-2")]);
          const meta = await tx.meta.get("cursor");

          return { row, list, count, has, latest, deleted, meta };
        });

        expect(result).toEqual({
          row: { id: "obj-1", title: "hello" },
          list: [
            setDelta({ timestamp: ts(1) }),
            deleteDelta({ timestamp: ts(2), objectId: "obj-2" }),
          ],
          count: 2,
          has: new Set([ts(3)]),
          latest: new Map([
            [deltaKey(cell()), ts(1)],
            [deltaKey(cell({ column: "body" })), ts(3)],
          ]),
          deleted: new Set([objectKey(obj("obj-2"))]),
          meta: "c1",
        });
      });

      it("sees its own moveToHistory and row delete before commit", async () => {
        const result = await rw(async (tx) => {
          await tx.rows.upsert(table, "obj-1", { title: "hello" });
          await tx.outbox.add([
            setDelta({ timestamp: ts(1) }),
            deleteDelta({ timestamp: ts(2), objectId: "obj-2" }),
          ]);
          await tx.history.add([setDelta({ timestamp: ts(3), column: "body" })]);

          await tx.outbox.moveToHistory([ts(1)]);
          await tx.rows.delete(table, "obj-1");

          const row = await tx.rows.get(table, "obj-1");
          const count = await tx.outbox.count();
          const has = await tx.history.has([ts(1), ts(3)]);

          return { row, count, has };
        });

        expect(result).toEqual({ row: undefined, count: 1, has: new Set([ts(3), ts(1)]) });
      });

      it("persists writes across transactions and read mode can read them", async () => {
        await rw(async (tx) => {
          await tx.rows.upsert(table, "obj-1", { title: "hello" });
          await tx.outbox.add([setDelta({ timestamp: ts(1) })]);
          await tx.history.add([deleteDelta({ timestamp: ts(2), objectId: "obj-2" })]);
          await tx.meta.set("userId", "u1");
        });

        const result = await ro(async (tx) => {
          const row = await tx.rows.get(table, "obj-1");
          const list = await tx.outbox.list();
          const has = await tx.history.has([ts(2)]);
          const latest = await tx.latest([cell()]);
          const deleted = await tx.deleted([obj("obj-2")]);
          const meta = await tx.meta.get("userId");

          return { row, list, has, latest, deleted, meta };
        });

        expect(result).toEqual({
          row: { id: "obj-1", title: "hello" },
          list: [setDelta({ timestamp: ts(1) })],
          has: new Set([ts(2)]),
          latest: new Map([[deltaKey(cell()), ts(1)]]),
          deleted: new Set([objectKey(obj("obj-2"))]),
          meta: "u1",
        });
      });

      it("rolls back every write and rethrows when the callback throws", async () => {
        await rw(async (tx) => {
          await tx.rows.upsert(table, "keep", { title: "original" });
          await tx.rows.upsert(table, "doomed", { title: "still here" });
          await tx.outbox.add([setDelta({ timestamp: ts(1) }), setDelta({ timestamp: ts(2) })]);
          await tx.history.add([setDelta({ timestamp: ts(3), column: "body" })]);
          await tx.meta.set("cursor", "before");
        });

        const error = new Error("boom");
        const failing = rw(async (tx) => {
          await tx.rows.upsert(table, "keep", { title: "changed", extra: true });
          await tx.rows.upsert(table, "new", { title: "new" });
          await tx.rows.delete(table, "doomed");
          await tx.outbox.add([
            setDelta({ timestamp: ts(4) }),
            deleteDelta({ timestamp: ts(5), objectId: "obj-9" }),
          ]);
          await tx.outbox.moveToHistory([ts(1)]);
          await tx.history.add([
            setDelta({ timestamp: ts(6), column: "body" }),
            deleteDelta({ timestamp: ts(7), objectId: "obj-8" }),
          ]);
          await tx.meta.set("cursor", "after");
          await tx.meta.set("clock", "set");
          throw error;
        });

        await expect(failing).rejects.toBe(error);

        const state = await ro(async (tx) => {
          const keep = await tx.rows.get(table, "keep");
          const doomed = await tx.rows.get(table, "doomed");
          const created = await tx.rows.get(table, "new");
          const outbox = await tx.outbox.list();
          const count = await tx.outbox.count();
          const history = await tx.history.has([ts(1), ts(2), ts(3), ts(4), ts(5), ts(6), ts(7)]);
          const latest = await tx.latest([cell(), cell({ column: "body" })]);
          const deleted = await tx.deleted([obj("obj-8"), obj("obj-9")]);
          const cursor = await tx.meta.get("cursor");
          const clock = await tx.meta.get("clock");

          return { keep, doomed, created, outbox, count, history, latest, deleted, cursor, clock };
        });

        expect(state).toEqual({
          keep: { id: "keep", title: "original" },
          doomed: { id: "doomed", title: "still here" },
          created: undefined,
          outbox: [setDelta({ timestamp: ts(1) }), setDelta({ timestamp: ts(2) })],
          count: 2,
          history: new Set([ts(3)]),
          latest: new Map([
            [deltaKey(cell()), ts(2)],
            [deltaKey(cell({ column: "body" })), ts(3)],
          ]),
          deleted: new Set(),
          cursor: "before",
          clock: undefined,
        });
      });

      it("works normally after a failed transaction", async () => {
        const error = new Error("boom");
        await expect(
          rw(async (tx) => {
            await tx.meta.set("cursor", "lost");
            throw error;
          }),
        ).rejects.toBe(error);

        await rw((tx) => tx.meta.set("cursor", "kept"));

        const cursor = await ro((tx) => tx.meta.get("cursor"));

        expect(cursor).toBe("kept");
      });

      it("does not interleave concurrent readwrite transactions", async () => {
        await rw((tx) => tx.meta.set("cursor", "0"));

        const increment = () =>
          rw(async (tx) => {
            const cursor = await tx.meta.get("cursor");
            const current = Number(cursor ?? "0");
            await tx.rows.get(table, "obj-1");
            await tx.outbox.count();
            await tx.history.has([ts(1)]);
            await tx.latest([cell()]);
            await tx.meta.set("cursor", String(current + 1));
          });

        await Promise.all([increment(), increment()]);

        const cursor = await ro((tx) => tx.meta.get("cursor"));

        expect(cursor).toBe("2");
      });
    });
  });
};
