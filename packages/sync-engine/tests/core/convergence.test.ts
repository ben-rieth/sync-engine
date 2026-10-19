import {
  array,
  assert,
  asyncProperty,
  boolean,
  constant,
  constantFrom,
  nat,
  oneof,
  record,
  type Arbitrary,
} from "fast-check";
import { describe, expect, it } from "vitest";
import { clientMemoryStorage } from "#adapters/client-memory";
import { serverMemoryDatabase } from "#adapters/server-memory";
import { memoryTransport, type MemoryTransport } from "#adapters/transport-memory";
import type { SyncClientOptions } from "#core/client/client";
import type { Delta } from "#core/delta";
import { compareTimestamps } from "#core/hlc/timestamp";
import type { Result } from "#core/result";
import type { ServerDatabaseAdapter } from "#core/server/server";
import type { Transport } from "#core/server/transport";
import type { StorageAdapter } from "#core/storage";
import { openClient, read, serverDeltas, type UnwrappedClient } from "../helpers";

const TABLE = "items";
const USER = "user-1";
const START = 1_700_000_000_000;
// Few ids, so random writes often conflict
const IDS = ["obj-1", "obj-2", "obj-3"];

type Rows = Record<string, Record<string, unknown> | undefined>;

type Hooks = {
  afterPull: (() => void) | undefined;
  afterPush: (() => void) | undefined;
};

type Device = {
  client: UnwrappedClient;
  storage: StorageAdapter;
  connection: MemoryTransport;
  hooks: Hooks;
};

type NetworkOptions = {
  skews?: Record<string, number>;
  client?: Partial<SyncClientOptions>;
};

type Network<N extends string = string> = {
  server: ServerDatabaseAdapter;
  devices: Record<N, Device>;
  all: Device[];
  setTime: (value: number) => void;
  advance: (ms: number) => void;
};

const network = async <const N extends string>(
  names: readonly N[],
  options: NetworkOptions = {},
): Promise<Network<N>> => {
  let time = START;
  const server = serverMemoryDatabase({ now: () => time });

  const openDevice = async (name: N): Promise<[N, Device]> => {
    const skew = options.skews?.[name] ?? 0;
    const connection = memoryTransport(server, USER);
    const hooks: Hooks = { afterPull: undefined, afterPush: undefined };
    const transport: Transport = {
      pull: async (request) => {
        const page = await connection.pull(request);
        hooks.afterPull?.();
        return page;
      },
      push: async (request) => {
        await connection.push(request);
        hooks.afterPush?.();
      },
    };
    const storage = clientMemoryStorage();
    const client = await openClient({
      storage,
      transport,
      generateNodeId: () => `node-${name}`,
      now: () => time + skew,
      ...options.client,
    });
    return [name, { client, storage, connection, hooks }];
  };

  const entries = await Promise.all(names.map(openDevice));
  // oxlint-disable-next-line typescript/no-unsafe-type-assertion -- built from every name in `names`
  const devices = Object.fromEntries(entries) as Record<N, Device>;
  const all = entries.map(([, device]) => device);

  return {
    server,
    devices,
    all,
    setTime: (value: number) => {
      time = value;
    },
    advance: (ms: number) => {
      time += ms;
    },
  };
};

const snapshot = (device: Device): Promise<Rows> =>
  read(device.storage, async (tx) => {
    const rows = await Promise.all(IDS.map((id) => tx.rows.get(TABLE, id)));
    return Object.fromEntries(IDS.map((id, index) => [id, rows[index]]));
  });

type RowState = { row: Record<string, unknown> | undefined; deleted: boolean };

const NO_ROW: RowState = { row: undefined, deleted: false };

const readRowState = (device: Device, objectId: string): Promise<RowState> =>
  read(device.storage, async (tx) => {
    const row = await tx.rows.get(TABLE, objectId);
    const deleted = await tx.deleted([{ table: TABLE, objectId }]);
    return { row, deleted: deleted.size > 0 };
  });

const columnsOf = (values: Record<string, unknown>) =>
  Object.fromEntries(Object.entries(values).filter(([column]) => column !== "id"));

const pendingCount = (device: Device) => read(device.storage, (tx) => tx.outbox.count());

// Reference model: a delete removes the row for good; each column keeps its newest value
const expectedRows = (deltas: Delta[]): Rows => {
  const rows = new Map<string, Record<string, unknown>>();
  const newest = new Map<string, string>();
  const deleted = new Set<string>();

  for (const delta of deltas) {
    if (delta.kind === "delete") {
      deleted.add(delta.objectId);
      continue;
    }

    const cell = `${delta.objectId}.${delta.column}`;
    const current = newest.get(cell);
    if (current !== undefined && compareTimestamps(current, delta.timestamp) >= 0) {
      continue;
    }
    newest.set(cell, delta.timestamp);

    const row = rows.get(delta.objectId) ?? { id: delta.objectId };
    row[delta.column] = delta.value;
    rows.set(delta.objectId, row);
  }

  return Object.fromEntries(IDS.map((id) => [id, deleted.has(id) ? undefined : rows.get(id)]));
};

const syncInTurn = async (devices: Device[]) => {
  for (const device of devices) {
    // oxlint-disable-next-line no-await-in-loop -- devices sync one after another, like real ones taking turns
    await device.client.syncNow();
  }
};

// Two rounds: the first pushes everything, the second delivers it to early syncers
const syncAll = async (net: Network) => {
  for (const device of net.all) {
    device.connection.online = true;
    device.hooks.afterPull = undefined;
    device.hooks.afterPush = undefined;
  }

  await syncInTurn([...net.all, ...net.all]);
};

const expectConverged = async (net: Network): Promise<Rows> => {
  await syncAll(net);

  const onServer = await serverDeltas(net.server);
  const expected = expectedRows(onServer);
  const snapshots = await Promise.all(net.all.map(snapshot));
  const pending = await Promise.all(net.all.map(pendingCount));

  expect(snapshots).toEqual(net.all.map(() => expected));
  expect(pending).toEqual(net.all.map(() => 0));

  return expected;
};

const syncInOrder = async (order: ("a" | "b" | "c")[]): Promise<Rows> => {
  const net = await network(["a", "b", "c"]);
  const { a, b, c } = net.devices;

  net.setTime(START + 1000);
  await a.client.insert(TABLE, { title: "a", done: false }, { id: "obj-1" });
  net.setTime(START + 2000);
  await b.client.insert(TABLE, { title: "b" }, { id: "obj-1" });
  await b.client.insert(TABLE, { title: "b2" }, { id: "obj-2" });
  net.setTime(START + 3000);
  await c.client.insert(TABLE, { done: true }, { id: "obj-1" });
  await c.client.insert(TABLE, { title: "c3" }, { id: "obj-3" });
  await syncInTurn(order.map((name) => net.devices[name]));

  return expectConverged(net);
};

describe("convergence", () => {
  it("keeps the newer of two offline edits to the same cell", async () => {
    const net = await network(["a", "b"]);
    const { a, b } = net.devices;
    await a.client.insert(TABLE, { title: "first" }, { id: "obj-1" });
    await syncAll(net);

    net.setTime(START + 1000);
    await a.client.update(TABLE, "obj-1", { title: "from a" });
    net.setTime(START + 2000);
    await b.client.update(TABLE, "obj-1", { title: "from b" });
    const rows = await expectConverged(net);

    expect(rows["obj-1"]).toEqual({ id: "obj-1", title: "from b" });
  });

  it("keeps a newer offline edit over an older one that reached the server first", async () => {
    const net = await network(["a", "b"]);
    const { a, b } = net.devices;
    await a.client.insert(TABLE, { title: "first" }, { id: "obj-1" });
    await syncAll(net);
    a.connection.online = false;

    net.setTime(START + 1000);
    await b.client.update(TABLE, "obj-1", { title: "older" });
    await b.client.syncNow();
    net.setTime(START + 2000);
    await a.client.update(TABLE, "obj-1", { title: "newer" });
    const rows = await expectConverged(net);

    expect(rows["obj-1"]).toEqual({ id: "obj-1", title: "newer" });
  });

  it("keeps edits to different columns of one row", async () => {
    const net = await network(["a", "b"]);
    const { a, b } = net.devices;
    await a.client.insert(TABLE, { title: "first", done: false }, { id: "obj-1" });
    await syncAll(net);

    net.setTime(START + 1000);
    await a.client.update(TABLE, "obj-1", { title: "renamed" });
    net.setTime(START + 2000);
    await b.client.update(TABLE, "obj-1", { done: true });
    const rows = await expectConverged(net);

    expect(rows["obj-1"]).toEqual({ id: "obj-1", title: "renamed", done: true });
  });

  it.each(["a", "b"] as const)(
    "keeps a row deleted while another device edited it, when %s syncs first",
    async (first) => {
      const net = await network(["a", "b"]);
      const { a, b } = net.devices;
      await a.client.insert(TABLE, { title: "first" }, { id: "obj-1" });
      await syncAll(net);

      net.setTime(START + 1000);
      await a.client.delete(TABLE, "obj-1");
      net.setTime(START + 2000);
      await b.client.update(TABLE, "obj-1", { title: "edited after the delete" });
      await net.devices[first].client.syncNow();
      const rows = await expectConverged(net);

      expect(rows["obj-1"]).toBeUndefined();
    },
  );

  it("merges two offline inserts of the same id cell by cell", async () => {
    const net = await network(["a", "b"]);
    const { a, b } = net.devices;

    net.setTime(START + 1000);
    await a.client.insert(TABLE, { title: "from a", done: false }, { id: "obj-1" });
    net.setTime(START + 2000);
    await b.client.insert(TABLE, { title: "from b", note: "only b" }, { id: "obj-1" });
    const rows = await expectConverged(net);

    expect(rows["obj-1"]).toEqual({ id: "obj-1", title: "from b", done: false, note: "only b" });
  });

  it("converges after a device drops its connection mid-push", async () => {
    const net = await network(["a", "b"], { client: { pushBatchSize: 1 } });
    const { a, b } = net.devices;
    await a.client.insert(TABLE, { title: "a", done: false, note: "n" }, { id: "obj-1" });
    a.hooks.afterPush = () => {
      a.connection.online = false;
    };

    const interrupted = await a.client.raw.syncNow();
    net.setTime(START + 1000);
    await b.client.insert(TABLE, { title: "b" }, { id: "obj-2" });
    const rows = await expectConverged(net);

    expect(interrupted.error?.code).toBe("transport");
    expect(rows).toEqual({
      "obj-1": { id: "obj-1", title: "a", done: false, note: "n" },
      "obj-2": { id: "obj-2", title: "b" },
      "obj-3": undefined,
    });
  });

  it("converges after a device drops its connection mid-pull", async () => {
    const net = await network(["a", "b"], { client: { pullLimit: 1 } });
    const { a, b } = net.devices;
    await b.client.insert(TABLE, { title: "b", done: true, note: "n" }, { id: "obj-1" });
    await b.client.syncNow();
    a.hooks.afterPull = () => {
      a.connection.online = false;
    };

    const interrupted = await a.client.raw.syncNow();
    const rows = await expectConverged(net);

    expect(interrupted.error?.code).toBe("transport");
    expect(rows["obj-1"]).toEqual({ id: "obj-1", title: "b", done: true, note: "n" });
  });

  it("ends the same whichever order devices sync in", async () => {
    const forwards = await syncInOrder(["a", "b", "c"]);
    const backwards = await syncInOrder(["c", "b", "a"]);

    const expected = {
      "obj-1": { id: "obj-1", title: "b", done: true },
      "obj-2": { id: "obj-2", title: "b2" },
      "obj-3": { id: "obj-3", title: "c3" },
    };
    expect(forwards).toEqual(expected);
    expect(backwards).toEqual(expected);
  });

  describe("random operations", () => {
    const DEVICES = ["a", "b", "c"] as const;
    // Within the default drift limit, so no device's deltas are refused
    const SKEWS = { a: 0, b: -250, c: 400 };
    const deviceName = constantFrom(...DEVICES);
    const objectId = constantFrom(...IDS);
    const writeValues = record(
      {
        title: oneof(constantFrom("x", "y", "z"), constant(null), record({ n: nat(3) })),
        done: boolean(),
        id: constantFrom(...IDS, "other"),
      },
      { requiredKeys: [] },
    );
    const write = <const K extends string>(kind: K) =>
      record({ kind: constant(kind), device: deviceName, id: objectId, values: writeValues });
    const operation = oneof(
      { weight: 3, arbitrary: write("insert") },
      { weight: 3, arbitrary: write("update") },
      {
        weight: 2,
        arbitrary: record({ kind: constant("delete"), device: deviceName, id: objectId }),
      },
      { weight: 3, arbitrary: record({ kind: constant("sync"), device: deviceName }) },
      {
        weight: 1,
        arbitrary: record({ kind: constant("setOnline"), device: deviceName, online: boolean() }),
      },
      // 0 often, so one device's writes share a millisecond
      {
        weight: 1,
        arbitrary: record({ kind: constant("wait"), ms: oneof(constant(0), nat(2000)) }),
      },
    );
    type Operation = typeof operation extends Arbitrary<infer T> ? T : never;

    const perform = async (
      net: Network<(typeof DEVICES)[number]>,
      op: Operation,
    ): Promise<Result<unknown> | null> => {
      if (op.kind === "wait") {
        net.advance(op.ms);
        return null;
      }

      const { client, connection } = net.devices[op.device];
      switch (op.kind) {
        case "setOnline": {
          connection.online = op.online;
          return null;
        }
        case "insert": {
          return client.raw.insert(TABLE, op.values, { id: op.id });
        }
        case "update": {
          return client.raw.update(TABLE, op.id, op.values);
        }
        case "delete": {
          return client.raw.delete(TABLE, op.id);
        }
        case "sync": {
          return client.raw.syncNow();
        }
        default: {
          return op satisfies never;
        }
      }
    };

    const expectedCode = (op: Operation, before: RowState, online: boolean): string | undefined => {
      if (op.kind === "insert") {
        if (before.row) {
          return "row-exists";
        }
        if (before.deleted) {
          return "row-deleted";
        }
        return Object.keys(columnsOf(op.values)).length > 0 ? undefined : "no-columns";
      }
      if (op.kind === "update") {
        return before.row ? undefined : "row-not-found";
      }
      if (op.kind === "sync") {
        return online ? undefined : "transport";
      }
      return undefined;
    };

    const expectedRow = (op: Operation, before: RowState) => {
      if (op.kind === "insert") {
        return { id: op.id, ...columnsOf(op.values) };
      }
      if (op.kind === "update") {
        return { ...before.row, ...columnsOf(op.values) };
      }
      return undefined;
    };

    const runStep = async (net: Network<(typeof DEVICES)[number]>, op: Operation) => {
      let before = NO_ROW;
      if ("id" in op) {
        before = await readRowState(net.devices[op.device], op.id);
      }
      const online = "device" in op ? net.devices[op.device].connection.online : true;
      const outcome = await perform(net, op);
      const expected = expectedCode(op, before, online);

      const isWrite = op.kind === "insert" || op.kind === "update" || op.kind === "delete";
      if (isWrite) {
        const after = await readRowState(net.devices[op.device], op.id);
        const expectedAfter = outcome?.error ? before.row : expectedRow(op, before);
        expect(after.row).toEqual(expectedAfter);
        const deletedAfter = before.deleted || (op.kind === "delete" && before.row !== undefined);
        expect(after.deleted).toBe(deletedAfter);
      }

      return { actual: outcome?.error?.code, expected };
    };

    it("leaves every device matching the reference model", async () => {
      await assert(
        asyncProperty(array(operation, { maxLength: 40, size: "max" }), async (ops) => {
          const net = await network(DEVICES, {
            skews: SKEWS,
            client: { pullLimit: 2, pushBatchSize: 2 },
          });

          for (const op of ops) {
            // oxlint-disable-next-line no-await-in-loop -- operations happen in sequence
            const { actual, expected } = await runStep(net, op);
            expect(actual).toBe(expected);
          }
          await expectConverged(net);
        }),
        { numRuns: 1000 },
      );
    });
  });
});
