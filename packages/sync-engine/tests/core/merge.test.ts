import { describe, expect, it } from "vitest";
import { getDeltaKey, type Delta, type DeltaKey, type SetDelta } from "#core/delta";
import { HLCTimestamp } from "#core/hlc/timestamp";
import { planMerge } from "#core/merge";
import { getObjectKey, type ObjectKey } from "#core/object";

const TABLE = "todos";
const OBJECT = "obj-1";

// Timestamps are compared as strings, so zero-padding keeps them ordered.
const t = (n: number) => `t${String(n).padStart(4, "0")}`;

const delta = (
  timestamp: string,
  column: string,
  value: unknown,
  { table = TABLE, objectId = OBJECT } = {},
): SetDelta => ({ kind: "set", timestamp, table, objectId, column, value });

const tombstone = (
  timestamp: string,
  { table = TABLE, objectId = OBJECT }: { table?: string; objectId?: string } = {},
): Delta => ({ kind: "delete", timestamp, table, objectId });

const plan = ({
  incoming = [] as Delta[],
  latest = new Map<DeltaKey, string>(),
  deleted = new Set<ObjectKey>(),
  knownTimestamps = new Set<string>(),
} = {}) => planMerge({ incoming, latest, deleted, knownTimestamps });

describe("planMerge", () => {
  it("returns an empty plan for no incoming deltas", () => {
    expect(plan()).toEqual({ writes: [], historyAdds: [], maxTimestamp: null });
  });

  it("combines columns of one object into a single patch", () => {
    const a = delta(t(1), "title", "hello");
    const b = delta(t(2), "done", false);

    const result = plan({ incoming: [a, b] });

    expect(result.writes).toEqual([
      { kind: "patch", table: TABLE, objectId: OBJECT, patch: { title: "hello", done: false } },
    ]);
    expect(result.historyAdds).toEqual([a, b]);
    expect(result.maxTimestamp).toBe(t(2));
  });

  describe("same cell", () => {
    it("keeps the later value when given in reverse order", () => {
      const later = delta(t(2), "title", "second");
      const earlier = delta(t(1), "title", "first");

      const result = plan({ incoming: [later, earlier] });

      expect(result.writes).toEqual([
        { kind: "patch", table: TABLE, objectId: OBJECT, patch: { title: "second" } },
      ]);
      expect(result.historyAdds).toEqual([earlier, later]);
      expect(result.maxTimestamp).toBe(t(2));
    });

    it("skips the write when the local cell is newer, but still records history", () => {
      const incoming = delta(t(1), "title", "stale");
      const latest = new Map<DeltaKey, string>([[getDeltaKey(incoming), t(5)]]);

      const result = plan({ incoming: [incoming], latest });

      expect(result.writes).toEqual([]);
      expect(result.historyAdds).toEqual([incoming]);
    });

    it("skips the write when the local cell has the same timestamp", () => {
      const incoming = delta(t(3), "title", "same");
      const latest = new Map<DeltaKey, string>([[getDeltaKey(incoming), t(3)]]);

      expect(plan({ incoming: [incoming], latest }).writes).toEqual([]);
    });

    it("writes when the incoming delta is newer than the local cell", () => {
      const incoming = delta(t(5), "title", "fresh");
      const latest = new Map<DeltaKey, string>([[getDeltaKey(incoming), t(1)]]);

      expect(plan({ incoming: [incoming], latest }).writes).toEqual([
        { kind: "patch", table: TABLE, objectId: OBJECT, patch: { title: "fresh" } },
      ]);
    });
  });

  describe("tombstones", () => {
    it("turns a patch followed by a tombstone into a delete", () => {
      const patch = delta(t(1), "title", "hello");
      const del = tombstone(t(2));

      const result = plan({ incoming: [patch, del] });

      expect(result.writes).toEqual([{ kind: "delete", table: TABLE, objectId: OBJECT }]);
      expect(result.historyAdds).toEqual([patch, del]);
    });

    it("keeps the delete when a patch follows the tombstone, and records the patch in history", () => {
      const del = tombstone(t(1));
      const patch = delta(t(2), "title", "too late");

      const result = plan({ incoming: [patch, del] });

      expect(result.writes).toEqual([{ kind: "delete", table: TABLE, objectId: OBJECT }]);
      expect(result.historyAdds).toEqual([del, patch]);
    });

    it("ignores patches for objects already deleted locally, but records history", () => {
      const patch = delta(t(1), "title", "ghost");

      const result = plan({
        incoming: [patch],
        deleted: new Set([getObjectKey({ table: TABLE, objectId: OBJECT })]),
      });

      expect(result.writes).toEqual([]);
      expect(result.historyAdds).toEqual([patch]);
    });

    it("ignores tombstones for objects already deleted locally, but records history", () => {
      const del = tombstone(t(1));

      const result = plan({
        incoming: [del],
        deleted: new Set([getObjectKey({ table: TABLE, objectId: OBJECT })]),
      });

      expect(result.writes).toEqual([]);
      expect(result.historyAdds).toEqual([del]);
    });
  });

  describe("same objectId in two tables", () => {
    it("produces two writes", () => {
      const a = delta(t(1), "title", "todo", { table: "todos" });
      const b = delta(t(2), "name", "project", { table: "projects" });

      const result = plan({ incoming: [a, b] });

      expect(result.writes).toEqual([
        { kind: "patch", table: "todos", objectId: OBJECT, patch: { title: "todo" } },
        { kind: "patch", table: "projects", objectId: OBJECT, patch: { name: "project" } },
      ]);
    });

    it("only deletes the object in the tombstoned table", () => {
      const del = tombstone(t(1), { table: "todos" });
      const patch = delta(t(2), "name", "project", { table: "projects" });

      const result = plan({ incoming: [del, patch] });

      expect(result.writes).toEqual([
        { kind: "delete", table: "todos", objectId: OBJECT },
        { kind: "patch", table: "projects", objectId: OBJECT, patch: { name: "project" } },
      ]);
    });

    it("does not block patches when the object is deleted locally in another table", () => {
      const patch = delta(t(1), "name", "project", { table: "projects" });

      const result = plan({
        incoming: [patch],
        deleted: new Set([getObjectKey({ table: "todos", objectId: OBJECT })]),
      });

      expect(result.writes).toEqual([
        { kind: "patch", table: "projects", objectId: OBJECT, patch: { name: "project" } },
      ]);
    });
  });

  describe("known timestamps", () => {
    it("produces no write and no history add for a known timestamp", () => {
      const known = delta(t(1), "title", "already have it");

      const result = plan({ incoming: [known], knownTimestamps: new Set([t(1)]) });

      expect(result.writes).toEqual([]);
      expect(result.historyAdds).toEqual([]);
    });

    it("deduplicates repeated timestamps within one batch", () => {
      const a = delta(t(1), "title", "once");

      const result = plan({ incoming: [a, { ...a }] });

      expect(result.historyAdds).toEqual([a]);
      expect(result.writes).toHaveLength(1);
    });

    it("still reports the newest incoming timestamp when every delta is known", () => {
      const result = plan({
        incoming: [delta(t(1), "title", "a"), delta(t(2), "done", true)],
        knownTimestamps: new Set([t(1), t(2)]),
      });

      expect(result.writes).toEqual([]);
      expect(result.historyAdds).toEqual([]);
      expect(result.maxTimestamp).toBe(t(2));
    });
  });

  describe("real HLC timestamps", () => {
    it("orders them the same way HLCTimestamp.compare does", () => {
      const stamps = [
        new HLCTimestamp(1_000, 0, "node-b"),
        new HLCTimestamp(10_000, 0, "a"),
        new HLCTimestamp(999, 5, "node-z"),
        new HLCTimestamp(1_000, 0, "node-a"),
        new HLCTimestamp(1_000, 1, "node-a"),
      ];
      const incoming = stamps.map((stamp) => delta(stamp.toString(), "title", stamp.toString()));
      const expected = stamps.toSorted((a, b) => a.compare(b)).map((stamp) => stamp.toString());

      const result = plan({ incoming });

      expect(result.historyAdds.map((d) => d.timestamp)).toEqual(expected);
      expect(result.writes).toEqual([
        { kind: "patch", table: TABLE, objectId: OBJECT, patch: { title: expected.at(-1) } },
      ]);
    });

    it("breaks ties on equal physical and logical time by nodeId, in any arrival order", () => {
      const fromA = delta(new HLCTimestamp(1_000, 0, "node-a").toString(), "title", "from a");
      const fromB = delta(new HLCTimestamp(1_000, 0, "node-b").toString(), "title", "from b");

      for (const incoming of [
        [fromA, fromB],
        [fromB, fromA],
      ]) {
        expect(plan({ incoming }).writes).toEqual([
          { kind: "patch", table: TABLE, objectId: OBJECT, patch: { title: "from b" } },
        ]);
      }
    });
  });

  it("does not mutate its inputs", () => {
    const incoming = [
      delta(t(2), "title", "b"),
      tombstone(t(3), { objectId: "obj-2" }),
      delta(t(1), "title", "a"),
    ];
    const latest = new Map<DeltaKey, string>([
      [getDeltaKey(delta(t(0), "title", null, { objectId: "obj-3" })), t(0)],
    ]);
    const deleted = new Set<ObjectKey>([getObjectKey({ table: TABLE, objectId: "obj-4" })]);
    const knownTimestamps = new Set([t(9)]);

    const snapshot = {
      incoming: incoming.map((d) => ({ ...d })),
      latest: new Map(latest),
      deleted: new Set(deleted),
      knownTimestamps: new Set(knownTimestamps),
    };

    plan({ incoming, latest, deleted, knownTimestamps });

    expect(incoming).toEqual(snapshot.incoming);
    expect(latest).toEqual(snapshot.latest);
    expect(deleted).toEqual(snapshot.deleted);
    expect(knownTimestamps).toEqual(snapshot.knownTimestamps);
  });

  it("stores a __proto__ column as an own key on the patch", () => {
    const value = { polluted: true };
    const result = plan({ incoming: [delta(t(1), "__proto__", value)] });

    const write = result.writes[0];
    if (write?.kind !== "patch") throw new Error("expected a patch write");
    expect(Object.hasOwn(write.patch, "__proto__")).toBe(true);
    expect(Object.getOwnPropertyDescriptor(write.patch, "__proto__")?.value).toBe(value);
  });

  it("does not confuse objects whose table/id differ only by NUL placement", () => {
    const a = { objectId: "c", table: "a\u0000b" };
    const b = { objectId: "b\u0000c", table: "a" };

    const result = plan({
      incoming: [tombstone(t(2), a), delta(t(1), "title", "x", b)],
    });

    expect(result.writes).toHaveLength(2);
    expect(result.writes).toContainEqual({ kind: "delete", table: a.table, objectId: a.objectId });
    expect(result.writes).toContainEqual({
      kind: "patch",
      table: b.table,
      objectId: b.objectId,
      patch: { title: "x" },
    });
  });
});

describe("planMerge convergence", () => {
  type Row = { table: string; objectId: string; values: Record<string, unknown> };

  // Minimal replica: rows plus delta history. `latest` and known timestamps are
  // derived from history rather than stored.
  const createReplica = () => ({
    rows: new Map<ObjectKey, Row>(),
    deleted: new Set<ObjectKey>(),
    history: [] as Delta[],
  });
  type Replica = ReturnType<typeof createReplica>;

  const receive = (replica: Replica, incoming: Delta[]) => {
    const latest = new Map<DeltaKey, string>();
    for (const d of replica.history) {
      if (d.kind !== "set") continue;
      const key = getDeltaKey(d);
      const current = latest.get(key);
      if (current === undefined || current < d.timestamp) latest.set(key, d.timestamp);
    }

    const result = planMerge({
      incoming,
      latest,
      deleted: replica.deleted,
      knownTimestamps: new Set(replica.history.map((d) => d.timestamp)),
    });

    for (const write of result.writes) {
      const key = getObjectKey(write);
      if (write.kind === "delete") {
        replica.rows.delete(key);
        replica.deleted.add(key);
        continue;
      }
      const row = replica.rows.get(key) ?? {
        table: write.table,
        objectId: write.objectId,
        values: {},
      };
      row.values = { ...row.values, ...write.patch };
      replica.rows.set(key, row);
    }
    replica.history.push(...result.historyAdds);
  };

  const snapshot = (replica: Replica) => ({
    rows: [...replica.rows.values()].toSorted((a, b) => (a.objectId < b.objectId ? -1 : 1)),
    deleted: [...replica.deleted].toSorted(),
  });

  const deltas: Delta[] = [
    delta(t(1), "title", "a"),
    delta(t(2), "done", false),
    delta(t(3), "title", "b"),
    delta(t(4), "title", "c", { objectId: "obj-2" }),
    tombstone(t(5), { objectId: "obj-2" }),
    delta(t(6), "title", "after delete", { objectId: "obj-2" }),
    delta(t(7), "done", true),
    delta(t(8), "title", "x", { objectId: "obj-3" }),
  ];

  const orders: Record<string, Delta[]> = {
    forward: deltas,
    reverse: deltas.toReversed(),
    interleaved: [5, 0, 7, 3, 6, 1, 4, 2].map((i) => deltas[i]!),
  };

  const batchings: Record<string, (list: Delta[]) => Delta[][]> = {
    "one batch": (list) => [list],
    "one at a time": (list) => list.map((d) => [d]),
    pairs: (list) => list.flatMap((d, i) => (i % 2 === 0 ? [list.slice(i, i + 2)] : [])),
    redelivered: (list) => [list.slice(0, 5), list, list.slice(3)],
  };

  const expected = {
    rows: [
      { table: TABLE, objectId: OBJECT, values: { title: "b", done: true } },
      { table: TABLE, objectId: "obj-3", values: { title: "x" } },
    ],
    deleted: [getObjectKey({ table: TABLE, objectId: "obj-2" })],
  };

  for (const [orderName, order] of Object.entries(orders)) {
    for (const [batchingName, batch] of Object.entries(batchings)) {
      it(`reaches the same state for ${orderName} order, ${batchingName}`, () => {
        const replica = createReplica();
        for (const incoming of batch(order)) receive(replica, incoming);

        expect(snapshot(replica)).toEqual(expected);
        expect(replica.history).toHaveLength(deltas.length);
      });
    }
  }
});
