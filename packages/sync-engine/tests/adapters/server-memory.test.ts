// The ServerDatabaseAdapter contract is covered by runServerDatabaseConformance in packages/testing.
// These tests pin what is specific to the memory adapter: cursor values and the injectable clock.
import { describe, expect, it } from "vitest";
import { serverMemoryDatabase } from "#adapters/server-memory";
import { ClockDriftError } from "#core/hlc/clock";
import { delta, timestamps } from "../helpers";

const pull = (
  db: ReturnType<typeof serverMemoryDatabase>,
  cursor: string | null = null,
  { userId = "user-1", excludeNodeId = "node-b", limit = 10 } = {},
) => db.pull(userId, { cursor, excludeNodeId, limit });

describe("serverMemoryDatabase", () => {
  it("rejects an invalid maxDriftMs", () => {
    for (const maxDriftMs of [-1, Number.NaN]) {
      expect(() => serverMemoryDatabase({ maxDriftMs })).toThrow("Invalid server maxDriftMs");
    }
  });

  it("rejects a timestamp just past the drift limit", async () => {
    const db = serverMemoryDatabase({ now: () => 1_000, maxDriftMs: 100 });

    await expect(db.push("user-1", [delta(1_101)])).rejects.toBeInstanceOf(ClockDriftError);
  });

  it("accepts a timestamp exactly at the drift limit", async () => {
    const db = serverMemoryDatabase({ now: () => 1_000, maxDriftMs: 100 });

    await db.push("user-1", [delta(1_100)]);

    const page = await pull(db);

    expect(timestamps(page.deltas)).toEqual(timestamps([delta(1_100)]));
  });

  it("keeps the first delta when a timestamp is pushed again with different content", async () => {
    const db = serverMemoryDatabase();

    await db.push("user-1", [delta(1)]);
    await db.push("user-1", [delta(1, "node-a", "changed")]);

    const page = await pull(db);

    expect(page.deltas).toEqual([delta(1)]);
  });

  describe("cursors", () => {
    it("is '0' before anything is stored", async () => {
      const db = serverMemoryDatabase();
      await db.push("user-1", []);

      const page = await pull(db);
      const unknownUserPage = await pull(db, null, { userId: "nobody" });

      expect(page).toEqual({ deltas: [], cursor: "0", hasMore: false });
      expect(unknownUserPage).toEqual({
        deltas: [],
        cursor: "0",
        hasMore: false,
      });
    });

    it("is the sequence of the last entry scanned, including skipped own deltas", async () => {
      const db = serverMemoryDatabase();
      await db.push("user-1", [delta(1, "node-a"), delta(2, "node-a"), delta(3, "node-a")]);

      const page = await pull(db, null, { excludeNodeId: "node-a", limit: 2 });

      expect(page).toEqual({
        deltas: [],
        cursor: "3",
        hasMore: false,
      });
    });

    it("shares one sequence across users, like a Postgres bigserial", async () => {
      const db = serverMemoryDatabase();
      await db.push("user-1", [delta(1)]);
      await db.push("user-2", [delta(2), delta(3)]);
      await db.push("user-1", [delta(4)]);

      const first = await pull(db, null, { limit: 1 });
      const second = await pull(db, first.cursor, { limit: 1 });

      expect(first).toMatchObject({ cursor: "1", hasMore: true });
      expect(second).toMatchObject({ cursor: "4", hasMore: false });
    });

    it("returns a cursor past the newest delta unchanged", async () => {
      const db = serverMemoryDatabase();
      await db.push("user-1", [delta(1)]);

      const page = await pull(db, "50");

      expect(page).toEqual({ deltas: [], cursor: "50", hasMore: false });
    });
  });
});
