import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  ClockDriftError,
  HLCTimestamp,
  type Delta,
  type PullResult,
  type ServerDatabaseAdapter,
} from "@sync-engine/core";

export type ServerDatabaseConformanceOptions = {
  /** Return a fresh, empty adapter. Called before every test. */
  create: () => ServerDatabaseAdapter | Promise<ServerDatabaseAdapter>;
  /** Optional cleanup after each test. */
  destroy?: (adapter: ServerDatabaseAdapter) => void | Promise<void>;
  /** The max clock drift the adapter was created with. Default 5 minutes. */
  maxDriftMs?: number;
  /** Cursors the adapter must reject, since cursor formats are adapter-specific. Default ["not-a-cursor"]. */
  invalidCursors?: readonly string[];
};

const ts = (physical: number, node = "node-a"): string =>
  new HLCTimestamp(physical, 0, node).toString();

const delta = (physical: number, node = "node-a", value: unknown = physical): Delta => ({
  kind: "set",
  timestamp: ts(physical, node),
  table: "items",
  objectId: "obj-1",
  column: "title",
  value,
});

const timestamps = (deltas: Delta[]) => deltas.map((d) => d.timestamp);

/**
 * Runs the black-box `ServerDatabaseAdapter` contract tests against adapters built by
 * `options.create`. Cursors are treated as opaque: tests only feed back cursors the adapter
 * returned, and never assert their values.
 */
export const runServerDatabaseConformance = (
  name: string,
  options: ServerDatabaseConformanceOptions,
): void => {
  const maxDriftMs = options.maxDriftMs ?? 5 * 60_000;
  const invalidCursors = options.invalidCursors ?? ["not-a-cursor"];

  describe(`ServerDatabaseAdapter conformance: ${name}`, () => {
    let adapter: ServerDatabaseAdapter | undefined;

    const live = (): ServerDatabaseAdapter => {
      if (!adapter) throw new Error("adapter not created");
      return adapter;
    };

    beforeEach(async () => {
      adapter = undefined;
      adapter = await options.create();
    });

    afterEach(async () => {
      if (adapter) await options.destroy?.(adapter);
      adapter = undefined;
    });

    const push = (deltas: Delta[], userId = "user-1") => live().push(userId, deltas);

    const pull = (
      cursor: string | null = null,
      { userId = "user-1", excludeNodeId = "node-z", limit = 100 } = {},
    ): Promise<PullResult> => live().pull(userId, { cursor, excludeNodeId, limit });

    /** Follows the cursor until `hasMore` is false, checking the paging invariants on every page. */
    const pullAll = async (
      cursor: string | null = null,
      { userId = "user-1", excludeNodeId = "node-z", limit = 2 } = {},
    ) => {
      const seen: Delta[] = [];
      let pages = 0;
      let page: PullResult;
      do {
        // oxlint-disable-next-line no-await-in-loop -- each page depends on the previous cursor
        page = await pull(cursor, { userId, excludeNodeId, limit });
        expect(page.deltas.length).toBeLessThanOrEqual(limit);
        // hasMore promises something to deliver, so a client following it never spins on empty pages
        if (page.hasMore) expect(page.deltas.length).toBeGreaterThan(0);
        seen.push(...page.deltas);
        cursor = page.cursor;
        pages++;
      } while (page.hasMore);
      return { deltas: seen, cursor, pages };
    };

    describe("push", () => {
      it("stores deltas in arrival order, not timestamp order", async () => {
        const batch = [delta(3), delta(1), delta(2)];

        await push(batch);

        expect(timestamps((await pull()).deltas)).toEqual(timestamps(batch));
      });

      it("round-trips set and delete deltas exactly", async () => {
        const deltas: Delta[] = [
          delta(1, "node-a", null),
          delta(2, "node-a", false),
          delta(3, "node-a", 0),
          delta(4, "node-a", ""),
          delta(5, "node-a", { nested: { list: [1, "two", null, { deep: true }] } }),
          delta(6, "node-a", []),
          delta(7, "node-a", 'unicode ✓ \u0000 "quoted"'),
          { kind: "delete", timestamp: ts(8), table: "other", objectId: "obj-2" },
        ];

        await push(deltas);

        expect((await pull()).deltas).toEqual(deltas);
      });

      it("accepts an empty batch", async () => {
        await push([]);

        expect((await pull()).deltas).toEqual([]);
      });

      it("ignores deltas it already has", async () => {
        await push([delta(1), delta(2)]);
        await push([delta(2), delta(3)]);

        expect(timestamps((await pull()).deltas)).toEqual(
          timestamps([delta(1), delta(2), delta(3)]),
        );
      });

      it("ignores duplicates within one batch", async () => {
        await push([delta(1), delta(1)]);

        expect((await pull()).deltas).toHaveLength(1);
      });

      it("stores a retried push once even when both attempts run concurrently", async () => {
        await Promise.all([push([delta(1), delta(2)]), push([delta(1), delta(2)])]);

        expect(timestamps((await pull()).deltas)).toEqual(timestamps([delta(1), delta(2)]));
      });

      it("does not redeliver an already pulled delta when its push is retried", async () => {
        await push([delta(1)]);
        const first = await pull();

        await push([delta(1), delta(2)]);

        expect(timestamps((await pull(first.cursor)).deltas)).toEqual(timestamps([delta(2)]));
      });

      it("rejects the whole batch if one timestamp is invalid", async () => {
        const bad = { ...delta(2), timestamp: "not-a-timestamp" };

        await expect(push([delta(1), bad])).rejects.toThrow("Invalid HLC timestamp");

        expect((await pull()).deltas).toEqual([]);
      });

      it("rejects the whole batch if one timestamp is too far ahead of the server clock", async () => {
        const future = Date.now() + maxDriftMs + 60_000;

        await expect(push([delta(1), delta(future)])).rejects.toBeInstanceOf(ClockDriftError);

        expect((await pull()).deltas).toEqual([]);
      });

      it("accepts a timestamp at the server's current time", async () => {
        const current = delta(Date.now());

        await push([current]);

        expect(timestamps((await pull()).deltas)).toEqual(timestamps([current]));
      });

      it("stores a copy of each delta", async () => {
        const original = delta(1, "node-a", { nested: "before" });

        await push([original]);
        if (original.kind === "set") original.value = { nested: "after" };

        expect((await pull()).deltas[0]).toMatchObject({ value: { nested: "before" } });
      });
    });

    describe("pull", () => {
      it("returns an empty page for a user with no deltas", async () => {
        const page = await pull(null, { userId: "nobody" });

        expect(page).toMatchObject({ deltas: [], hasMore: false });
      });

      it("returns at most limit deltas, then the rest from the cursor", async () => {
        const all = [delta(1), delta(2), delta(3), delta(4), delta(5)];
        await push(all);

        const first = await pull(null, { limit: 2 });
        const second = await pull(first.cursor, { limit: 2 });
        const third = await pull(second.cursor, { limit: 2 });

        expect(timestamps(first.deltas)).toEqual(timestamps(all.slice(0, 2)));
        expect(first.hasMore).toBe(true);
        expect(timestamps(second.deltas)).toEqual(timestamps(all.slice(2, 4)));
        expect(second.hasMore).toBe(true);
        expect(timestamps(third.deltas)).toEqual(timestamps(all.slice(4)));
        expect(third.hasMore).toBe(false);
      });

      it("returns only deltas pushed after the cursor", async () => {
        await push([delta(1)]);
        const first = await pull();

        await push([delta(2)]);
        const second = await pull(first.cursor);
        const third = await pull(second.cursor);

        expect(timestamps(second.deltas)).toEqual(timestamps([delta(2)]));
        expect(third).toMatchObject({ deltas: [], hasMore: false });
      });

      it("a cursor from an empty pull still sees deltas pushed afterwards", async () => {
        const empty = await pull();

        await push([delta(1)]);

        expect(timestamps((await pull(empty.cursor)).deltas)).toEqual(timestamps([delta(1)]));
      });

      it("excludes the caller's own deltas", async () => {
        await push([delta(1, "node-a"), delta(2, "node-b"), delta(3, "node-a")]);

        const page = await pull(null, { excludeNodeId: "node-a" });

        expect(timestamps(page.deltas)).toEqual(timestamps([delta(2, "node-b")]));
      });

      it("advances the cursor past pages made up only of the caller's own deltas", async () => {
        await push([delta(1, "node-a"), delta(2, "node-a"), delta(3, "node-a")]);

        const page = await pull(null, { excludeNodeId: "node-a", limit: 2 });
        await push([delta(4, "node-b")]);
        const next = await pull(page.cursor, { excludeNodeId: "node-a", limit: 2 });

        expect(page).toMatchObject({ deltas: [], hasMore: false });
        expect(timestamps(next.deltas)).toEqual(timestamps([delta(4, "node-b")]));
      });

      it("returns every other node's delta exactly once, in order, for any limit", async () => {
        const all: Delta[] = [];
        for (let i = 1; i <= 7; i++) {
          all.push(delta(i, i % 3 === 0 ? "node-a" : "node-b"));
        }
        await push(all);
        const expected = timestamps(all.filter((_, i) => (i + 1) % 3 !== 0));

        for (const limit of [1, 2, 3, 10]) {
          // oxlint-disable-next-line no-await-in-loop -- one full pull per limit
          const result = await pullAll(null, { excludeNodeId: "node-a", limit });
          expect(timestamps(result.deltas)).toEqual(expected);
        }
      });

      it("pages correctly when other users' pushes are interleaved", async () => {
        await push([delta(1)]);
        await push([delta(2), delta(3)], "user-2");
        await push([delta(4)]);
        await push([delta(5)], "user-2");
        await push([delta(6)]);

        const result = await pullAll(null, { limit: 1 });

        expect(timestamps(result.deltas)).toEqual(timestamps([delta(1), delta(4), delta(6)]));
      });

      it("never skips a delta while pushes and pulls run concurrently", async () => {
        const all = Array.from({ length: 20 }, (_, i) => delta(i + 1, `node-${i % 4}`));
        const seen: Delta[] = [];
        let cursor: string | null = null;
        const drain = async () => {
          const result = await pullAll(cursor, { limit: 3 });
          seen.push(...result.deltas);
          cursor = result.cursor;
        };

        let writing = true;
        const writers = Promise.all(all.map((d) => push([d]))).finally(() => {
          writing = false;
        });
        // Keep draining while the writers run. waitFor polls on a timer, so writers that wait on
        // timers or I/O get to run between drains.
        await vi.waitFor(
          async () => {
            await drain();
            if (writing) throw new Error("writers still running");
          },
          { timeout: 10_000, interval: 1 },
        );
        await writers;
        await drain();

        expect(new Set(timestamps(seen))).toEqual(new Set(timestamps(all)));
        expect(seen).toHaveLength(all.length);
      });

      it("returns copies that cannot change stored deltas", async () => {
        await push([delta(1, "node-a", { nested: "before" })]);

        const pulled = (await pull()).deltas[0];
        if (pulled?.kind === "set") pulled.value = { nested: "after" };

        expect((await pull()).deltas[0]).toMatchObject({ value: { nested: "before" } });
      });

      it("rejects an invalid cursor", async () => {
        await push([delta(1)]);

        for (const cursor of invalidCursors) {
          // oxlint-disable-next-line no-await-in-loop -- one rejection per cursor
          await expect(pull(cursor), cursor).rejects.toBeInstanceOf(RangeError);
        }
      });

      it("rejects an invalid limit", async () => {
        for (const limit of [0, -1, 1.5, Number.NaN]) {
          // oxlint-disable-next-line no-await-in-loop -- one rejection per limit
          await expect(pull(null, { limit }), String(limit)).rejects.toBeInstanceOf(RangeError);
        }
      });
    });

    describe("users", () => {
      it("keeps each user's log separate", async () => {
        await push([delta(1)]);
        await push([delta(2)], "user-2");

        expect(timestamps((await pull()).deltas)).toEqual(timestamps([delta(1)]));
        expect(timestamps((await pull(null, { userId: "user-2" })).deltas)).toEqual(
          timestamps([delta(2)]),
        );
      });

      it("lets two users store the same timestamp", async () => {
        await push([delta(1)]);
        await push([delta(1)], "user-2");

        expect((await pull(null, { userId: "user-2" })).deltas).toHaveLength(1);
      });

      it("deleteUser removes only that user's deltas", async () => {
        await push([delta(1)]);
        await push([delta(2)], "user-2");

        await live().deleteUser("user-1");

        expect((await pull()).deltas).toEqual([]);
        expect((await pull(null, { userId: "user-2" })).deltas).toHaveLength(1);
      });

      it("accepts a previously stored timestamp again after deleteUser", async () => {
        await push([delta(1)]);

        await live().deleteUser("user-1");
        await push([delta(1)]);

        expect((await pull()).deltas).toHaveLength(1);
      });

      it("a cursor saved before deleteUser still sees deltas pushed afterwards", async () => {
        await push([delta(1), delta(2), delta(3)]);
        const before = await pull();

        await live().deleteUser("user-1");
        await push([delta(4)]);

        expect(timestamps((await pull(before.cursor)).deltas)).toEqual(timestamps([delta(4)]));
      });

      it("deleteUser on an unknown user does nothing", async () => {
        await expect(live().deleteUser("nobody")).resolves.toBeUndefined();
      });
    });
  });
};
