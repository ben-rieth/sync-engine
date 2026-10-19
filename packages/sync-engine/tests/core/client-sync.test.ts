import { describe, expect, expectTypeOf, it } from "vitest";
import { clientMemoryStorage } from "#adapters/client-memory";
import { serverMemoryDatabase, type ServerMemoryDatabaseOptions } from "#adapters/server-memory";
import { memoryTransport } from "#adapters/transport-memory";
import { type SyncClientOptions, type SyncNowError } from "#core/client/client";
import type { Delta } from "#core/delta";
import { ConfigError, TransportError } from "#core/errors";
import { ClockDriftError, LocalClockAheadError } from "#core/hlc/clock";
import { compareTimestamps, HLCTimestamp } from "#core/hlc/timestamp";
import type { PullResult, ServerDatabaseAdapter } from "#core/server/server";
import type { Transport } from "#core/server/transport";
import type { StorageAdapter, StorageTx } from "#core/storage";
import { failed, failedBecause, openClient, timestamps } from "../helpers";

const TABLE = "items";
const START = 1_700_000_000_000;
const USER = "user-1";

const ts = (physical: number, node = "node-b") => new HLCTimestamp(physical, 0, node).toString();

const set = (
  physical: number,
  objectId: string,
  column: string,
  value: unknown,
  node = "node-b",
): Delta => ({ kind: "set", timestamp: ts(physical, node), table: TABLE, objectId, column, value });

const del = (physical: number, objectId: string, node = "node-b"): Delta => ({
  kind: "delete",
  timestamp: ts(physical, node),
  table: TABLE,
  objectId,
});

type Hook = (() => Promise<void>) | undefined;

// Records calls and runs optional hooks: `beforeReturn` after the server answers a pull but before
// the client sees it; `beforePush` before a push reaches the server, `afterPush` after it has.
const spyTransport = (inner: Transport) => {
  const spy = {
    pulls: 0,
    cursors: [] as (string | null)[],
    pushes: [] as Parameters<Transport["push"]>[0][],
    beforeReturn: undefined as Hook,
    beforePush: undefined as Hook,
    afterPush: undefined as Hook,
    transport: {
      pull: async (request) => {
        spy.pulls++;
        spy.cursors.push(request.cursor);
        const result = await inner.pull(request);
        await spy.beforeReturn?.();
        return result;
      },
      push: async (request) => {
        spy.pushes.push(request);
        await spy.beforePush?.();
        await inner.push(request);
        await spy.afterPush?.();
      },
    } satisfies Transport,
  };
  return spy;
};

// Returns the given pages in order, ignoring the cursor; for responses a real server wouldn't send.
const scriptedTransport = (pages: PullResult[]): Transport => ({
  pull: async () => {
    const page = pages.shift();
    if (!page) {
      throw new Error("No more scripted pages");
    }
    return page;
  },
  push: async () => {},
});

// One local client ("node-a") on a memory server; `remote` pushes deltas as another device would.
const setup = async (
  overrides: Partial<SyncClientOptions> = {},
  serverOptions: ServerMemoryDatabaseOptions = {},
) => {
  const storage = clientMemoryStorage();
  const server = serverMemoryDatabase(serverOptions);
  const spy = spyTransport(memoryTransport(server, USER));
  let time = START;
  const options: SyncClientOptions = {
    storage,
    generateNodeId: () => "node-a",
    now: () => time,
    transport: spy.transport,
    ...overrides,
  };
  const client = await openClient(options);

  return {
    client,
    storage,
    server,
    spy,
    options,
    remote: (...deltas: Delta[]) => server.push(USER, deltas),
    setTime: (value: number) => {
      time = value;
    },
  };
};

const read = <T>(storage: StorageAdapter, fn: (tx: StorageTx) => Promise<T>): Promise<T> =>
  storage.transaction("read", fn);

const row = (storage: StorageAdapter, objectId: string) =>
  read(storage, (tx) => tx.rows.get(TABLE, objectId));

const cursor = (storage: StorageAdapter) => read(storage, (tx) => tx.meta.get("cursor"));

const storedClock = (storage: StorageAdapter) => read(storage, (tx) => tx.meta.get("clock"));

const inHistory = (storage: StorageAdapter, deltas: Delta[]) =>
  read(storage, (tx) => tx.history.has(timestamps(deltas)));

const outbox = (storage: StorageAdapter) => read(storage, (tx) => tx.outbox.list());

// Everything the server holds for USER, as another device would see it
const serverDeltas = async (server: ServerDatabaseAdapter): Promise<Delta[]> => {
  const page = await server.pull(USER, { cursor: null, excludeNodeId: "node-z", limit: 1000 });
  return page.deltas;
};

// Tests run on Node, but the ES-only lib has no timer types
declare const setTimeout: (callback: () => void, ms: number) => unknown;

// Memory adapters only use microtasks, so after a timer anything that can run has run
const settle = () =>
  new Promise<void>((resolve) => {
    setTimeout(resolve, 0);
  });

describe("syncNow pulling", () => {
  it("throws without a transport", async () => {
    const { client } = await setup({ transport: undefined });

    await expect(client.raw.syncNow()).rejects.toThrow(ConfigError);
  });

  it("does nothing when the server is empty", async () => {
    const { client, storage } = await setup();

    await client.syncNow();
    const savedCursor = await cursor(storage);
    const clock = await storedClock(storage);

    expect(savedCursor).toBe("0");
    expect(clock).toBeUndefined();
  });

  it.each([0, -1, 1.5, Number.NaN])("rejects an invalid pullLimit of %s", async (pullLimit) => {
    await expect(setup({ pullLimit })).rejects.toThrow(ConfigError);
  });

  describe("applying", () => {
    it("creates rows from another device's deltas and records them in history", async () => {
      const { client, storage, remote } = await setup();
      const deltas = [
        set(START - 2, "obj-1", "title", "hello"),
        set(START - 1, "obj-1", "done", false),
      ];
      await remote(...deltas);

      await client.syncNow();
      const created = await row(storage, "obj-1");
      const recorded = await inHistory(storage, deltas);
      const pending = await read(storage, (tx) => tx.outbox.count());

      expect(created).toEqual({ id: "obj-1", title: "hello", done: false });
      expect(recorded.size).toBe(2);
      expect(pending).toBe(0);
    });

    it("applies the newest value when one page holds several deltas for a cell", async () => {
      const { client, storage, remote } = await setup();
      await remote(
        set(START - 1, "obj-1", "title", "newest"),
        set(START - 3, "obj-1", "title", "oldest"),
        set(START - 2, "obj-1", "title", "middle"),
      );

      await client.syncNow();
      const merged = await row(storage, "obj-1");

      expect(merged).toEqual({ id: "obj-1", title: "newest" });
    });

    it("looks up each cell and row once per page", async () => {
      const inner = clientMemoryStorage();
      const cellLookups: string[] = [];
      const objectLookups: string[] = [];
      const recording: StorageAdapter = {
        transaction: (mode, fn) =>
          inner.transaction(mode, (tx) =>
            fn({
              ...tx,
              latest: (cells) => {
                cellLookups.push(...cells.map((cell) => `${cell.objectId}.${cell.column}`));
                return tx.latest(cells);
              },
              deleted: (objects) => {
                objectLookups.push(...objects.map((object) => object.objectId));
                return tx.deleted(objects);
              },
            }),
          ),
      };
      const { client, remote } = await setup({ storage: recording });
      await remote(
        set(START - 4, "obj-1", "title", "old"),
        set(START - 3, "obj-1", "title", "new"),
        set(START - 2, "obj-1", "done", false),
        del(START - 1, "obj-2"),
      );

      await client.syncNow();
      const merged = await row(inner, "obj-1");

      expect(cellLookups.toSorted()).toEqual(["obj-1.done", "obj-1.title"]);
      expect(objectLookups.toSorted()).toEqual(["obj-1", "obj-2"]);
      expect(merged).toEqual({ id: "obj-1", title: "new", done: false });
    });

    it("updates only the columns in the remote deltas", async () => {
      const { client, storage, remote } = await setup();
      const id = await client.insert(TABLE, { title: "local", notes: "keep" }, { id: "obj-1" });
      await remote(set(START + 1, id, "title", "remote"));

      await client.syncNow();
      const updated = await row(storage, id);

      expect(updated).toEqual({ id, title: "remote", notes: "keep" });
    });

    it("removes a row deleted on another device", async () => {
      const { client, storage, remote } = await setup();
      const id = await client.insert(TABLE, { title: "local" }, { id: "obj-1" });
      await remote(del(START + 1, id));

      await client.syncNow();
      const deleted = await row(storage, id);

      expect(deleted).toBeUndefined();
    });

    it("lets a remote delete win over a newer pending local edit", async () => {
      const { client, storage, remote } = await setup();
      const id = await client.insert(TABLE, { title: "local" }, { id: "obj-1" });
      await remote(del(START - 1, id));

      await client.syncNow();
      const deleted = await row(storage, id);

      expect(deleted).toBeUndefined();
    });

    it("keeps a pending local edit over an older remote one", async () => {
      const { client, storage, remote } = await setup();
      const id = await client.insert(TABLE, { title: "local" }, { id: "obj-1" });
      await remote(set(START - 1, id, "title", "older remote"));

      await client.syncNow();
      const kept = await row(storage, id);

      expect(kept).toEqual({ id, title: "local" });
    });

    it("lets a newer remote edit replace a pending local one", async () => {
      const { client, storage, remote } = await setup();
      const id = await client.insert(TABLE, { title: "local" }, { id: "obj-1" });
      await remote(set(START + 1, id, "title", "newer remote"));

      await client.syncNow();
      const replaced = await row(storage, id);

      expect(replaced).toEqual({ id, title: "newer remote" });
    });

    it("does not bring back a row deleted locally but not yet pushed", async () => {
      const { client, storage, remote } = await setup();
      const id = await client.insert(TABLE, { title: "local" }, { id: "obj-1" });
      await client.delete(TABLE, id);
      const late = set(START + 10, id, "title", "remote edit");
      await remote(late);

      await client.syncNow();
      const deleted = await row(storage, id);
      const recorded = await inHistory(storage, [late]);

      expect(deleted).toBeUndefined();
      expect(recorded.size).toBe(1);
    });

    it("ignores remote edits that arrive after a remote delete", async () => {
      const { client, storage, remote } = await setup();
      await remote(set(START - 3, "obj-1", "title", "created"), del(START - 2, "obj-1"));
      await client.syncNow();

      await remote(set(START - 1, "obj-1", "title", "edited after delete"));
      await client.syncNow();
      const deleted = await row(storage, "obj-1");

      expect(deleted).toBeUndefined();
    });

    it("merges a repeated page without overwriting later edits", async () => {
      const first = set(START - 2, "obj-1", "title", "first");
      const { client, storage } = await setup({
        transport: scriptedTransport([
          { deltas: [first], cursor: "1", hasMore: false },
          { deltas: [first], cursor: "2", hasMore: false },
        ]),
      });
      await client.syncNow();
      await client.update(TABLE, "obj-1", { title: "edited locally" });

      await client.syncNow();
      const edited = await row(storage, "obj-1");
      const savedCursor = await cursor(storage);

      expect(edited).toEqual({ id: "obj-1", title: "edited locally" });
      expect(savedCursor).toBe("2");
    });
  });

  describe("cursor", () => {
    it("saves the cursor so the next sync only fetches new deltas", async () => {
      const { client, storage, server, spy, remote } = await setup();
      await remote(set(START - 1, "obj-1", "title", "hello"));

      await client.syncNow();
      const saved = await cursor(storage);
      const page = await server.pull(USER, {
        cursor: saved ?? null,
        excludeNodeId: "node-a",
        limit: 10,
      });

      expect(saved).toBe("1");
      expect(page.deltas).toEqual([]);
      expect(spy.pulls).toBe(1);
    });

    it("keeps pulling pages until the server has no more", async () => {
      const { client, storage, spy, remote } = await setup({ pullLimit: 2 });
      const deltas: Delta[] = [];
      for (let i = 1; i <= 5; i++) {
        deltas.push(set(START - 10 + i, `obj-${i}`, "title", `row ${i}`));
      }
      await remote(...deltas);

      await client.syncNow();
      const savedCursor = await cursor(storage);

      expect(spy.pulls).toBe(3);
      expect(savedCursor).toBe("5");
      for (let i = 1; i <= 5; i++) {
        // oxlint-disable-next-line no-await-in-loop -- checking each row
        const pulled = await row(storage, `obj-${i}`);
        expect(pulled).toEqual({ id: `obj-${i}`, title: `row ${i}` });
      }
    });

    it("sends the saved cursor and its own node id", async () => {
      const requests: Parameters<Transport["pull"]>[0][] = [];
      const transport: Transport = {
        pull: async (request) => {
          requests.push(request);
          return { deltas: [], cursor: "9", hasMore: false };
        },
        push: async () => {},
      };
      const { client } = await setup({ transport, pullLimit: 25 });

      await client.syncNow();
      await client.syncNow();

      expect(requests).toEqual([
        { cursor: null, nodeId: "node-a", limit: 25 },
        { cursor: "9", nodeId: "node-a", limit: 25 },
      ]);
    });

    it("leaves the cursor unchanged when the server returns a null cursor", async () => {
      const { client, storage } = await setup({
        transport: scriptedTransport([{ deltas: [], cursor: null, hasMore: false }]),
      });

      await client.syncNow();
      const savedCursor = await cursor(storage);

      expect(savedCursor).toBeUndefined();
    });

    it.each([
      ["a null cursor", null],
      ["the cursor it sent", "1"],
    ])("rejects hasMore with %s instead of looping, and writes nothing", async (_name, next) => {
      const first = set(START - 1, "obj-1", "title", "hello");
      const stuck = set(START - 2, "obj-2", "title", "stuck");
      const { client, storage } = await setup({
        transport: scriptedTransport([
          { deltas: [first], cursor: "1", hasMore: false },
          { deltas: [stuck], cursor: next, hasMore: true },
        ]),
      });
      await client.syncNow();

      await failed(client.raw.syncNow(), "server-protocol");
      const rejected = await row(storage, "obj-2");
      const recorded = await inHistory(storage, [stuck]);
      const savedCursor = await cursor(storage);

      expect(rejected).toBeUndefined();
      expect(recorded.size).toBe(0);
      expect(savedCursor).toBe("1");
    });

    it("skips a page if another client on the same storage moved the cursor first", async () => {
      const { client, storage, server, spy, remote, options } = await setup();
      await remote(
        set(START - 2, "obj-1", "title", "hello"),
        set(START - 1, "obj-2", "title", "world"),
      );
      const other = await openClient({
        ...options,
        transport: memoryTransport(server, USER),
      });
      spy.beforeReturn = async () => {
        spy.beforeReturn = undefined;
        await other.syncNow();
      };

      await client.syncNow();
      const savedCursor = await cursor(storage);
      const first = await row(storage, "obj-1");
      const second = await row(storage, "obj-2");

      expect(spy.pulls).toBe(2);
      expect(savedCursor).toBe("2");
      expect(first).toEqual({ id: "obj-1", title: "hello" });
      expect(second).toEqual({ id: "obj-2", title: "world" });
    });

    it("never moves the cursor back when another client pulled past this page mid-fetch", async () => {
      const { client, storage, server, spy, remote, options } = await setup({ pullLimit: 1 });
      await remote(
        set(START - 2, "obj-1", "title", "hello"),
        set(START - 1, "obj-2", "title", "world"),
      );
      const other = await openClient({
        ...options,
        transport: memoryTransport(server, USER),
      });
      spy.beforeReturn = async () => {
        spy.beforeReturn = undefined;
        await other.syncNow();
      };

      await client.syncNow();
      const savedCursor = await cursor(storage);
      const first = await row(storage, "obj-1");
      const second = await row(storage, "obj-2");

      // "1" is the next page fetched early, discarded once the save sees the moved cursor
      expect(spy.cursors).toEqual([null, "1", "2"]);
      expect(savedCursor).toBe("2");
      expect(first).toEqual({ id: "obj-1", title: "hello" });
      expect(second).toEqual({ id: "obj-2", title: "world" });
    });
    it("fetches the next page while saving the current one", async () => {
      const inner = clientMemoryStorage();
      const pullsDuringSave: number[] = [];
      let counter: { pulls: number } | undefined;
      const recording: StorageAdapter = {
        transaction: (mode, fn) =>
          inner.transaction(mode, (tx) =>
            fn({
              ...tx,
              latest: (cells) => {
                pullsDuringSave.push(counter?.pulls ?? 0);
                return tx.latest(cells);
              },
            }),
          ),
      };
      const { client, spy, remote } = await setup({ storage: recording, pullLimit: 1 });
      counter = spy;
      await remote(
        set(START - 2, "obj-1", "title", "hello"),
        set(START - 1, "obj-2", "title", "world"),
      );

      await client.syncNow();
      const second = await row(inner, "obj-2");

      expect(pullsDuringSave[0]).toBe(2);
      expect(second).toEqual({ id: "obj-2", title: "world" });
    });
  });

  describe("clock", () => {
    it("moves the clock past remote timestamps so later local writes are newer", async () => {
      const { client, storage, remote } = await setup();
      const ahead = set(START + 60_000, "obj-1", "title", "from the future");
      await remote(ahead);

      await client.syncNow();
      await client.update(TABLE, "obj-1", { title: "local" });
      const [local] = await outbox(storage);
      const updated = await row(storage, "obj-1");

      expect(local && local.timestamp > ahead.timestamp).toBe(true);
      expect(updated).toEqual({ id: "obj-1", title: "local" });
    });

    it("saves the clock after pulling", async () => {
      const { client, storage, remote } = await setup();
      await remote(set(START + 5, "obj-1", "title", "hello"));

      await client.syncNow();
      const clock = await storedClock(storage);
      const saved = HLCTimestamp.parse(clock ?? "");

      expect(saved.physicalTime).toBe(START + 5);
      expect(saved.nodeId).toBe("node-a");
    });

    it("rejects a page with a timestamp too far ahead and changes nothing", async () => {
      const { client, storage, remote } = await setup({ maxDriftMs: 1000 });
      const drifted = set(START + 5000, "obj-1", "title", "too far ahead");
      await remote(drifted);

      await failed(client.raw.syncNow(), "remote-ahead");
      const rejected = await row(storage, "obj-1");
      const recorded = await inHistory(storage, [drifted]);
      const savedCursor = await cursor(storage);
      const clock = await storedClock(storage);

      expect(rejected).toBeUndefined();
      expect(recorded.size).toBe(0);
      expect(savedCursor).toBeUndefined();
      expect(clock).toBeUndefined();
    });

    it("applies the drifted page once local time catches up", async () => {
      const { client, storage, remote, setTime } = await setup({ maxDriftMs: 1000 });
      await remote(set(START + 5000, "obj-1", "title", "too far ahead"));
      await failed(client.raw.syncNow(), "remote-ahead");

      setTime(START + 4500);
      await client.syncNow();
      const applied = await row(storage, "obj-1");

      expect(applied).toEqual({ id: "obj-1", title: "too far ahead" });
    });

    it("keeps pages merged before the failing one", async () => {
      const { client, storage, remote } = await setup({ maxDriftMs: 1000, pullLimit: 1 });
      await remote(
        set(START - 1, "obj-1", "title", "fine"),
        set(START + 5000, "obj-2", "title", "drifted"),
      );

      await failed(client.raw.syncNow(), "remote-ahead");
      const fine = await row(storage, "obj-1");
      const drifted = await row(storage, "obj-2");
      const savedCursor = await cursor(storage);

      expect(fine).toEqual({ id: "obj-1", title: "fine" });
      expect(drifted).toBeUndefined();
      expect(savedCursor).toBe("1");
    });
  });

  describe("failures", () => {
    it("reports transport errors and changes nothing", async () => {
      const storage = clientMemoryStorage();
      const transport = memoryTransport(serverMemoryDatabase(), USER);
      transport.online = false;
      const client = await openClient({ storage, transport, generateNodeId: () => "node-a" });

      await failedBecause(client.raw.syncNow(), "transport", "memoryTransport is offline");
      const savedCursor = await cursor(storage);

      expect(savedCursor).toBeUndefined();
    });

    it("keeps pages merged before a transport error", async () => {
      const fine = set(START - 1, "obj-1", "title", "fine");
      const { client, storage } = await setup({
        // the second pull throws, as the script has run out
        transport: scriptedTransport([{ deltas: [fine], cursor: "1", hasMore: true }]),
      });

      await failedBecause(client.raw.syncNow(), "transport", "No more scripted pages");
      const kept = await row(storage, "obj-1");
      const savedCursor = await cursor(storage);

      expect(kept).toEqual({ id: "obj-1", title: "fine" });
      expect(savedCursor).toBe("1");
    });

    it("throws the save error when the next page's fetch fails too", async () => {
      const drifted = set(START + 5000, "obj-1", "title", "drifted");
      const { client, storage } = await setup({
        maxDriftMs: 1000,
        // the early second pull throws, as the script has run out
        transport: scriptedTransport([{ deltas: [drifted], cursor: "1", hasMore: true }]),
      });

      await failed(client.raw.syncNow(), "remote-ahead");
      const savedCursor = await cursor(storage);

      expect(savedCursor).toBeUndefined();
    });

    it("rejects a page containing an invalid timestamp and changes nothing", async () => {
      const valid = set(START - 1, "obj-1", "title", "fine");
      const invalid: Delta = { ...set(START - 1, "obj-2", "title", "bad"), timestamp: "garbage" };
      const { client, storage } = await setup({
        transport: scriptedTransport([{ deltas: [valid, invalid], cursor: "2", hasMore: false }]),
      });

      await failed(client.raw.syncNow(), "server-protocol");
      const validRow = await row(storage, "obj-1");
      const savedCursor = await cursor(storage);

      expect(validRow).toBeUndefined();
      expect(savedCursor).toBeUndefined();
    });
  });
});

describe("syncNow pushing", () => {
  it.each([0, -1, 1.5, Number.NaN])(
    "rejects an invalid pushBatchSize of %s",
    async (pushBatchSize) => {
      await expect(setup({ pushBatchSize })).rejects.toThrow(ConfigError);
    },
  );

  it("sends the outbox to the server and moves it to history", async () => {
    const { client, storage, server, spy } = await setup();
    await client.insert(TABLE, { title: "hello", done: false }, { id: "obj-1" });
    const pending = await outbox(storage);

    await client.syncNow();
    const remaining = await outbox(storage);
    const recorded = await inHistory(storage, pending);
    const onServer = await serverDeltas(server);

    expect(pending).toHaveLength(2);
    expect(remaining).toEqual([]);
    expect(recorded.size).toBe(2);
    expect(onServer).toEqual(pending);
    expect(spy.pushes.map((push) => push.nodeId)).toEqual(["node-a"]);
  });

  it("pushes deletes", async () => {
    const { client, server } = await setup();
    await client.insert(TABLE, { title: "hello" }, { id: "obj-1" });
    await client.syncNow();
    await client.delete(TABLE, "obj-1");

    await client.syncNow();
    const onServer = await serverDeltas(server);
    const deletes = onServer.filter((delta) => delta.kind === "delete");

    expect(deletes).toMatchObject([{ kind: "delete", table: TABLE, objectId: "obj-1" }]);
  });

  it("does not push when the outbox is empty", async () => {
    const { client, spy } = await setup();

    await client.syncNow();

    expect(spy.pushes).toEqual([]);
  });

  it("delivers a row to another device", async () => {
    const { client, server, options } = await setup();
    const otherStorage = clientMemoryStorage();
    const other = await openClient({
      ...options,
      storage: otherStorage,
      generateNodeId: () => "node-b",
      transport: memoryTransport(server, USER),
    });
    await client.insert(TABLE, { title: "hello" }, { id: "obj-1" });

    await client.syncNow();
    await other.syncNow();
    const delivered = await row(otherStorage, "obj-1");

    expect(delivered).toEqual({ id: "obj-1", title: "hello" });
  });

  it("pushes in batches, oldest first", async () => {
    const { client, storage, spy } = await setup({ pushBatchSize: 2 });
    await client.insert(TABLE, { a: 1, b: 2, c: 3, d: 4, e: 5 }, { id: "obj-1" });
    const pending = await outbox(storage);

    await client.syncNow();
    const sizes = spy.pushes.map((push) => push.deltas.length);
    const sent = spy.pushes.flatMap((push) => timestamps(push.deltas));

    expect(sizes).toEqual([2, 2, 1]);
    expect(sent).toEqual(timestamps(pending).toSorted(compareTimestamps));
  });

  it("keeps pushed deltas counting for last-writer-wins", async () => {
    const { client, storage, remote } = await setup();
    await client.insert(TABLE, { title: "local" }, { id: "obj-1" });
    await client.syncNow();
    await remote(set(START - 1, "obj-1", "title", "older remote"));

    await client.syncNow();
    const kept = await row(storage, "obj-1");

    expect(kept).toEqual({ id: "obj-1", title: "local" });
  });

  it("leaves the outbox unchanged when the push fails, and sends it on the next sync", async () => {
    const { client, storage, server, spy } = await setup();
    await client.insert(TABLE, { title: "hello" }, { id: "obj-1" });
    const pending = await outbox(storage);
    spy.beforePush = async () => {
      throw new Error("offline");
    };

    await failedBecause(client.raw.syncNow(), "transport", "offline");
    const afterFailure = await outbox(storage);
    const serverAfterFailure = await serverDeltas(server);

    spy.beforePush = undefined;
    await client.syncNow();
    const afterRetry = await outbox(storage);
    const serverAfterRetry = await serverDeltas(server);

    expect(afterFailure).toEqual(pending);
    expect(serverAfterFailure).toEqual([]);
    expect(afterRetry).toEqual([]);
    expect(serverAfterRetry).toEqual(pending);
  });

  it("pushes again after a lost reply without duplicating on the server", async () => {
    const { client, storage, server, spy } = await setup();
    await client.insert(TABLE, { title: "hello" }, { id: "obj-1" });
    const pending = await outbox(storage);
    spy.afterPush = async () => {
      spy.afterPush = undefined;
      throw new Error("connection lost");
    };

    await failedBecause(client.raw.syncNow(), "transport", "connection lost");
    const afterLostReply = await outbox(storage);

    await client.syncNow();
    const afterRetry = await outbox(storage);
    const onServer = await serverDeltas(server);

    expect(afterLostReply).toEqual(pending);
    expect(afterRetry).toEqual([]);
    expect(spy.pushes).toHaveLength(2);
    expect(onServer).toEqual(pending);
  });

  it("sends writes made during a push in the same sync", async () => {
    const { client, storage, server, spy } = await setup();
    await client.insert(TABLE, { title: "before" }, { id: "obj-1" });
    spy.beforePush = async () => {
      spy.beforePush = undefined;
      await client.insert(TABLE, { title: "during" }, { id: "obj-2" });
    };

    await client.syncNow();
    const remaining = await outbox(storage);
    const onServer = await serverDeltas(server);
    const objects = onServer.map((delta) => delta.objectId);

    expect(remaining).toEqual([]);
    expect(spy.pushes).toHaveLength(2);
    expect(objects).toEqual(["obj-1", "obj-2"]);
  });

  it("does not push if the pull fails", async () => {
    const { client, storage, spy, remote } = await setup({ maxDriftMs: 1000 });
    await client.insert(TABLE, { title: "local" }, { id: "obj-1" });
    await remote(set(START + 5000, "obj-2", "title", "drifted"));

    await failed(client.raw.syncNow(), "remote-ahead");
    const pending = await outbox(storage);

    expect(spy.pushes).toEqual([]);
    expect(pending).toHaveLength(1);
  });

  it("reports a device clock ahead of the server", async () => {
    const { client, storage, setTime } = await setup({}, { now: () => START, maxDriftMs: 1000 });
    setTime(START + 3000);
    await client.insert(TABLE, { title: "hello" }, { id: "obj-1" });
    const pending = await outbox(storage);

    const error = await failed(client.raw.syncNow(), "clock-ahead");
    const remaining = await outbox(storage);

    expect(error).toBeInstanceOf(LocalClockAheadError);
    expect(error).toMatchObject({ skewMs: 3000, cause: expect.any(ClockDriftError) });
    expect(remaining).toEqual(pending);
  });

  it("reports a transport whose pull throws synchronously", async () => {
    const transport: Transport = {
      pull: () => {
        throw new Error("sync pull failure");
      },
      push: async () => {},
    };
    const client = await openClient({
      storage: clientMemoryStorage(),
      transport,
      generateNodeId: () => "node-a",
    });

    const error = await failedBecause(client.raw.syncNow(), "transport", "sync pull failure");

    expect(error).toBeInstanceOf(TransportError);
  });

  it("reports a transport whose push throws synchronously", async () => {
    const transport: Transport = {
      pull: async () => ({ deltas: [], cursor: null, hasMore: false }),
      push: () => {
        throw new Error("sync push failure");
      },
    };
    const client = await openClient({
      storage: clientMemoryStorage(),
      transport,
      generateNodeId: () => "node-a",
    });
    await client.insert(TABLE, { title: "hello" }, { id: "obj-1" });

    const error = await failedBecause(client.raw.syncNow(), "transport", "sync push failure");

    expect(error).toBeInstanceOf(TransportError);
  });

  it("reports a clock drift thrown synchronously by push as a local clock ahead", async () => {
    const drift = new ClockDriftError(new HLCTimestamp(START + 3000, 0, "node-a"), START);
    const transport: Transport = {
      pull: async () => ({ deltas: [], cursor: null, hasMore: false }),
      push: () => {
        throw drift;
      },
    };
    const client = await openClient({
      storage: clientMemoryStorage(),
      transport,
      generateNodeId: () => "node-a",
    });
    await client.insert(TABLE, { title: "hello" }, { id: "obj-1" });

    const error = await failed(client.raw.syncNow(), "clock-ahead");

    expect(error).toMatchObject({ skewMs: 3000, cause: drift });
  });

  it("narrows sync errors by code", () => {
    expectTypeOf((error: SyncNowError) =>
      error.code === "clock-ahead" ? error.skewMs : null,
    ).returns.toEqualTypeOf<number | null>();
  });
});

describe("syncNow while syncing", () => {
  it("waits for the running sync to finish before starting another", async () => {
    const { client, spy } = await setup();
    const calls: Promise<void>[] = [];
    let pullsDuringFirst = 0;
    spy.beforeReturn = async () => {
      spy.beforeReturn = undefined;
      calls.push(client.syncNow());
      await settle();
      pullsDuringFirst = spy.pulls;
    };

    await client.syncNow();
    await Promise.all(calls);

    expect(pullsDuringFirst).toBe(1);
    expect(spy.pulls).toBe(2);
  });

  it("runs one follow-up sync for every call made during a sync", async () => {
    const { client, spy } = await setup();
    const calls: Promise<void>[] = [];
    spy.beforeReturn = async () => {
      spy.beforeReturn = undefined;
      calls.push(client.syncNow(), client.syncNow(), client.syncNow());
    };

    await client.syncNow();
    await Promise.all(calls);

    expect(spy.pulls).toBe(2);
  });

  it("pulls changes that reached the server mid-sync before a later call resolves", async () => {
    const { client, storage, spy, remote } = await setup();
    await client.insert(TABLE, { title: "local" }, { id: "obj-1" });
    const calls: Promise<void>[] = [];
    // The first sync has finished pulling by the time it pushes
    spy.afterPush = async () => {
      spy.afterPush = undefined;
      await remote(set(START - 1, "obj-2", "title", "remote"));
      calls.push(client.syncNow());
    };

    await client.syncNow();
    await Promise.all(calls);
    const pulled = await row(storage, "obj-2");

    expect(pulled).toEqual({ id: "obj-2", title: "remote" });
  });

  it("runs a call made during a failed sync, and reports each result separately", async () => {
    const { client, spy } = await setup();
    const calls: ReturnType<typeof client.raw.syncNow>[] = [];
    spy.beforeReturn = async () => {
      spy.beforeReturn = undefined;
      calls.push(client.raw.syncNow());
      throw new Error("offline");
    };

    await failedBecause(client.raw.syncNow(), "transport", "offline");
    const [followUp] = await Promise.all(calls);

    expect(followUp?.error).toBeNull();
    expect(spy.pulls).toBe(2);
  });

  it("starts a new sync for a call made after the follow-up finished", async () => {
    const { client, spy } = await setup();
    const calls: Promise<void>[] = [];
    spy.beforeReturn = async () => {
      spy.beforeReturn = undefined;
      calls.push(client.syncNow());
    };

    await client.syncNow();
    await Promise.all(calls);
    await client.syncNow();

    expect(spy.pulls).toBe(3);
  });
});
