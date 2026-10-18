import { describe, expect, it } from "vitest";
import { clientMemoryStorage } from "#adapters/client-memory";
import { serverMemoryDatabase } from "#adapters/server-memory";
import { memoryTransport } from "#adapters/transport-memory";
import { createSyncClient, type SyncClientOptions } from "#core/client/client";
import type { Delta } from "#core/delta";
import { ClockDriftError } from "#core/hlc/clock";
import { HLCTimestamp } from "#core/hlc/timestamp";
import { ServerProtocolError, type PullResult } from "#core/server/server";
import type { Transport } from "#core/server/transport";
import type { StorageAdapter, StorageTx } from "#core/storage";

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

// Counts pull calls and can run a hook after the server answers but before the client sees it.
const spyTransport = (inner: Transport) => {
  const spy = {
    pulls: 0,
    cursors: [] as (string | null)[],
    beforeReturn: undefined as (() => Promise<void>) | undefined,
    transport: {
      pull: async (request) => {
        spy.pulls++;
        spy.cursors.push(request.cursor);
        const result = await inner.pull(request);
        await spy.beforeReturn?.();
        return result;
      },
      push: (request) => inner.push(request),
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
const setup = async (overrides: Partial<SyncClientOptions> = {}) => {
  const storage = clientMemoryStorage();
  const server = serverMemoryDatabase();
  const spy = spyTransport(memoryTransport(server, USER));
  let time = START;
  const options: SyncClientOptions = {
    storage,
    generateNodeId: () => "node-a",
    now: () => time,
    transport: spy.transport,
    ...overrides,
  };
  const client = await createSyncClient(options);

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
  read(storage, (tx) => tx.history.has(deltas.map((delta) => delta.timestamp)));

describe("syncNow pulling", () => {
  it("throws without a transport", async () => {
    const { client } = await setup({ transport: undefined });

    await expect(client.syncNow()).rejects.toThrow("Cannot sync without a transport");
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
    await expect(setup({ pullLimit })).rejects.toThrow(RangeError);
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

      await expect(client.syncNow()).rejects.toBeInstanceOf(ServerProtocolError);
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
      const other = await createSyncClient({
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
      const other = await createSyncClient({
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

      expect(spy.cursors).toEqual([null, "2"]);
      expect(savedCursor).toBe("2");
      expect(first).toEqual({ id: "obj-1", title: "hello" });
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
      const [local] = await read(storage, (tx) => tx.outbox.list());
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

      await expect(client.syncNow()).rejects.toBeInstanceOf(ClockDriftError);
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
      await expect(client.syncNow()).rejects.toBeInstanceOf(ClockDriftError);

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

      await expect(client.syncNow()).rejects.toBeInstanceOf(ClockDriftError);
      const fine = await row(storage, "obj-1");
      const drifted = await row(storage, "obj-2");
      const savedCursor = await cursor(storage);

      expect(fine).toEqual({ id: "obj-1", title: "fine" });
      expect(drifted).toBeUndefined();
      expect(savedCursor).toBe("1");
    });
  });

  describe("failures", () => {
    it("passes transport errors through and changes nothing", async () => {
      const storage = clientMemoryStorage();
      const transport = memoryTransport(serverMemoryDatabase(), USER);
      transport.online = false;
      const client = await createSyncClient({ storage, transport, generateNodeId: () => "node-a" });

      await expect(client.syncNow()).rejects.toThrow("memoryTransport is offline");
      const savedCursor = await cursor(storage);

      expect(savedCursor).toBeUndefined();
    });

    it("keeps pages merged before a transport error", async () => {
      const fine = set(START - 1, "obj-1", "title", "fine");
      const { client, storage } = await setup({
        // the second pull throws, as the script has run out
        transport: scriptedTransport([{ deltas: [fine], cursor: "1", hasMore: true }]),
      });

      await expect(client.syncNow()).rejects.toThrow("No more scripted pages");
      const kept = await row(storage, "obj-1");
      const savedCursor = await cursor(storage);

      expect(kept).toEqual({ id: "obj-1", title: "fine" });
      expect(savedCursor).toBe("1");
    });

    it("rejects a page containing an invalid timestamp and changes nothing", async () => {
      const valid = set(START - 1, "obj-1", "title", "fine");
      const invalid: Delta = { ...set(START - 1, "obj-2", "title", "bad"), timestamp: "garbage" };
      const { client, storage } = await setup({
        transport: scriptedTransport([{ deltas: [valid, invalid], cursor: "2", hasMore: false }]),
      });

      await expect(client.syncNow()).rejects.toThrow("Invalid HLC timestamp");
      const validRow = await row(storage, "obj-1");
      const savedCursor = await cursor(storage);

      expect(validRow).toBeUndefined();
      expect(savedCursor).toBeUndefined();
    });
  });
});
